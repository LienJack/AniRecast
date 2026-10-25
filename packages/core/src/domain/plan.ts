import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AniError } from '@anirecast/shared';
import type { Workspace } from '../workspace.ts';
import { type ShotCastEntry, shotCast } from './cast.ts';
import { approvedBoard, getBoard, getTake, type InputRef } from './generation.ts';
import { type Bbox, overlaysToRemove, type TextOverlay } from './overlays.ts';
import { getPersona, type Persona } from './personas.ts';
import type { GenerationTier } from './projects.ts';
import { getShot, listKeyframes, type Shot } from './shots.ts';
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

function personasInShot(ws: Workspace, shotId: string, perPersonaCap: number): PersonaUse[] {
  const byPersona = new Map<string, ShotCastEntry[]>();
  for (const e of shotCast(ws.db, shotId)) {
    if (!e.personaId) continue;
    byPersona.set(e.personaId, [...(byPersona.get(e.personaId) ?? []), e]);
  }
  return [...byPersona.entries()].map(([personaId, entries]) => {
    const persona = getPersona(ws.db, personaId);
    if (persona.images.length === 0) {
      throw new AniError('conflict', `Persona "${persona.name}" has no reference image`, {
        hint: 'Add one with `anirecast persona image-add`.',
      });
    }
    return { persona, entries, imagePaths: persona.images.slice(0, perPersonaCap).map((i) => i.path) };
  });
}

/** "the person on the left (long black hair; navy sailor uniform)" — position and looks, not just a name. */
function describeWho(ws: Workspace, shot: Shot, use: PersonaUse): string {
  const parts = use.entries.map((e) => {
    const placed = placeTracklet(ws.db, e.tracklet.id, shot.repFrame);
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

function repKeyframe(ws: Workspace, shot: Shot): string {
  const frames = listKeyframes(ws.db, shot.id);
  if (frames.length === 0)
    throw new AniError('conflict', 'Shot has no keyframes yet', {
      hint: 'Wait for shot preparation to finish.',
    });
  const nearest = frames.reduce((best, k) =>
    Math.abs(k.frame - shot.repFrame) < Math.abs(best.frame - shot.repFrame) ? k : best,
  );
  return nearest.path;
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
  const uses = personasInShot(ws, shotId, 2);
  if (uses.length === 0) throw new AniError('conflict', 'No persona is mapped to anyone in this shot');
  const refs: Array<Omit<InputRef, 'sha256'>> = [{ role: 'frame', path: repKeyframe(ws, shot) }];
  const lines = ['Image 1 is a frame from an anime opening.'];
  let next = 2;
  for (const use of uses) {
    const imgs = use.imagePaths.slice(0, Math.max(1, Math.floor(MAX_CHARACTER_REFS / uses.length)));
    const label = imgs.length === 1 ? `Image ${next}` : `Images ${next}-${next + imgs.length - 1}`;
    for (const p of imgs) refs.push({ role: `persona:${use.persona.id}`, path: p });
    next += imgs.length;
    lines.push(
      `${label} show the character "${use.persona.name}"${use.persona.description ? ` (${use.persona.description})` : ''}.`,
      `Replace ${describeWho(ws, shot, use)} in Image 1 with this character. ${lookInstruction(use, label)}`,
    );
  }
  const layout = layoutInstruction(uses);
  if (layout) lines.push(layout);
  const overlay = overlayInstruction(overlaysToRemove(ws.db, shotId, shot.removeOtherOverlays));
  if (overlay) lines.push(overlay);
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
  opts: { extra?: string; fromTakeId?: string } = {},
): Plan & { boardId: string | null } {
  const shot = getShot(ws.db, shotId);
  if (!shot.sourcePath) throw new AniError('conflict', 'Shot source segment is not prepared yet');
  if (opts.fromTakeId) {
    const from = getTake(ws.db, opts.fromTakeId);
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
  const lines: string[] = [];
  let boardId: string | null = null;
  if (shot.mode === 'replace') {
    const board = approvedBoard(ws.db, shotId);
    if (board?.path) {
      boardId = board.id;
      refs.push({ role: 'board', path: board.path });
    }
    const uses = personasInShot(ws, shotId, 1);
    let idx = boardId ? 1 : 0;
    for (const use of uses) {
      refs.push({ role: `persona:${use.persona.id}`, path: use.imagePaths[0]! });
      const look = lookInstruction(use, `<IMAGE_REF_${idx}>`);
      lines.push(
        `Replace ${describeWho(ws, shot, use)} with the character "${use.persona.name}" shown in ${boardId ? '<IMAGE_REF_0> and ' : ''}<IMAGE_REF_${idx}>. ${look}`,
      );
      idx++;
    }
    const layout = layoutInstruction(uses);
    if (layout) lines.push(layout);
  } else if (shot.mode !== 'clean') {
    throw new AniError('conflict', `Nothing to generate for a ${shot.mode} shot`);
  }
  const overlay = overlayInstruction(overlaysToRemove(ws.db, shotId, shot.removeOtherOverlays));
  if (overlay) lines.push(overlay);
  if (lines.length === 0) throw new AniError('conflict', 'Clean shot has no overlay marked for removal');
  lines.push(KEEP_VIDEO);
  if (opts.extra?.trim()) lines.push(`Additional instructions: ${opts.extra.trim()}`);
  return {
    prompt: lines.join('\n'),
    inputs: withHashes(ws, refs),
    params: { tier, aspectRatio: '16:9', signature: replacementSignature(ws.db, shotId) },
    boardId,
  };
}
