import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AniError, isTextOnlyVideoModel, videoModelSpec } from '@anirecast/shared';
import { all, fromJson } from '../db.ts';
import type { Workspace } from '../workspace.ts';
import { getCastMember, type ShotCastEntry, shotCast } from './cast.ts';
import { getCastAnalysis } from './cast-analysis.ts';
import { findActiveClip } from './clips.ts';
import { approvedDesign, type Binding, type DesignKind, designNote, getDesign } from './designs.ts';
import { approvedBoard, getBoard, getTake, type InputRef } from './generation.ts';
import { type Bbox, overlaysToRemove, type TextOverlay } from './overlays.ts';
import { getPersona, type Persona, type PersonaImage } from './personas.ts';
import type { GenerationTier } from './projects.ts';
import { getProject } from './projects.ts';
import { getShot, type Keyframe, listKeyframes, listShots, projectOfShot, type Shot } from './shots.ts';
import { placeTracklet, replacementSignature } from './signature.ts';

/** Nano Banana 2.1 accepts at most five character reference images per request. */
export const MAX_CHARACTER_REFS = 5;

export const sha256File = (abs: string): string =>
  createHash('sha256').update(readFileSync(abs)).digest('hex');

const pct = (v: number) => `${Math.round(v * 100)}%`;
export const describeRegion = (b: Bbox): string =>
  `the region from ${pct(b[0])},${pct(b[1])} to ${pct(b[2])},${pct(b[3])} of the frame (left,top to right,bottom)`;

interface PersonaUse {
  persona: Persona;
  entries: ShotCastEntry[];
  imagePaths: string[];
}

/** Head box is inside `outer` (the same head detected twice, at two sizes). */
const nested = (inner: number[], outer: number[]): boolean => {
  const cx = (inner[0]! + inner[2]!) / 2;
  const cy = (inner[1]! + inner[3]!) / 2;
  return cx >= outer[0]! && cx <= outer[2]! && cy >= outer[1]! && cy <= outer[3]!;
};

interface Det {
  entry: ShotCastEntry;
  frame: number;
  box: number[] | null;
}

const area = (b: number[] | null): number => (b ? (b[2]! - b[0]!) * (b[3]! - b[1]!) : 0);

function detectionsOf(ws: Workspace, entries: ShotCastEntry[]): Det[] {
  return entries.flatMap((e) =>
    all<{ frame: number; head_bbox_json: string | null }>(
      ws.db,
      'SELECT frame, head_bbox_json FROM detections WHERE tracklet_id = :id',
      { id: e.tracklet.id },
    ).map((d) => ({ entry: e, frame: d.frame, box: fromJson<number[] | null>(d.head_bbox_json, null) })),
  );
}

const sameCharacter = (a: ShotCastEntry, b: ShotCastEntry): boolean =>
  a === b || (a.cast !== null && a.cast.id === b.cast?.id);

/** Distinct heads in one frame: a head detected twice at two sizes (inside each other) counts once. */
function distinctHeads(dets: Det[]): Det[] {
  const kept: Det[] = [];
  for (const d of [...dets].sort((a, b) => area(b.box) - area(a.box))) {
    const duplicate = kept.some(
      (k) =>
        k.entry === d.entry || (sameCharacter(k.entry, d.entry) && d.box && k.box && nested(d.box, k.box)),
    );
    if (!duplicate) kept.push(d);
  }
  return kept;
}

/**
 * The frame the board is drawn from: the keyframe showing the most people to replace, nearest the
 * representative frame on ties. A character who only walks in late is then on the frame the model sees.
 */
function boardKeyframe(ws: Workspace, shot: Shot, dets: Det[]): Keyframe {
  const frames = listKeyframes(ws.db, shot.id);
  if (frames.length === 0)
    throw new AniError('conflict', 'Shot has no keyframes yet', {
      hint: 'Wait for shot preparation to finish.',
    });
  const shown = (frame: number) => distinctHeads(dets.filter((d) => d.frame === frame)).length;
  return frames.reduce((best, k) => {
    const diff = shown(k.frame) - shown(best.frame);
    if (diff !== 0) return diff > 0 ? k : best;
    return Math.abs(k.frame - shot.repFrame) < Math.abs(best.frame - shot.repFrame) ? k : best;
  });
}

