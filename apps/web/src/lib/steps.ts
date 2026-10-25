import type { ProjectStep } from './types';

/**
 * The project flow, in order. Each step is a page under /projects/$ref; the sidebar shows them numbered
 * and every step page ends with previous / next.
 */
export const STEPS = [
  { id: 'source', label: '片源', to: '/projects/$ref/source', hint: '這個項目用的影片' },
  { id: 'clip', label: '節選', to: '/projects/$ref/clip', hint: '選要重製的時間範圍' },
  { id: 'shots', label: '分鏡', to: '/projects/$ref/shots', hint: '切鏡、合併連續動作、字幕' },
  { id: 'cast', label: '角色', to: '/projects/$ref/cast', hint: '片中角色與要換成的人設' },
  { id: 'generate', label: '生成與評審', to: '/projects/$ref/review', hint: '分鏡圖、分鏡視頻與評審' },
  { id: 'render', label: '成片', to: '/projects/$ref/renders', hint: '合成與對比' },
] as const;

export type StepId = (typeof STEPS)[number]['id'];

/** Where the flow stands: steps before the next one are done. `done` means every step is. */
export function stepState(id: StepId, next: ProjectStep | undefined): 'done' | 'current' | 'todo' {
  if (id === 'source') return 'done';
  const order: string[] = STEPS.map((s) => s.id);
  const at = next === 'done' || next === undefined ? order.length : order.indexOf(next);
  const i = order.indexOf(id);
  return i < at ? 'done' : i === at ? 'current' : 'todo';
}

/** The step a project path belongs to (detail pages count as their step). */
export function stepOfPath(pathname: string): StepId | undefined {
  const seg = /^\/projects\/[^/]+\/([^/]+)/.exec(pathname)?.[1];
  const byRoute: Record<string, StepId> = {
    source: 'source',
    clip: 'clip',
    shots: 'shots',
    cast: 'cast',
    review: 'generate',
    renders: 'render',
  };
  return seg ? byRoute[seg] : undefined;
}
