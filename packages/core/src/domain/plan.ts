import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AniError, isTextOnlyVideoModel, videoModelSpec } from '@anirecast/shared';
import { all, fromJson } from '../db.ts';
import type { Workspace } from '../workspace.ts';
import { getCastMember, type ShotCastEntry, shotCast } from './cast.ts';
import { getCastAnalysis } from './cast-analysis.ts';
import { findActiveClip } from './clips.ts';
import {
  approvedDesign,
  approvedOriginal,
  type Binding,
  type Design,
  type DesignKind,
  designNote,
  getDesign,
} from './designs.ts';
import {
  approvedBoard,
  type BoardRole,
  getBoard,
  getTake,
  type InputRef,
  keyBoardFor,
} from './generation.ts';
import { type Bbox, overlaysToRemove, type TextOverlay } from './overlays.ts';
import { getPersona, type Persona, type PersonaImage } from './personas.ts';
import type { GenerationTier } from './projects.ts';
import { listReferences } from './references.ts';
import { getShot, type Keyframe, listKeyframes, listShots, projectOfShot, type Shot } from './shots.ts';
import { placeTracklet, replacementSignature } from './signature.ts';
import { projectStyleRefs, styleText } from './style.ts';

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

/** The keyframe a storyboard frame redraws: the shot's first or last frame, or its key frame. */
export function roleKeyframe(ws: Workspace, shot: Shot, role: BoardRole): Keyframe {
  if (role === 'key') {
    const mapped = shotCast(ws.db, shot.id).filter((e) => e.personaId);
    return boardKeyframe(ws, shot, detectionsOf(ws, mapped));
  }
  const frames = listKeyframes(ws.db, shot.id);
  if (frames.length === 0)
    throw new AniError('conflict', 'Shot has no keyframes yet', {
      hint: 'Wait for shot preparation to finish.',
    });
  const sorted = [...frames].sort((a, b) => a.frame - b.frame);
  return frames.find((k) => k.role === role) ?? (role === 'first' ? sorted[0]! : sorted.at(-1)!);
}

/**
 * Who to replace in a shot, grouped by persona, and the keyframe to show the image model. For the first and
 * last frames only the people seen in that frame count (someone who walks in later is not drawn there).
 */