/**
 * The instances of one character that are on screen together, judged at the detection frame closest to the
 * board frame. One person whose track split during the shot counts once, and so does one head detected twice
 * at two sizes; a collage or character-sheet frame showing them several times counts every view.
 */
function onScreenTogether(group: ShotCastEntry[], dets: Det[], frame: number): ShotCastEntry[] {
  const own = dets.filter((d) => group.includes(d.entry));
  if (group.length < 2 || own.length === 0) return group;
  const ref = own.reduce((b, d) => (Math.abs(d.frame - frame) < Math.abs(b.frame - frame) ? d : b));
  return distinctHeads(own.filter((d) => d.frame === ref.frame)).map((k) => k.entry);
}

/** Who to replace in a shot, grouped by persona, and the keyframe to show the image model. */
function castInShot(
  ws: Workspace,
  shot: Shot,
  perPersonaCap: number,
): { uses: PersonaUse[]; keyframe: Keyframe } {
  const mapped = shotCast(ws.db, shot.id).filter((e) => e.personaId);
  const dets = detectionsOf(ws, mapped);
  const keyframe = boardKeyframe(ws, shot, dets);
  const byCast = new Map<string, ShotCastEntry[]>();
  for (const e of mapped) {
    const key = `${e.personaId}\u0000${e.cast?.id ?? e.tracklet.id}`;
    byCast.set(key, [...(byCast.get(key) ?? []), e]);
  }
  const byPersona = new Map<string, ShotCastEntry[]>();
  for (const group of byCast.values()) {
    const personaId = group[0]!.personaId!;
    byPersona.set(personaId, [
      ...(byPersona.get(personaId) ?? []),
      ...onScreenTogether(group, dets, keyframe.frame),
    ]);
  }
  const projectId = projectOfShot(ws.db, shot.id).id;
  const uses = [...byPersona.entries()].map(([personaId, entries]) => {
    const persona = getPersona(ws.db, personaId);
    // The project's approved design sheets (drawn in this animation's style, no labels) replace the library
    // references; the library is the fallback before the design step is done.
    const castId = entries.find((e) => e.cast)?.cast?.id;
    const binding = castId ? { castMemberId: castId, personaId } : undefined;
    const designed = binding
      ? (['turnaround', 'expressions'] as const)
          .map((kind) => approvedDesign(ws.db, projectId, binding, kind)?.path)
          .filter((p): p is string => Boolean(p))
      : [];
    if (binding && designed.length > 0 && approvedDesign(ws.db, projectId, binding, 'turnaround'))
      return { persona, entries, imagePaths: designed.slice(0, perPersonaCap) };
    if (persona.images.length === 0) {
      throw new AniError('conflict', `Persona "${persona.name}" has no reference image`, {
        hint: 'Add one with `anirecast persona image-add`.',
      });
    }
    return { persona, entries, imagePaths: persona.images.slice(0, perPersonaCap).map((i) => i.path) };
  });
  return { uses, keyframe };
}

/** "the person on the left (long black hair; navy sailor uniform)" — position and looks, not just a name. */
function describeWho(ws: Workspace, frame: number, use: PersonaUse): string {
  const parts = use.entries.map((e) => {
    const placed = placeTracklet(ws.db, e.tracklet.id, frame);
    const where =
      placed.position === 'center'
        ? 'the person in the middle'
        : placed.position
          ? `the person on the ${placed.position}`
          : 'the character';
    const looks = placed.appearance ?? e.cast?.label ?? null;
    return looks ? `${where} (${looks})` : where;
  });
  return parts.join(' and ') || 'the character';
}

function layoutInstruction(uses: PersonaUse[]): string | undefined {
  const people = uses.reduce((n, u) => n + u.entries.length, 0);
  return people > 1
    ? `There are ${people} people to replace. Each replacement must stay exactly where the original person is; never swap their positions.`
    : undefined;
}

function lookInstruction(use: PersonaUse, imageLabel: string): string {
  const followSource = use.entries.some((e) => e.look?.lookPolicy === 'follow_source');
  return followSource
    ? `Keep the outfit and hairstyle the original character wears in this frame; change only the face, hair colour, eyes and distinguishing features to match ${imageLabel}.`
    : `Give them the outfit, hairstyle and colours shown in ${imageLabel}.`;
}

