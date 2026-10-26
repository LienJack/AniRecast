import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AniError, newId } from '@anirecast/shared';
import type { Workspace } from '../workspace.ts';
import type { InputRef } from './generation.ts';
import { getProject, projectDir } from './projects.ts';

/**
 * Images the human attaches to what they tell an agent or a model (a comment, a requirement, a question for
 * Codex): kept in projects/<slug>/attachments/, then passed with the words — to the director as references it
 * may send, to the generator as labelled images, to Codex as images in its turn.
 */
export const MAX_ATTACHMENTS = 6;
const MAX_BYTES = 20_000_000;
const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  '.png': '.png',
  '.jpg': '.jpg',
  '.jpeg': '.jpg',
  '.webp': '.webp',
};

const attachmentsDir = (ws: Workspace, projectRef: string) =>
  `${projectDir(getProject(ws.db, projectRef))}/attachments`;

/** Stores an uploaded image; `kind` is its MIME type or file name. */
export function saveAttachment(
  ws: Workspace,
  projectRef: string,
  data: Uint8Array,
  kind: string,
): { path: string } {
  const ext = EXT[kind.toLowerCase()] ?? EXT[path.extname(kind).toLowerCase()];
  if (!ext) throw new AniError('usage', 'Attach a PNG, JPEG or WebP image');
  if (data.byteLength > MAX_BYTES) throw new AniError('usage', 'The image is larger than 20 MB');
  const rel = `${attachmentsDir(ws, projectRef)}/${newId('att')}${ext}`;
  mkdirSync(path.dirname(ws.abs(rel)), { recursive: true });
  writeFileSync(ws.abs(rel), data);
  return { path: rel };
}

/**
 * Attachments named on a request: workspace paths of attached images (or, from the CLI, any image file, which is
 * copied in). Anything else is refused.
 */
export function checkAttachments(ws: Workspace, projectRef: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AniError('usage', 'attachments must be a list of image paths');
  if (value.length > MAX_ATTACHMENTS)
    throw new AniError('usage', `At most ${MAX_ATTACHMENTS} attached images`);
  const dir = attachmentsDir(ws, projectRef);
  return value.map((v) => {
    if (typeof v !== 'string' || !v.trim()) throw new AniError('usage', 'attachments must be image paths');
    const p = v.trim();
    if (p.startsWith(`${dir}/`) && !p.includes('..')) {
      if (!existsSync(ws.abs(p))) throw new AniError('not_found', `Attached image not found: ${p}`);
      return p;
    }
    // An image file from elsewhere (the CLI's --attach): copied into the project.
    if (path.isAbsolute(p) && existsSync(p)) return saveAttachment(ws, projectRef, readFileSync(p), p).path;
    throw new AniError('usage', `Not an attached image of this project: ${p}`, {
      hint: 'Upload it first (POST /api/projects/:ref/attachments) or pass an absolute image path.',
    });
  });
}

/**
 * Adds the human's attached images to a planned request: after its other images, labelled in the prompt in the
 * generator's syntax (Image N, or <IMAGE_REF_k> for video models, within `maxRefs`).
 */
export function attachToPlan<
  P extends { prompt: string; inputs: InputRef[]; params: Record<string, unknown> },
>(plan: P, attachments: string[], syntax: 'image' | 'video', maxRefs = Number.POSITIVE_INFINITY): P {
  const before = (plan.params.attachments as string[] | undefined) ?? [];
  const all = [...new Set([...before, ...attachments])].slice(-MAX_ATTACHMENTS);
  // Already among the inputs (a revision that reuses them) are not sent twice.
  const fresh = all.filter((p) => !plan.inputs.some((i) => i.path === p));
  if (!fresh.length) return all.length ? { ...plan, params: { ...plan.params, attachments: all } } : plan;
  // Tiled crops (design sheets) reach the model as one image.
  const tiles = plan.inputs.some((i) => i.role.startsWith('tile:')) ? 1 : 0;
  const refsSoFar =
    syntax === 'video'
      ? plan.inputs.filter((i) => i.role !== 'video').length
      : plan.inputs.filter((i) => !i.role.startsWith('tile:')).length + tiles;
  const room = Math.max(0, Math.min(fresh.length, maxRefs - refsSoFar));
  const sent = fresh.slice(0, room);
  const labels = sent.map((_, i) =>
    syntax === 'video' ? `<IMAGE_REF_${refsSoFar + i}>` : `Image ${refsSoFar + i + 1}`,
  );
  const line = sent.length
    ? `${labels.join(', ')} ${sent.length === 1 ? 'is an image' : 'are images'} the human attached to their instructions: use ${sent.length === 1 ? 'it' : 'them'} as the instructions say.`
    : '';
  return {
    ...plan,
    prompt: line ? `${plan.prompt}\n${line}` : plan.prompt,
    inputs: [...plan.inputs, ...sent.map((p) => ({ role: 'attachment', path: p }))],
    params: { ...plan.params, attachments: all },
  };
}

/** Copies attached images into a folder (a Codex discussion), returning the copies' workspace paths. */
export function copyAttachments(ws: Workspace, attachments: string[], dir: string): string[] {
  mkdirSync(ws.abs(dir), { recursive: true });
  return attachments.map((p, i) => {
    const rel = `${dir}/attached-${i + 1}${path.extname(p)}`;
    copyFileSync(ws.abs(p), ws.abs(rel));
    return rel;
  });
}