function castInShot(
  ws: Workspace,
  shot: Shot,
  perPersonaCap: number,
  role: BoardRole = 'key',
): { uses: PersonaUse[]; keyframe: Keyframe } {
  const all = shotCast(ws.db, shot.id).filter((e) => e.personaId);
  const allDets = detectionsOf(ws, all);
  const keyframe = role === 'key' ? boardKeyframe(ws, shot, allDets) : roleKeyframe(ws, shot, role);
  const seen = new Set(allDets.filter((d) => d.frame === keyframe.frame).map((d) => d.entry));
  const mapped = role === 'key' ? all : all.filter((e) => seen.has(e));
  const dets = role === 'key' ? allDets : allDets.filter((d) => mapped.includes(d.entry));
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
  const notes = projectStyleNotes(ws, projectId, medium === 'shot' ? 'video' : 'image') || castStyle || '';
  const who = uses.length > 1 ? 'the new characters' : 'the new character';
  const light = shot.lighting?.trim();
  return [
    `Art style: draw ${who} exactly the way this anime draws its characters — the same line weight and line colour, eye and face construction, cel shading with the same shadow shapes, colour palette, saturation and level of detail as the original ${medium}. Flat 2D anime cel animation; never 3D, painterly, semi-realistic or photographic.`,
    notes ? `This anime's style:\n${notes}` : '',
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

/**
 * Board request for a replace shot: the frame of its moment (first, key or last) first, then persona references.
 */
export function planBoard(
  ws: Workspace,
  shotId: string,
  opts: { extra?: string; fromBoardId?: string; role?: BoardRole } = {},
): Plan & { role: BoardRole; frame: number } {
  const shot = getShot(ws.db, shotId);
  if (shot.mode !== 'replace')
    throw new AniError('conflict', `Shot ${shotId} is ${shot.mode}; boards are for replace shots`);
  const base = opts.fromBoardId ? getBoard(ws.db, opts.fromBoardId) : undefined;
  const role = opts.role ?? base?.role ?? 'key';
  const { uses, keyframe } = castInShot(ws, shot, 2, role);
  if (uses.length === 0)
    throw new AniError(
      'conflict',
      role === 'key'
        ? 'No persona is mapped to anyone in this shot'
        : `Nobody to replace is seen in the ${role} frame of this shot`,
      { details: { role } },
    );
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
      role,
      frame: keyframe.frame,
      signature: replacementSignature(ws.db, shotId),
      ...(base ? { fromBoardId: base.id } : {}),
      ...(opts.extra?.trim() ? { extra: opts.extra.trim() } : {}),
    },
    role,
    frame: keyframe.frame,
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

/**
 * A project's style for prompts: the style bible (畫面風格分析; motion only for video) with the human's notes,
 * else the notes alone, if any.
 */
export function projectStyleNotes(
  ws: Workspace,
  projectId: string,
  medium: 'image' | 'video' = 'image',
): string {
  return styleText(ws.db, projectId, medium);
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

/** The ticked expressions or poses of an original character's analysis, each with the crop that shows it. */
function analysisCells(ws: Workspace, castId: string, kind: DesignKind) {
  const analysis = getCastAnalysis(ws.db, castId)?.data ?? null;
  const items =
    kind === 'expressions' ? (analysis?.expressions ?? []) : kind === 'poses' ? (analysis?.poses ?? []) : [];
  return items
    .filter((it) => it.use)
    .map((it) => {
      const a = analysis?.appearances[it.appearance];
      const path = kind === 'expressions' ? (a?.head ?? a?.body) : (a?.body ?? a?.head);
      return path && existsSync(ws.abs(path)) ? { item: it, path, shotNo: a?.shotNo } : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

const KIND_NAME: Record<DesignKind, string> = {
  turnaround: 'turnaround (front, side and back)',
  expressions: 'expression sheet',
  poses: 'action sheet',
};

/** Instructions carried by every revision of a sheet, so fixes accumulate. */
const extrasOf = (base: Design | undefined, extra: string | undefined) => [
  ...((base?.params.extras as string[] | undefined) ?? []),
  ...(extra?.trim() ? [extra.trim()] : []),
];

/**
 * Replacement sheet from the original character's approved sheet: the same sheet redrawn with the library
 * character in her place, so the two line up cell for cell (layout, poses, expressions, proportions, light).
 */
function planFromTemplate(
  ws: Workspace,
  projectId: string,
  o: {
    persona: Persona;
    cast: { id: string; label: string; looks: Array<{ lookPolicy: string }> };
    kind: DesignKind;
    template: Design;
    personaRefs: string[];
    base: Design | undefined;
    extra: string | undefined;
  },
): Plan {
  const { persona, cast, kind, template } = o;
  const refs: Array<Omit<InputRef, 'sha256'>> = [
    ...o.personaRefs.map((path) => ({ role: `persona:${persona.id}`, path })),
    { role: `template:${template.id}`, path: template.path as string },
  ];
  const ids = o.personaRefs.map((_, i) => i + 1);
  const mine = ids.length === 1 ? `Image ${ids[0]}` : `Images ${ids[0]}–${ids.at(-1)}`;
  const t = refs.length;
  const followsSource = (cast.looks[0]?.lookPolicy ?? 'persona') === 'follow_source';
  const lines = [
    `${mine} show the library character "${persona.name}"${persona.description ? ` (${persona.description})` : ''}.`,
    `Image ${t} is the ${KIND_NAME[kind]} of "${cast.label}", the character she replaces in an anime opening, drawn in that anime's style.`,
    `Redraw Image ${t} with ${persona.name} in place of ${cast.label}: keep the same layout, the same number and order of figures or portraits, the same poses, expressions, head and body angles, framing, proportions, line art, cel shading and lighting. Take ${persona.name}'s face, hairstyle and hair colour, eye colour, accessories and distinctive features${followsSource ? '' : ', outfit design and colours'} from ${mine}${followsSource ? `; keep ${cast.label}'s outfit from Image ${t}` : `; do not keep ${cast.label}'s face, hair or outfit`}.`,
  ];
  const note = designNote(ws.db, projectId, persona.id);
  if (note) lines.push(`Adaptation for this project: ${note}`);
  const styleNotes = projectStyleNotes(ws, projectId);
  if (styleNotes) lines.push(`About the animation's style: ${styleNotes}`);
  lines.push(
    'Plain light grey background. No text, labels, captions, numbers, logos or watermarks anywhere in the image.',
  );
  const extras = extrasOf(o.base, o.extra);
  for (const e of extras) lines.push(`Additional instructions: ${e}`);
  return {
    prompt: lines.join('\n'),
    inputs: withHashes(ws, refs),
    params: {
      aspectRatio: '16:9',
      imageSize: '2K',
      castMemberId: cast.id,
      templateId: template.id,
      ...(o.base ? { fromDesignId: o.base.id } : {}),
      ...(extras.length ? { extras } : {}),
    },
  };
}

/**
 * The original character's own model sheet (官方設定集): official design art the human accepted, plus how the
 * opening draws her, redrawn as a clean turnaround, expression sheet or action sheet — the expressions and
 * actions she has in the clip when analysed. It is reviewed, and then serves as her replacement's template.
 */
export function planOriginalDesign(
  ws: Workspace,
  projectId: string,
  castId: string,
  kind: DesignKind,
  opts: { extra?: string; fromDesignId?: string } = {},
): Plan {
  const cast = getCastMember(ws.db, castId);
  const base = opts.fromDesignId ? getDesign(ws.db, opts.fromDesignId) : undefined;
  const accepted = listReferences(ws.db, castId).filter(
    (r) => r.status === 'accepted' && existsSync(ws.abs(r.path)),
  );
  const prefer =
    kind === 'turnaround'
      ? /turnaround|model|full|全身|三視|設定|立ち/i
      : kind === 'expressions'
        ? /face|expression|表情|顔/i
        : /pose|action|動作|ポーズ|full|全身/i;
  const official = [...accepted.filter((r) => prefer.test(r.label)), ...accepted]
    .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i)
    .slice(0, 3);
  const analysis = getCastAnalysis(ws.db, castId)?.data ?? null;
  const cells = analysisCells(ws, castId, kind);
  const bodies = castBodyCrops(ws, castId, official.length ? 1 : 2);
  const frame = bodies[0] ? midFrame(ws, bodies[0].shotId) : styleFrames(ws, projectId, 1)[0];
  const refs: Array<Omit<InputRef, 'sha256'>> = [
    ...official.map((r) => ({ role: `official:${r.id}`, path: r.path })),
    ...(cells.length
      ? cells.map((c, i) => ({ role: `tile:${i + 1}`, path: c.path }))
      : [
          ...bodies.map((b) => ({ role: `original:${castId}`, path: b.path })),
          ...(frame ? [{ role: 'style', path: frame }] : []),
        ]),
  ];
  if (!refs.length)
    throw new AniError('conflict', `Nothing to draw "${cast.label}" from yet`, {
      hint: 'Accept an official reference image or analyse the original character first.',
    });
  const sent = refs.filter(
    (r, i) => !r.role.startsWith('tile:') || refs.findIndex((x) => x.role.startsWith('tile:')) === i,
  );
  const n = (role: string) => sent.flatMap((r, i) => (r.role.startsWith(role) ? [i + 1] : []));
  const span = (idx: number[]) => (idx.length === 1 ? `Image ${idx[0]}` : `Images ${idx[0]}–${idx.at(-1)}`);
  const lines: string[] = [];
  if (official.length)
    lines.push(
      `${span(n('official:'))} ${official.length === 1 ? 'is' : 'are'} official character design art of "${cast.label}" from this anime${
        official.some((r) => r.label)
          ? ` (${official
              .map((r) => r.label)
              .filter(Boolean)
              .join('; ')})`
          : ''
      }.`,
    );
  if (n('original:').length)
    lines.push(`${span(n('original:'))} show ${cast.label} as the opening draws her.`);
  if (n('style').length) lines.push(`${span(n('style'))} is a frame from the opening.`);
  if (cells.length)
    lines.push(
      `${span(n('tile:'))} is a grid of ${cast.label}'s ${kind === 'expressions' ? 'expressions' : 'poses and actions'} in the opening, read left to right, top to bottom: ${cells
        .map((c, i) => `${i + 1}. ${c.item.label}${c.item.description ? ` (${c.item.description})` : ''}`)
        .join('; ')}.`,
    );
  lines.push(
    `Draw ${cast.label}'s own model sheet — the same character, not a redesign: her face, eyes, hairstyle and hair colour, outfit and accessories exactly as in the official art${analysis?.outfit ? ` (in the opening she wears: ${analysis.outfit})` : ''}, drawn the way this anime draws her.`,
  );
  if (analysis?.style) lines.push(`How the opening draws her: ${analysis.style}`);
  const styleNotes = projectStyleNotes(ws, projectId);
  if (styleNotes) lines.push(`About the animation's style: ${styleNotes}`);
  const columns = sheetColumns(kind, cells.length);
  if (cells.length && kind === 'expressions')
    lines.push(
      `Draw an expression sheet: exactly ${cells.length} head-and-shoulders portraits of her in a grid of ${columns} columns, in the same order as ${span(n('tile:'))}, each with the same expression and head angle as its cell.`,
    );
  else if (cells.length)
    lines.push(
      `Draw an action sheet: exactly ${cells.length} full-body figures of her${columns < cells.length ? ` in rows of ${columns}` : ' side by side'} at the same scale, in the same order as ${span(n('tile:'))}, each in the same pose and camera angle as its cell.`,
    );
  else lines.push(DESIGN_TASK[kind]);
  lines.push(
    'Plain light grey background. No text, labels, captions, numbers, logos or watermarks anywhere in the image.',
  );
  const extras = extrasOf(base, opts.extra);
  for (const e of extras) lines.push(`Additional instructions: ${e}`);
  return {
    prompt: lines.join('\n'),
    inputs: withHashes(ws, refs),
    params: {
      aspectRatio: '16:9',
      imageSize: '2K',
      castMemberId: castId,
      subject: 'original',
      ...(cells.length ? { tile: { columns, shots: cells.map((c) => c.shotNo) } } : {}),
      ...(base ? { fromDesignId: base.id } : {}),
      ...(extras.length ? { extras } : {}),
    },
  };
}

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
  // An approved sheet of the original character is the template: same layout, the library character in her place.
  const template = approvedOriginal(ws.db, cast.id, kind);
  if (template?.path && existsSync(ws.abs(template.path)))
    return planFromTemplate(ws, projectId, {
      persona,
      cast,
      kind,
      template,
      personaRefs,
      base,
      extra: opts.extra,
    });
  const analysis = getCastAnalysis(ws.db, cast.id)?.data ?? null;
  const cells = analysisCells(ws, cast.id, kind);
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

/** One image the director may look at: the frame being redrawn, context it only reads, or a reference it may pass on. */
export interface BriefImage {
  /** F (the frame), C1… (context), R1… (references). */
  id: string;
  label: string;
  path: string;
  use: 'frame' | 'context' | 'reference';
}

/** What the director is told about one storyboard frame: the facts to respect and the images it may use. */
export interface DirectorBrief {
  facts: string[];
  images: BriefImage[];
  /** What the person asked for (must be honoured). */
  extra: string | null;
  /** How many reference images the generator takes besides the frame. */
  maxRefs: number;
}

const ROLE_WORDS: Record<BoardRole, string> = {
  first: 'the first frame',
  key: 'the key frame (the one showing the most people to replace)',
  last: 'the last frame',
};

const DESIGN_WORDS: Record<DesignKind, string> = {
  turnaround: 'turnaround (front, side, back)',
  expressions: 'expression sheet',
  poses: 'pose sheet',
};

/**
 * The director's brief for a storyboard frame: who to replace and how (position, looks, outfit policy), the text
 * to remove, the anime's style and the shot's light, the human's requirements, and numbered images — the frame,
 * context (the shot's other moments, the original people), and references it may pass to the image model (the
 * replacement's approved design sheets, library pictures, the shot's other approved frames, the version revised).
 */
export function boardBrief(ws: Workspace, boardId: string, maxRefs: number): DirectorBrief {
  const board = getBoard(ws.db, boardId);
  const shot = getShot(ws.db, board.shotId);
  const project = projectOfShot(ws.db, shot.id);
  const { uses, keyframe } = castInShot(ws, shot, 6, board.role);
  const frame =
    (board.frame != null && listKeyframes(ws.db, shot.id).find((k) => k.frame === board.frame)) || keyframe;
  const images: BriefImage[] = [
    {
      id: 'F',
      label: `the original ${board.role} frame (frame ${frame.frame}) to redraw`,
      path: frame.path,
      use: 'frame',
    },
  ];
  let c = 0;
  let r = 0;
  const context = (label: string, path: string) =>
    images.push({ id: `C${++c}`, label, path, use: 'context' });
  const reference = (label: string, path: string) => {
    if (!images.some((i) => i.path === path)) images.push({ id: `R${++r}`, label, path, use: 'reference' });
  };
  for (const k of listKeyframes(ws.db, shot.id)) {
    if (k.frame === frame.frame || !['first', 'mid', 'last'].includes(k.role)) continue;
    context(
      `the shot's ${k.role === 'mid' ? 'middle' : k.role} frame (frame ${k.frame}), for the action`,
      k.path,
    );
  }
  // A first or last frame keeps the new characters identical to the shot's key frame.
  const keyRef = keyBoardFor(ws.db, board);
  if (keyRef?.path)
    reference(
      `this shot's key storyboard frame (v${keyRef.version}), already drawn with the new characters: keep them identical to it — face, hair, outfit, colours, proportions`,
      keyRef.path,
    );
  const facts: string[] = [];
  const clip = findActiveClip(ws.db, project.id);
  const seconds = clip ? ((shot.frameCount * clip.fpsDen) / clip.fpsNum).toFixed(1) : '?';
  facts.push(
    `This is shot ${shot.orderIndex + 1} of an anime opening (${seconds} s). The storyboard frame redraws ${ROLE_WORDS[board.role]} of the shot.`,
  );
  if (shot.description?.trim()) facts.push(`What happens in the shot: ${shot.description.trim()}`);
  for (const use of uses) {
    const castId = use.entries.find((e) => e.cast)?.cast?.id;
    const castLabel = use.entries.find((e) => e.cast)?.cast?.label;
    const who = describeWho(ws, frame.frame, use);
    const followSource = use.entries.some((e) => e.look?.lookPolicy === 'follow_source');
    facts.push(
      `Replace ${who}${castLabel ? ` (the original character 「${castLabel}」)` : ''} with the library character "${use.persona.name}"${use.persona.description ? ` — ${use.persona.description}` : ''}. ${
        followSource
          ? 'Keep the outfit and hairstyle the original wears in this frame; change face, hair colour, eyes and distinguishing features to the new character.'
          : "Give them the new character's own outfit, hairstyle and colours, as on her design sheets."
      }`,
    );
    for (const e of use.entries) {
      const d = all<{ head_crop_path: string | null; body_crop_path: string | null }>(
        ws.db,
        'SELECT head_crop_path, body_crop_path FROM detections WHERE tracklet_id = :id ORDER BY abs(frame - :f) LIMIT 1',
        { id: e.tracklet.id, f: frame.frame },
      )[0];
      const crop = d?.body_crop_path ?? d?.head_crop_path;
      if (crop && existsSync(ws.abs(crop)))
        context(`the original person to replace (${castLabel ?? 'unnamed'}), cropped`, crop);
    }
    const binding = castId ? { castMemberId: castId, personaId: use.persona.id } : undefined;
    sheetReferences(ws, project.id, use.persona.name, castId, castLabel, binding, reference);
    for (const img of [...use.persona.images]
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .slice(0, 3))
      reference(`"${use.persona.name}" library picture (${img.view})`, img.path);
  }
  for (const role of ['first', 'key', 'last'] as const) {
    if (role === board.role) continue;
    const other = approvedBoard(ws.db, shot.id, role);
    if (other?.path)
      reference(
        `this shot's approved ${role} storyboard frame (keep the new characters consistent with it)`,
        other.path,
      );
  }
  const parent = board.parentId ? getBoard(ws.db, board.parentId) : undefined;
  if (parent?.path) {
    reference(`the previous version (v${parent.version}) being revised`, parent.path);
    facts.push(`This revises v${parent.version}; its instruction was:\n${parent.prompt}`);
  }
  const overlay = overlayInstruction(overlaysToRemove(ws.db, shot.id, shot.removeOtherOverlays));
  if (overlay) facts.push(overlay);
  const notes = projectStyleNotes(ws, project.id, 'image');
  if (notes) facts.push(`This anime's drawing style (its style bible):\n${notes}`);
  if (shot.lighting?.trim()) facts.push(`Light, colour and compositing of the shot: ${shot.lighting.trim()}`);
  for (const ref of projectStyleRefs(ws.db, project.id))
    reference(
      'an art style reference: a frame of this anime showing how it draws faces, eyes, line art and shading',
      ref,
    );
  const extra = typeof board.params.extra === 'string' ? board.params.extra : null;
  attachedImages(facts, (board.params.attachments as string[] | undefined) ?? [], reference);
  return { facts, images: images.filter((i) => existsSync(ws.abs(i.path))), extra, maxRefs };
}

/** The director's brief for a shot video: the shot itself, the facts, and the references the video model may get. */
export interface TakeBrief extends DirectorBrief {
  /** The shot's source clip, which the director watches. */
  video: string;
  /** Library character names, never to be written in a video prompt (Omni's safety filter blocked some). */
  names: string[];
}

/**
 * The director's brief for a shot video: who becomes whom (by position and looks), the outfit rule, credit text to
 * remove, the anime's style and the shot's light, the human's requirement; the shot's frames for context; and the
 * references it may send or composite — the shot's approved storyboard frames (first, key, last), the
 * replacement's approved design sheets, library pictures.
 */
export function takeBrief(
  ws: Workspace,
  shotId: string,
  opts: { extra?: string | null; maxRefs: number; attachments?: string[] },
): TakeBrief {
  const shot = getShot(ws.db, shotId);
  if (!shot.sourcePath) throw new AniError('conflict', 'Shot source segment is not prepared yet');
  const project = projectOfShot(ws.db, shot.id);
  const { uses, keyframe } = castInShot(ws, shot, 6, 'key');
  const images: BriefImage[] = [];
  let c = 0;
  let r = 0;
  const reference = (label: string, path: string) => {
    if (!images.some((i) => i.path === path) && existsSync(ws.abs(path)))
      images.push({ id: `R${++r}`, label, path, use: 'reference' });
  };
  for (const k of listKeyframes(ws.db, shot.id))
    if (['first', 'mid', 'last'].includes(k.role) && existsSync(ws.abs(k.path)))
      images.push({
        id: `C${++c}`,
        label: `the shot's ${k.role === 'mid' ? 'middle' : k.role} frame (frame ${k.frame})`,
        path: k.path,
        use: 'context',
      });
  for (const role of ['key', 'first', 'last'] as const) {
    const b = approvedBoard(ws.db, shot.id, role);
    if (b?.path)
      reference(
        `the approved storyboard frame of the shot's ${role} frame: the original frame with everyone already replaced`,
        b.path,
      );
  }
  const clip = findActiveClip(ws.db, project.id);
  const seconds = clip ? ((shot.frameCount * clip.fpsDen) / clip.fpsNum).toFixed(2) : '?';
  const facts: string[] = [
    `This is shot ${shot.orderIndex + 1} of an anime opening, ${seconds} s long (${shot.frameCount} frames).`,
  ];
  if (shot.description?.trim()) facts.push(`What happens in the shot: ${shot.description.trim()}`);
  for (const use of uses) {
    const castId = use.entries.find((e) => e.cast)?.cast?.id;
    const castLabel = use.entries.find((e) => e.cast)?.cast?.label;
    const followSource = use.entries.some((e) => e.look?.lookPolicy === 'follow_source');
    facts.push(
      `Replace ${describeWho(ws, keyframe.frame, use)}${castLabel ? ` (the original character 「${castLabel}」)` : ''} with the library character "${use.persona.name}"${use.persona.description ? ` — ${use.persona.description}` : ''}. ${
        followSource
          ? 'Keep the outfit and hairstyle the original wears; change face, hair colour, eyes and distinguishing features.'
          : "Give them the new character's own outfit, hairstyle and colours."
      }`,
    );
    const binding = castId ? { castMemberId: castId, personaId: use.persona.id } : undefined;
    sheetReferences(ws, project.id, use.persona.name, castId, castLabel, binding, reference);
    for (const img of [...use.persona.images]
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .slice(0, 2))
      reference(`"${use.persona.name}" library picture (${img.view})`, img.path);
  }
  const overlay = overlayInstruction(overlaysToRemove(ws.db, shot.id, shot.removeOtherOverlays));
  if (overlay) facts.push(overlay);
  const notes = projectStyleNotes(ws, project.id, 'video');
  if (notes) facts.push(`This anime's drawing and animation style (its style bible):\n${notes}`);
  if (shot.lighting?.trim()) facts.push(`Light, colour and compositing of the shot: ${shot.lighting.trim()}`);
  for (const ref of projectStyleRefs(ws.db, project.id))
    reference(
      'an art style reference: a frame of this anime showing how it draws faces, eyes, line art and shading',
      ref,
    );
  attachedImages(facts, opts.attachments ?? [], reference);
  return {
    facts,
    images,
    extra: opts.extra?.trim() || null,
    maxRefs: opts.maxRefs,
    video: shot.sourcePath,
    names: uses.map((u) => u.persona.name),
  };
}

/** The human's attached images: references the director should look at and pass on as the human intends. */
function attachedImages(
  facts: string[],
  attachments: string[],
  reference: (label: string, path: string) => void,
) {
  if (!attachments.length) return;
  for (const [i, p] of attachments.entries())
    reference(`image ${i + 1} the human attached to their requirement`, p);
  facts.push(
    `The human attached ${attachments.length} image${attachments.length > 1 ? 's' : ''} to their requirement (the references labelled "the human attached"). Look at them, send the ones the generator needs, and say in the instruction what each one is for.`,
  );
}

/**
 * The approved sheets of a binding, both sides: the replacement's (how she looks, in this anime's style) and the
 * original character's own (who is being replaced). The two share their layout cell for cell, so the director
 * can match a pose or expression of the original to the same cell of the replacement.
 */
function sheetReferences(
  ws: Workspace,
  projectId: string,
  personaName: string,
  castId: string | undefined,
  castLabel: string | undefined,
  binding: Binding | undefined,
  reference: (label: string, path: string) => void,
) {
  for (const kind of ['turnaround', 'expressions', 'poses'] as const) {
    const sheet = binding ? approvedDesign(ws.db, projectId, binding, kind) : undefined;
    if (sheet?.path)
      reference(`"${personaName}" approved ${DESIGN_WORDS[kind]}, drawn in this anime's style`, sheet.path);
  }
  if (!castId) return;
  for (const kind of ['turnaround', 'expressions', 'poses'] as const) {
    const sheet = approvedOriginal(ws.db, castId, kind);
    if (sheet?.path)
      reference(
        `the original character 「${castLabel ?? ''}」's approved ${DESIGN_WORDS[kind]} — who is being replaced; "${personaName}"'s ${kind} sheet has the same layout, cell for cell`,
        sheet.path,
      );
  }
}