function overlayInstruction(overlays: TextOverlay[]): string | undefined {
  if (overlays.length === 0) return undefined;
  const parts = overlays.map((o) => `${o.text ? `"${o.text}" ` : ''}in ${describeRegion(o.bbox)}`);
  return `Remove the overlaid credit text (${parts.join('; ')}) and restore whatever it covered. Keep any text that is part of the scene itself.`;
}

const KEEP_FRAME =
  'Keep everything else from Image 1 exactly: framing, camera angle, pose, expression, lighting, background, line art and the colour style of the anime.';
const KEEP_VIDEO =
  'Keep everything else the same: motion, timing, camera movement, background, lighting and the 2D anime style.';

/**
 * Art style and light for a generated character: the anime's own drawing style (the project's style notes, else
 * how this opening draws the replaced character) and the shot's lighting. Models drift toward their own look —
 * H3 and Wan toward realism — unless told plainly.
 */
function styleInstruction(ws: Workspace, shot: Shot, uses: PersonaUse[], medium: 'frame' | 'shot'): string {
  const projectId = projectOfShot(ws.db, shot.id).id;
  const castStyle = uses
    .map((u) => u.entries.find((e) => e.cast)?.cast?.id)
    .map((id) => (id ? getCastAnalysis(ws.db, id)?.data?.style : undefined))
    .find((s) => s?.trim());
  const notes = projectStyleNotes(ws, projectId) || castStyle || '';
  const who = uses.length > 1 ? 'the new characters' : 'the new character';
  const light = shot.lighting?.trim();
  return [
    `Art style: draw ${who} exactly the way this anime draws its characters — the same line weight and line colour, eye and face construction, cel shading with the same shadow shapes, colour palette, saturation and level of detail as the original ${medium}. Flat 2D anime cel animation; never 3D, painterly, semi-realistic or photographic.`,
    notes ? `This anime's style: ${notes}` : '',
    light
      ? `Light and colour of this ${medium}: ${light} Light ${who} the same way (light direction and colour, shadow side, rim light, colour grading).`
      : `Light ${who} like the rest of the original ${medium}: same light direction and colour, shadows and colour grading.`,
  ]
    .filter(Boolean)
    .join('\n');
}

const withHashes = (ws: Workspace, refs: Array<Omit<InputRef, 'sha256'>>): InputRef[] =>
  refs.map((r) => ({ ...r, sha256: sha256File(ws.abs(r.path)) }));

export interface Plan {
  prompt: string;
  inputs: InputRef[];
  params: Record<string, unknown>;
}

/** Board request for a replace shot: representative frame first, then persona references. */
export function planBoard(
  ws: Workspace,
  shotId: string,
  opts: { extra?: string; fromBoardId?: string } = {},
): Plan {
  const shot = getShot(ws.db, shotId);
  if (shot.mode !== 'replace')
    throw new AniError('conflict', `Shot ${shotId} is ${shot.mode}; boards are for replace shots`);
  const base = opts.fromBoardId ? getBoard(ws.db, opts.fromBoardId) : undefined;
  const { uses, keyframe } = castInShot(ws, shot, 2);
  if (uses.length === 0) throw new AniError('conflict', 'No persona is mapped to anyone in this shot');
  const refs: Array<Omit<InputRef, 'sha256'>> = [{ role: 'frame', path: keyframe.path }];
  const lines = ['Image 1 is a frame from an anime opening.'];
  let next = 2;
  for (const use of uses) {
    const imgs = use.imagePaths.slice(0, Math.max(1, Math.floor(MAX_CHARACTER_REFS / uses.length)));
    const label = imgs.length === 1 ? `Image ${next}` : `Images ${next}-${next + imgs.length - 1}`;
    for (const p of imgs) refs.push({ role: `persona:${use.persona.id}`, path: p });
    next += imgs.length;
    lines.push(
      `${label} show the character "${use.persona.name}"${use.persona.description ? ` (${use.persona.description})` : ''}.`,
      `Replace ${describeWho(ws, keyframe.frame, use)} in Image 1 with this character. ${lookInstruction(use, label)}`,
    );
  }
  const layout = layoutInstruction(uses);
  if (layout) lines.push(layout);
  const overlay = overlayInstruction(overlaysToRemove(ws.db, shotId, shot.removeOtherOverlays));
  if (overlay) lines.push(overlay);
  lines.push(styleInstruction(ws, shot, uses, 'frame'));
  lines.push(KEEP_FRAME);
  // Regeneration is always a fresh, fully replayable request (no server-side multi-turn state).
  if (opts.extra?.trim()) lines.push(`Additional instructions: ${opts.extra.trim()}`);
  return {
    prompt: lines.join('\n'),
    inputs: withHashes(ws, refs),
    params: {
      aspectRatio: '16:9',
      imageSize: '1K',
      signature: replacementSignature(ws.db, shotId),
      ...(base ? { fromBoardId: base.id } : {}),
    },
  };
}

