import type { Db } from '../db.ts';
import { getProject } from './projects.ts';

/**
 * 畫面風格分析: how this anime is drawn, as an artist could follow it — the show's style bible. Analysed once per
 * project from frames across the clip (generic words like "anime style" mean something different to every model;
 * drift starts at the eyes, hair and line weight), and used by every design, storyboard and video prompt.
 */
export interface StyleBible {
  /** One paragraph. */
  summary: string;
  /** 線: weight, colour (dark brown? coloured lines?), outer vs inner lines, tapering. */
  lineArt: string;
  /** Face shape and proportions, eye construction (iris layers, highlights, lashes, lids), nose and mouth, head-to-body. */
  faces: string;
  /** Hair shapes, strand clumps, highlight style. */
  hair: string;
  /** 影: number of cel tones, edge hardness, shadow colour shift (影色), highlights, blush. */
  shading: string;
  /** 色彩設計: palette, saturation, skin tones, how colours shift in shadow and light. */
  colour: string;
  /** 撮影: diffusion (DF), パラ gradients, bloom / glow, lens flare, chromatic aberration, grain, vignette. */
  compositing: string;
  /** 美術: how backgrounds are painted, detail, depth. */
  backgrounds: string;
  /** Animation feel: drawn on twos or threes, smears, impact frames, camera moves. */
  motion: string;
  /** Drift traps to name explicitly (3D render, smooth CG skin, painterly, …). */
  avoid: string[];
}

export const STYLE_FIELDS: ReadonlyArray<readonly [keyof Omit<StyleBible, 'summary' | 'avoid'>, string]> = [
  ['lineArt', 'Line art'],
  ['faces', 'Faces and eyes'],
  ['hair', 'Hair'],
  ['shading', 'Cel shading'],
  ['colour', 'Colour design'],
  ['compositing', 'Compositing (撮影) effects'],
  ['backgrounds', 'Backgrounds'],
  ['motion', 'Motion'],
];

export function projectStyleBible(db: Db, projectId: string): StyleBible | null {
  const bible = getProject(db, projectId).settings.styleBible as StyleBible | undefined;
  return bible && typeof bible.summary === 'string' ? bible : null;
}

/** Frames of the anime chosen as art-style references (a clear face and body in its drawing style). */
export function projectStyleRefs(db: Db, projectId: string): string[] {
  const refs = getProject(db, projectId).settings.styleRefs;
  return Array.isArray(refs) ? refs.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * The style for a prompt: the bible, field by field (motion only for video), what to avoid, and the human's own
 * notes when they say more than the bible's summary. Falls back to the notes alone.
 */
export function styleText(db: Db, projectId: string, medium: 'image' | 'video'): string {
  const project = getProject(db, projectId);
  const notes = typeof project.settings.styleNotes === 'string' ? project.settings.styleNotes.trim() : '';
  const bible = projectStyleBible(db, projectId);
  if (!bible) return notes;
  const lines = [
    bible.summary,
    ...STYLE_FIELDS.filter(([k]) => medium === 'video' || k !== 'motion')
      .filter(([k]) => bible[k]?.trim())
      .map(([k, label]) => `${label}: ${bible[k].trim()}`),
    bible.avoid.length ? `Never: ${bible.avoid.join('; ')}.` : '',
    notes && notes !== bible.summary.trim() ? `The human's notes on the style: ${notes}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