/** Video edit request: the shot (uploaded by the job), the approved board, then persona references. */
export function planTake(
  ws: Workspace,
  shotId: string,
  tier: GenerationTier,
  opts: { extra?: string; fromTakeId?: string; model?: string } = {},
): Plan & { boardId: string | null } {
  const shot = getShot(ws.db, shotId);
  if (!shot.sourcePath) throw new AniError('conflict', 'Shot source segment is not prepared yet');
  // What the model takes decides the references: none (the persona in words), the storyboard frame only, one
  // image per new character, or both.
  const spec = videoModelSpec(opts.model ?? '');
  const textOnly = opts.model ? isTextOnlyVideoModel(opts.model) || spec.maxRefs === 0 : false;
  const from = opts.fromTakeId ? getTake(ws.db, opts.fromTakeId) : undefined;
  // A revision with the same model reuses the inputs; another model is planned afresh with the instructions.
  if (from && (!opts.model || from.model === opts.model)) {
    const prompt = opts.extra?.trim()
      ? `${from.prompt}\nAdditional instructions: ${opts.extra.trim()}`
      : from.prompt;
    return {
      prompt,
      inputs: from.inputs,
      params: { ...from.params, tier, fromTakeId: from.id },
      boardId: from.boardId,
    };
  }
  const refs: Array<Omit<InputRef, 'sha256'>> = [{ role: 'video', path: shot.sourcePath }];
  // Planned afresh for another model: keep the instructions the revised take had.
  const extraLines = (from?.params.extras as string[] | undefined) ?? [];
  const lines: string[] = [];
  let boardId: string | null = null;
  if (shot.mode === 'replace') {
    const board = approvedBoard(ws.db, shotId);
    if (board?.path) boardId = board.id;
    const withBoard = Boolean(board?.path) && !textOnly && spec.refStyle !== 'per-character';
    if (withBoard && board?.path) refs.push({ role: 'board', path: board.path });
    const { uses, keyframe } = castInShot(ws, shot, 1);
    let idx = withBoard ? 1 : 0;
    // No persona names here: the images identify each character, and on the Lycoris OP names such as
    // "DeepSeek" or "Claude" went with Omni safety blocks that cleared once they were left out.
    for (const use of uses) {
      const who = describeWho(ws, keyframe.frame, use);
      if (withBoard && spec.refStyle === 'board') {
        // One reference (the storyboard frame) shows everyone already replaced.
        lines.push(
          `Replace ${who} with the character shown in <IMAGE_REF_0>. ${lookInstruction(use, '<IMAGE_REF_0>')}`,
        );
        continue;
      }
      if (textOnly || idx >= spec.maxRefs) {
        lines.push(
          `Replace ${who} with a different character: ${use.persona.description || 'see the persona notes'}. Give them that outfit, hairstyle and colours.`,
        );
        continue;
      }
      refs.push({ role: `persona:${use.persona.id}`, path: use.imagePaths[0]! });
      const look = lookInstruction(use, `<IMAGE_REF_${idx}>`);
      lines.push(
        `Replace ${who} with the character shown in ${withBoard ? '<IMAGE_REF_0> and ' : ''}<IMAGE_REF_${idx}>. ${look}`,
      );
      idx++;
    }
    const layout = layoutInstruction(uses);
    if (layout) lines.push(layout);
    if (uses.length) lines.push(styleInstruction(ws, shot, uses, 'shot'));
  } else if (shot.mode !== 'clean') {
    throw new AniError('conflict', `Nothing to generate for a ${shot.mode} shot`);
  }
  const overlay = overlayInstruction(overlaysToRemove(ws.db, shotId, shot.removeOtherOverlays));
  if (overlay) lines.push(overlay);
  if (lines.length === 0) throw new AniError('conflict', 'Clean shot has no overlay marked for removal');
  lines.push(KEEP_VIDEO);
  if (refs.length - 1 < spec.minRefs)
    throw new AniError('usage', `${spec.label} needs a reference image of each new character`, {
      hint: 'Use another video model for shots that only remove text.',
    });
  const extras = [...extraLines, ...(opts.extra?.trim() ? [opts.extra.trim()] : [])];
  for (const e of extras) lines.push(`Additional instructions: ${e}`);
  return {
    prompt: lines.join('\n'),
    inputs: withHashes(ws, refs),
    params: {
      tier,
      aspectRatio: '16:9',
      signature: replacementSignature(ws.db, shotId),
      ...(from ? { fromTakeId: from.id } : {}),
      ...(extras.length ? { extras } : {}),
    },
    boardId,
  };
}

/** A project's style notes (from the style analysis), if any. */
export function projectStyleNotes(ws: Workspace, projectId: string): string {
  const notes = getProject(ws.db, projectId).settings.styleNotes;
  return typeof notes === 'string' ? notes.trim() : '';
}

/**
 * Frames that show this animation's drawing style without the characters being replaced: shots whose only
 * characters stay as they are, else shots that keep the original, else any shot. Spread across the clip.
 */
function styleFrames(ws: Workspace, projectId: string, n: number): string[] {
  const clip = findActiveClip(ws.db, projectId);
  if (!clip) return [];
  const shots = listShots(ws.db, clip.id);
  const mid = (shotId: string) => {
    const frames = listKeyframes(ws.db, shotId);
    return (frames.find((k) => k.role === 'mid') ?? frames[0])?.path;
  };
  const keptOnly = shots.filter((s) => {
    const cast = shotCast(ws.db, s.id).filter((e) => e.cast);
    return cast.length > 0 && cast.every((e) => !e.personaId);
  });
  const kept = keptOnly.length >= n ? keptOnly : [...keptOnly, ...shots.filter((s) => s.mode === 'keep')];
  const pool = kept.length ? kept : shots;
  const picked =
    pool.length <= n ? pool : Array.from({ length: n }, (_, i) => pool[Math.floor((i * pool.length) / n)]!);
  return picked.map((s) => mid(s.id)).filter((p): p is string => Boolean(p));
}

/** The largest body crops of an original character, one per shot: her proportions as this animation draws them. */
function castBodyCrops(ws: Workspace, castId: string, n: number): Array<{ path: string; shotId: string }> {
  const rows = all<{ path: string; shot_id: string }>(
    ws.db,
    `SELECT d.body_crop_path AS path, t.shot_id FROM detections d JOIN tracklets t ON t.id = d.tracklet_id
     WHERE t.cast_member_id = :castId AND d.body_crop_path IS NOT NULL AND d.body_bbox_json IS NOT NULL
     ORDER BY (json_extract(d.body_bbox_json, '$[2]') - json_extract(d.body_bbox_json, '$[0]'))
            * (json_extract(d.body_bbox_json, '$[3]') - json_extract(d.body_bbox_json, '$[1]')) DESC`,
    { castId },
  );
  const out: Array<{ path: string; shotId: string }> = [];
  for (const r of rows) {
    if (out.length >= n) break;
    if (out.some((o) => o.shotId === r.shot_id) || !existsSync(ws.abs(r.path))) continue;
    out.push({ path: r.path, shotId: r.shot_id });
  }
  return out;
}

const midFrame = (ws: Workspace, shotId: string): string | undefined => {
  const frames = listKeyframes(ws.db, shotId);
  return (frames.find((k) => k.role === 'mid') ?? frames[0])?.path;
};

/** The two library references that matter most for each sheet, by view (imports keep expressions, then poses). */
function personaRefsFor(persona: Persona, kind: DesignKind): string[] {
  const imgs = persona.images;
  const by = (view: PersonaImage['view']) => imgs.find((i) => i.view === view);
  // Captions name what a page shows ("P03 表情範圍 · expression range"); they win over view and order.
  const labelled = (re: RegExp) => imgs.find((i) => re.test(i.label));
  const full = imgs.find((i) => i.isPrimary) ?? by('full') ?? imgs[0];
  const sheet = labelled(/turnaround|三視圖|設定/i) ?? by('sheet');
  const others = imgs.filter((i) => i.view === 'other');
  const pair =
    kind === 'turnaround'
      ? [full, sheet]
      : kind === 'expressions'
        ? [by('face') ?? labelled(/head|頭部/i) ?? full, labelled(/expression|表情/i) ?? others[0] ?? sheet]
        : [full, labelled(/pose|acting|動作|表演/i) ?? others[1] ?? others[0] ?? sheet];
  return [...new Set(pair.filter((i): i is PersonaImage => Boolean(i)).map((i) => i.path))];
}

const DESIGN_TASK: Record<DesignKind, string> = {
  turnaround:
    'Draw a clean character turnaround sheet: the same character standing in a relaxed neutral pose, full body from head to shoes, shown three times side by side at the same scale and height — front view, side view (profile) and back view.',
  expressions:
    'Draw an expression sheet: nine head-and-shoulders portraits of the same character in a 3×3 grid, same angle and size — neutral, gentle smile, big laugh, surprised, worried, sad, angry, determined, and eyes peacefully closed.',
  poses:
    'Draw an action sheet: the same character in four full-body poses side by side at the same scale — walking toward the viewer, walking away while looking back over the shoulder, running, and a relaxed everyday pose (leaning, or holding a cup).',
};

/** Columns of a sheet (and of the reference grid) for `n` expressions or poses. */
export const sheetColumns = (kind: DesignKind, n: number): number =>
  kind === 'poses' ? (n <= 4 ? n : 3) : n <= 3 ? n : n === 4 ? 2 : 3;

/**
 * Request for one design sheet of a binding: the library character redesigned for the original character she
 * replaces. Images sent, in order: two library references; then for the turnaround, the original's largest body
 * crops and one frame of the opening; for expressions and poses, one grid of the original's crops (one cell per
 * ticked item of the analysis, tiled by the daemon so it counts as a single image). Without an analysis the
 * expression and pose sheets fall back to a generic set, still drawn from the original's crops and a frame.
 */
export function planDesign(
  ws: Workspace,
  projectId: string,
  binding: Binding,
  kind: DesignKind,
  opts: { extra?: string; fromDesignId?: string } = {},
): Plan {
  const persona = getPersona(ws.db, binding.personaId);
  if (persona.kind !== 'character') throw new AniError('usage', 'Only characters get design sheets');
  const cast = getCastMember(ws.db, binding.castMemberId);
  const base = opts.fromDesignId ? getDesign(ws.db, opts.fromDesignId) : undefined;
  const personaRefs = personaRefsFor(persona, kind);
  if (personaRefs.length === 0)
    throw new AniError('conflict', `Persona "${persona.name}" has no reference image`, {
      hint: 'Add one with `anirecast persona image-add`.',
    });
  const analysis = getCastAnalysis(ws.db, cast.id)?.data ?? null;
  const items =
    kind === 'expressions' ? (analysis?.expressions ?? []) : kind === 'poses' ? (analysis?.poses ?? []) : [];
  const cells = items
    .filter((it) => it.use)
    .map((it) => {
      const a = analysis?.appearances[it.appearance];
      const path = kind === 'expressions' ? (a?.head ?? a?.body) : (a?.body ?? a?.head);
      return path && existsSync(ws.abs(path)) ? { item: it, path, shotNo: a?.shotNo } : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const bodies = castBodyCrops(ws, cast.id, kind === 'turnaround' ? 2 : 1);
  const frame = bodies[0] ? midFrame(ws, bodies[0].shotId) : styleFrames(ws, projectId, 1)[0];
  const refs: Array<Omit<InputRef, 'sha256'>> = [
    ...personaRefs.map((path) => ({ role: `persona:${persona.id}`, path })),
    ...(cells.length
      ? cells.map((c, i) => ({ role: `tile:${i + 1}`, path: c.path }))
      : [
          ...bodies.map((b) => ({ role: `original:${cast.id}`, path: b.path })),
          ...(frame ? [{ role: 'style', path: frame }] : []),
        ]),
  ];
  // Prompt numbering follows the images as sent: all tile crops become one grid image.
  const sent = refs.filter(
    (r, i) => !r.role.startsWith('tile:') || refs.findIndex((x) => x.role.startsWith('tile:')) === i,
  );
  const n = (role: string) => sent.flatMap((r, i) => (r.role.startsWith(role) ? [i + 1] : []));
  const span = (idx: number[]) => (idx.length === 1 ? `Image ${idx[0]}` : `Images ${idx[0]}–${idx.at(-1)}`);
  const who = `the original character "${cast.label}"`;
  const followsSource = (cast.looks[0]?.lookPolicy ?? 'persona') === 'follow_source';
  const lines = [
    `${span(n('persona:'))} show the library character "${persona.name}"${persona.description ? ` (${persona.description})` : ''}. She replaces ${who} in an anime opening.`,
  ];
  if (cells.length) {
    const what = kind === 'expressions' ? 'expressions' : 'poses and actions';
    lines.push(
      `${span(n('tile:'))} is a grid of ${who}'s ${what} in this opening, read left to right, top to bottom: ${cells
        .map((c, i) => `${i + 1}. ${c.item.label}${c.item.description ? ` (${c.item.description})` : ''}`)
        .join(
          '; ',
        )}. Take only the ${kind === 'expressions' ? 'expression' : 'pose'} from each cell — not its background, props in the scene, other people or the original's clothes.`,
    );
  } else {
    if (n('original:').length) lines.push(`${span(n('original:'))} show ${who} as this opening draws her.`);
    if (n('style').length) lines.push(`${span(n('style'))} is a frame from the opening.`);
  }
  const drawnLike = `the way this opening draws ${cast.label}: the same head-to-body ratio, height and build, eye and face construction, line weight and line colour, cel shading and shadow shapes, colour saturation and level of detail`;
  lines.push(
    `Redesign ${persona.name} as a character of this anime. Keep her identity from ${span(n('persona:'))} — face, hairstyle and hair colour, eye colour, accessories and distinctive features${followsSource ? '' : ', outfit design and colours'} — but draw her ${drawnLike}.`,
  );
  lines.push(
    followsSource
      ? `Outfit: she wears ${cast.label}'s outfit${analysis?.outfit ? ` (${analysis.outfit})` : ''}, with her own hair, face and features.`
      : `Do not copy ${cast.label}'s face, hair or outfit.`,
  );
  if (analysis?.style) lines.push(`How this opening draws ${cast.label}: ${analysis.style}`);
  if (analysis?.body) lines.push(`${cast.label}'s build: ${analysis.body}`);
  const note = designNote(ws.db, projectId, persona.id);
  if (note) lines.push(`Adaptation for this project: ${note}`);
  const styleNotes = projectStyleNotes(ws, projectId);
  if (styleNotes) lines.push(`About the animation's style: ${styleNotes}`);
  const columns = sheetColumns(kind, cells.length);
  if (cells.length && kind === 'expressions')
    lines.push(
      `Draw an expression sheet of ${persona.name}: exactly ${cells.length} head-and-shoulders portraits in a grid of ${columns} columns, in the same order as ${span(n('tile:'))}. Each portrait makes the same expression as the matching cell — eye shape and openness, brow angle, mouth shape, blush, tears or sweat marks, head tilt and angle — but with ${persona.name}'s face, hair, eye colour and accessories.`,
    );
  else if (cells.length)
    lines.push(
      `Draw an action sheet of ${persona.name}: exactly ${cells.length} full-body figures${columns < cells.length ? ` in rows of ${columns}` : ' side by side'} at the same scale, in the same order as ${span(n('tile:'))}. Each figure takes the same pose as the matching cell — body angle, limb positions, weight, hand gestures and camera angle — as ${persona.name}.`,
    );
  else lines.push(DESIGN_TASK[kind]);
  lines.push(
    'Plain light grey background. No text, labels, captions, numbers, logos or watermarks anywhere in the image.',
  );
  // A revision keeps the instructions of the version it revises, so fixes accumulate.
  const extras = [
    ...((base?.params.extras as string[] | undefined) ?? []),
    ...(opts.extra?.trim() ? [opts.extra.trim()] : []),
  ];
  for (const e of extras) lines.push(`Additional instructions: ${e}`);
  return {
    prompt: lines.join('\n'),
    inputs: withHashes(ws, refs),
    params: {
      aspectRatio: '16:9',
      imageSize: '2K',
      castMemberId: cast.id,
      ...(cells.length ? { tile: { columns, shots: cells.map((c) => c.shotNo) } } : {}),
      ...(base ? { fromDesignId: base.id } : {}),
      ...(extras.length ? { extras } : {}),
    },
  };
}
