import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AniError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import { enqueueJob } from '../jobs.ts';
import type { Workspace } from '../workspace.ts';
import {
  projectSummaries,
  queueBoard,
  queueDesign,
  queueStillTake,
  queueTake,
  shotDetail,
  submitReview,
  taskContext,
} from './actions.ts';
import { answerAgentTask, completeAgentTask, getAgentTask } from './agent-tasks.ts';
import { getCastMember, listCast } from './cast.ts';
import { findActiveClip } from './clips.ts';
import {
  approvedDesign,
  type Binding,
  DESIGN_KINDS,
  type DesignKind,
  designNote,
  designOverview,
  getDesign,
  resolveBindings,
  setDesignNote,
} from './designs.ts';
import { type Board, getBoard, getTake, listTakes, shotStage, type Take } from './generation.ts';
import { recomputeShotModes } from './modes.ts';
import { getPersona, type Persona } from './personas.ts';
import {
  type GenerationTier,
  getProject,
  type Project,
  projectDir,
  TIERS,
  updateProjectSettings,
} from './projects.ts';
import {
  getShot,
  listKeyframes,
  listShots,
  mergeShots,
  projectOfShot,
  type ShotMode,
  updateShot,
} from './shots.ts';

/**
 * Codex discussions (handoffs): a problem too hard for one review comment is exported to its own Codex
 * conversation with a brief, talked through over several rounds, and its conclusion comes back as a
 * structured result. The human ticks which actions to import; only then does anything change or cost money.
 */
export type HandoffTarget = 'project' | 'shot' | 'board' | 'take' | 'design' | 'persona' | 'cast' | 'task';
export const HANDOFF_TARGETS: readonly HandoffTarget[] = [
  'project',
  'shot',
  'board',
  'take',
  'design',
  'persona',
  'cast',
  'task',
];
export type HandoffStatus = 'open' | 'submitted' | 'imported' | 'closed';

export type HandoffAction =
  | { type: 'design.note'; persona: string; note: string; why?: string }
  | {
      type: 'design.generate';
      /** The original character (cast id); or `persona` for every original bound to it; or just `from`. */
      cast?: string;
      persona?: string;
      kind?: DesignKind;
      from?: string;
      extra?: string;
      why?: string;
    }
  | { type: 'board.generate'; shot: string; from?: string; extra?: string; why?: string }
  | {
      type: 'take.generate';
      shot: string;
      from?: string;
      extra?: string;
      tier?: GenerationTier;
      why?: string;
    }
  | { type: 'take.still'; shot: string; tier?: GenerationTier; why?: string }
  | { type: 'shot.mode'; shot: string; mode: ShotMode; why?: string }
  | { type: 'shots.merge'; first: string; second: string; reason?: string; why?: string }
  | { type: 'style.notes'; text: string; why?: string }
  | { type: 'approve'; target: string; why?: string }
  | { type: 'task.answer'; task: string; answer: string; why?: string }
  | { type: 'task.close'; task: string; note: string; why?: string };
export type HandoffActionType = HandoffAction['type'];

/** Actions that send a model request (and so may cost money and quota). */
const PAID: ReadonlySet<HandoffActionType> = new Set(['design.generate', 'board.generate', 'take.generate']);

export interface HandoffItem {
  action: HandoffAction;
  /** One line for the human, e.g. "重畫 Claude 的三視圖（依 v2）：肩膀遮住". */
  label: string;
  paid: boolean;
}

export interface HandoffResult {
  summary: string;
  items: HandoffItem[];
  /** Versions Codex already generated during the discussion, for the human to look at. */
  versions: Array<{
    id: string;
    kind: 'board' | 'take' | 'design';
    label: string;
    note: string;
    shotId: string | null;
  }>;
  submittedBy: string;
  submittedAt: number;
}

export interface AppliedItem {
  index: number;
  ok: boolean;
  /** Ids of what was created or changed. */
  refs: string[];
  error: string | null;
  by: string;
  at: number;
}

export interface Handoff {
  id: string;
  projectId: string;
  targetType: HandoffTarget;
  targetId: string | null;
  /** What the human wants to discuss. */
  topic: string;
  /** What is being discussed, for people ("分鏡 #12 的分鏡視頻 v3"). */
  targetLabel: string;
  status: HandoffStatus;
  /** Workspace-relative folder with BRIEF.md, context.json and (from Codex) result.json. */
  dir: string;
  threadId: string | null;
  result: HandoffResult | null;
  applied: AppliedItem[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  project_id: string;
  target_type: HandoffTarget;
  target_id: string | null;
  topic: string;
  status: HandoffStatus;
  dir: string;
  thread_id: string | null;
  result_json: string | null;
  applied_json: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const KIND_TEXT: Record<DesignKind, string> = { turnaround: '三視圖', expressions: '表情', poses: '動作' };
const TIER_TEXT: Record<GenerationTier, string> = {
  draft: '草稿 360p',
  preview: '預覽 720p',
  final: '成品 1080p',
};
const MODE_TEXT: Record<ShotMode, string> = {
  replace: '換角',
  clean: '去字',
  keep: '沿用原片',
  exclude: '排除',
};
const STATUS_TEXT: Record<string, string> = {
  queued: '排隊中',
  generating: '生成中',
  ready: '待評審',
  approved: '已通過',
  rejected: '已退回',
  failed: '失敗',
  stale: '已過期',
};

const shotNo = (db: Db, shotId: string) => `分鏡 #${getShot(db, shotId).orderIndex + 1}`;

function targetLabel(db: Db, type: HandoffTarget, id: string | null): string {
  if (type === 'project' || !id) return '整個項目';
  if (type === 'shot') return shotNo(db, id);
  if (type === 'board') {
    const b = getBoard(db, id);
    return `${shotNo(db, b.shotId)} 的分鏡圖 v${b.version}`;
  }
  if (type === 'take') {
    const t = getTake(db, id);
    return `${shotNo(db, t.shotId)} 的分鏡視頻 v${t.version}（${TIER_TEXT[t.tier]}）`;
  }
  if (type === 'design') {
    const d = getDesign(db, id);
    return `${getPersona(db, d.personaId).name} 的${KIND_TEXT[d.kind]} v${d.version}`;
  }
  if (type === 'persona') return `${getPersona(db, id).name} 的角色設計`;
  if (type === 'cast') return `角色「${getCastMember(db, id).label}」`;
  const task = getAgentTask(db, id);
  return `任務 ${task.id}${task.shotId ? `（${shotNo(db, task.shotId)}）` : ''}`;
}

/** A discussed version may have been deleted since (to split or merge its shot). */
const safeLabel = (db: Db, type: HandoffTarget, id: string | null): string => {
  try {
    return targetLabel(db, type, id);
  } catch {
    return `已刪除的${type === 'board' ? '分鏡圖' : type === 'take' ? '分鏡視頻' : '項目'}（${id ?? ''}）`;
  }
};

const toHandoff = (db: Db, r: Row): Handoff => ({
  id: r.id,
  projectId: r.project_id,
  targetType: r.target_type,
  targetId: r.target_id,
  topic: r.topic,
  targetLabel: safeLabel(db, r.target_type, r.target_id),
  status: r.status,
  dir: r.dir,
  threadId: r.thread_id,
  result: r.result_json ? fromJson<HandoffResult | null>(r.result_json, null) : null,
  applied: r.applied_json ? fromJson<AppliedItem[]>(r.applied_json, []) : [],
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getHandoff(db: Db, id: string): Handoff {
  const r = one<Row>(db, 'SELECT * FROM handoffs WHERE id = :id', { id });
  if (!r) throw new AniError('not_found', `Codex discussion not found: ${id}`);
  return toHandoff(db, r);
}

export function listHandoffs(db: Db, projectId: string): Handoff[] {
  return all<Row>(db, 'SELECT * FROM handoffs WHERE project_id = :projectId ORDER BY created_at DESC', {
    projectId,
  }).map((r) => toHandoff(db, r));
}

function event(
  db: Db,
  h: Pick<Handoff, 'id' | 'projectId'>,
  kind: string,
  actor: string,
  payload = {},
): void {
  appendEvent(db, { actor, kind, entityType: 'handoff', entityId: h.id, projectId: h.projectId, payload });
}

/** The project a target belongs to; throws when it does not exist. */
function projectOfTarget(db: Db, type: HandoffTarget, id: string | null): string | null {
  if (type === 'project' || type === 'persona' || !id) return null;
  if (type === 'shot') return projectOfShot(db, id).id;
  if (type === 'board') return projectOfShot(db, getBoard(db, id).shotId).id;
  if (type === 'take') return projectOfShot(db, getTake(db, id).shotId).id;
  if (type === 'design') return getDesign(db, id).projectId;
  if (type === 'cast') return getCastMember(db, id).projectId;
  return getAgentTask(db, id).projectId;
}

// ---- the brief ---------------------------------------------------------------------------------------

interface BriefImage {
  path: string;
  about: string;
}

const sheetOf = (ws: Workspace, p: Persona) => {
  const img = p.images.find((i) => i.isPrimary) ?? p.images.find((i) => i.view === 'full') ?? p.images[0];
  return img ? ws.abs(img.path) : null;
};

function versionLines(
  ws: Workspace,
  kind: 'board' | 'take',
  versions: Array<
    (Board | Take) & { reviews: Array<{ verdict: string; comment: string | null; createdBy: string }> }
  >,
): string[] {
  return versions.map((v) => {
    const tier = 'tier' in v ? ` · ${TIER_TEXT[v.tier]}` : '';
    const frames = 'framesOut' in v && v.framesIn !== null ? ` · ${v.framesOut ?? '?'}/${v.framesIn} 幀` : '';
    const reviews = v.reviews
      .map((r) => `\n    - 評審（${r.createdBy}）：${r.verdict}${r.comment ? ` — ${r.comment}` : ''}`)
      .join('');
    return `- ${kind === 'board' ? '分鏡圖' : '分鏡視頻'} v${v.version}（\`${v.id}\`）· ${STATUS_TEXT[v.status] ?? v.status}${tier}${frames} · 由 ${v.createdBy} · ${v.model}${v.path ? ` · ${ws.abs(v.path)}` : ''}${v.error ? `\n    - 失敗原因：${v.error}` : ''}${reviews}`;
  });
}

function shotSection(ws: Workspace, shotId: string, focusId: string | null) {
  const d = shotDetail(ws, shotId);
  const images: BriefImage[] = [];
  const rep =
    d.keyframes.find((k) => k.frame === d.shot.repFrame) ??
    d.keyframes.find((k) => k.role === 'mid') ??
    d.keyframes[0];
  if (rep)
    images.push({
      path: ws.abs(rep.path),
      about: `${shotNo(ws.db, shotId)} 原片代表幀（第 ${rep.frame} 幀）`,
    });
  const focusBoard = d.boards.find((b) => b.id === focusId) ?? d.boards.filter((b) => b.path).at(-1);
  if (focusBoard?.path)
    images.push({ path: ws.abs(focusBoard.path), about: `分鏡圖 v${focusBoard.version}` });
  const lines = [
    `### ${shotNo(ws.db, shotId)}（\`${shotId}\`）`,
    `- 幀 ${d.shot.startFrame}–${d.shot.endFrame}（${d.shot.frameCount} 幀，${d.seconds} 秒）· 處理方式：${MODE_TEXT[d.shot.mode]} · 階段：${d.stage}`,
    ...(d.shot.description ? [`- 畫面描述：${d.shot.description}`] : []),
    `- 原片關鍵幀：${d.keyframes.map((k) => `${ws.abs(k.path)}（${k.role}，第 ${k.frame} 幀）`).join('、') || '無'}`,
  ];
  const seen = new Set<string>();
  for (const e of d.cast) {
    if (!e.cast || seen.has(e.cast.id)) continue;
    seen.add(e.cast.id);
    lines.push(
      `- 出場：「${e.cast.label}」→ ${e.persona ? `換成 ${e.persona.name}（\`${e.persona.slug}\`）` : '保留原角色'}`,
    );
    if (e.persona) {
      const design = approvedDesign(
        ws.db,
        d.project.id,
        { castMemberId: e.cast.id, personaId: e.persona.id },
        'turnaround',
      );
      const ref = design?.path ? ws.abs(design.path) : sheetOf(ws, e.persona);
      if (ref && !images.some((i) => i.path === ref))
        images.push({
          path: ref,
          about: `${e.persona.name}${design ? ' 的角色設計（三視圖）' : '（物料庫原圖）'}`,
        });
    }
  }
  if (d.overlays.some((o) => o.remove))
    lines.push(
      `- 要去掉的疊字：${d.overlays
        .filter((o) => o.remove)
        .map((o) => o.text ?? '（無文字）')
        .join('、')}`,
    );
  lines.push(
    '',
    '分鏡圖：',
    ...(versionLines(ws, 'board', d.boards).length ? versionLines(ws, 'board', d.boards) : ['- 還沒有']),
  );
  lines.push(
    '',
    '分鏡視頻：',
    ...(versionLines(ws, 'take', d.takes).length ? versionLines(ws, 'take', d.takes) : ['- 還沒有']),
  );
  const focus = [...d.boards, ...d.takes].find((v) => v.id === focusId);
  if (focus) lines.push('', `討論的版本 \`${focus.id}\` 的提示詞：`, '```text', focus.prompt, '```');
  const open = d.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  if (open.length)
    lines.push(
      '',
      '未完成的自動任務：',
      ...open.map(
        (t) => `- \`${t.id}\` ${t.kind} · ${t.status}${t.question ? ` · Codex 問：${t.question}` : ''}`,
      ),
    );
  return { lines, images, context: d };
}

/** One binding: the original character, the library character replacing her, the analysis and the sheets. */
function bindingSection(ws: Workspace, projectId: string, castId: string, focusId: string | null) {
  const entry = designOverview(ws.db, projectId).bindings.find((b) => b.cast.id === castId);
  const cast = getCastMember(ws.db, castId);
  const images: BriefImage[] = [];
  if (cast.thumbPath) images.push({ path: ws.abs(cast.thumbPath), about: `原片角色「${cast.label}」` });
  const lines = [`### 原片角色「${cast.label}」（\`${cast.id}\`）`];
  if (cast.description) lines.push(`- 描述：${cast.description}`);
  lines.push(
    `- 服裝處理：${(cast.looks[0]?.lookPolicy ?? 'persona') === 'follow_source' ? '跟原片走（只換臉和特徵）' : '用人設的服裝與髮型'}`,
  );
  const a = entry?.analysis;
  if (a?.data) {
    lines.push(
      `- 原片分析${a.stale ? '（原片角色的出場有變，建議重新分析）' : ''}：畫風：${a.data.style || '—'}；身形：${a.data.body || '—'}；服裝：${a.data.outfit || '—'}`,
    );
    const item = (it: { label: string; description: string; appearance: number; use: boolean }) => {
      const ap = a.data?.appearances[it.appearance];
      return `${it.use ? '' : '（不用）'}${it.label}${it.description ? `：${it.description}` : ''}${ap ? `（分鏡 #${ap.shotNo}，${ws.abs(ap.head ?? ap.body ?? '')}）` : ''}`;
    };
    if (a.data.expressions.length) lines.push(`- 原片表情：${a.data.expressions.map(item).join('；')}`);
    if (a.data.poses.length) lines.push(`- 原片動作：${a.data.poses.map(item).join('；')}`);
  } else lines.push(`- 原片分析：${a ? a.status : '還沒做'}`);
  if (!cast.personaId) return { lines: [...lines, '- 還沒綁定物料庫角色'], images, context: { cast } };
  const persona = getPersona(ws.db, cast.personaId);
  const lib = sheetOf(ws, persona);
  if (lib) images.push({ path: lib, about: `${persona.name}（物料庫原圖）` });
  lines.push(
    '',
    `換成物料庫角色 ${persona.name}（\`${persona.slug}\`）`,
    ...(persona.description ? [`- 物料庫描述：${persona.description}`] : []),
    `- 物料庫圖片：${persona.images.map((i) => `${ws.abs(i.path)}（${i.label || i.view}）`).join('、') || '無'}`,
    `- 這個項目的改編說明：${designNote(ws.db, projectId, persona.id) || '（沒有）'}`,
  );
  // Where the character appears, and why the latest attempts there failed (often the content filter).
  const tier = getProject(ws.db, projectId).generationTier;
  const shotIds = all<{ id: string }>(
    ws.db,
    `SELECT id FROM shots WHERE id IN (SELECT shot_id FROM tracklets WHERE cast_member_id = :castId) ORDER BY order_index`,
    { castId },
  ).map((r) => r.id);
  if (shotIds.length) {
    lines.push('', `出場的分鏡（${shotIds.length} 個，檔位 ${TIER_TEXT[tier]}）：`);
    for (const id of shotIds.slice(0, 40)) {
      const failed = listTakes(ws.db, id).filter((t) => t.status === 'failed' && t.error);
      const last = failed.at(-1);
      lines.push(
        `- ${shotNo(ws.db, id)}（\`${id}\`）· ${shotStage(ws.db, id, tier)}${failed.length ? ` · 分鏡視頻失敗 ${failed.length} 次，最近一次：${last?.error?.slice(0, 160)}` : ''}`,
      );
    }
  }
  for (const sheet of entry?.sheets ?? []) {
    lines.push('', `${KIND_TEXT[sheet.kind]}：`);
    if (!sheet.versions.length) lines.push('- 還沒有');
    for (const v of sheet.versions) {
      lines.push(
        `- v${v.version}（\`${v.id}\`）· ${STATUS_TEXT[v.status] ?? v.status} · 由 ${v.createdBy}${v.path ? ` · ${ws.abs(v.path)}` : ''}${v.error ? ` · 失敗：${v.error}` : ''}`,
        ...v.reviews.map(
          (r) => `    - 評審（${r.createdBy}）：${r.verdict}${r.comment ? ` — ${r.comment}` : ''}`,
        ),
      );
    }
    const show = sheet.versions.find((v) => v.id === focusId) ?? sheet.latest;
    if (show?.path && (focusId === null || show.id === focusId))
      images.push({
        path: ws.abs(show.path),
        about: `${persona.name} 的${KIND_TEXT[sheet.kind]} v${show.version}`,
      });
  }
  const focus = entry?.sheets.flatMap((sh) => sh.versions).find((v) => v.id === focusId);
  if (focus) {
    lines.push('', `討論的版本 \`${focus.id}\` 的提示詞：`, '```text', focus.prompt, '```');
    for (const input of focus.inputs.filter((i) => i.role === 'style' || i.role.startsWith('original:')))
      images.push({
        path: ws.abs(input.path),
        about: input.role === 'style' ? '原片畫面' : `「${cast.label}」的身形`,
      });
  }
  return { lines, images, context: { binding: entry ?? null } };
}

/** A library character: every original character bound to it in this project (or just the library entry). */
function personaSection(ws: Workspace, projectId: string, personaId: string, focusId: string | null) {
  const persona = getPersona(ws.db, personaId);
  const bound = designOverview(ws.db, projectId).bindings.filter((b) => b.persona.id === persona.id);
  if (!bound.length) {
    const lib = sheetOf(ws, persona);
    return {
      lines: [`### ${persona.name}（\`${persona.slug}\`）`, '- 這個項目還沒有原片角色綁定它。'],
      images: lib ? [{ path: lib, about: `${persona.name}（物料庫原圖）` }] : [],
      context: { persona },
    };
  }
  const parts = bound.map((b) => bindingSection(ws, projectId, b.cast.id, focusId));
  return {
    lines: parts.flatMap((p, i) => (i ? ['', ...p.lines] : p.lines)),
    images: parts.flatMap((p) => p.images),
    context: { bindings: parts.map((p) => p.context) },
  };
}

function projectSection(ws: Workspace, project: Project) {
  const summary = projectSummaries(ws).find((p) => p.id === project.id);
  const cast = listCast(ws.db, project.id);
  const clip = findActiveClip(ws.db, project.id);
  const shots = clip ? listShots(ws.db, clip.id) : [];
  const images: BriefImage[] = [];
  for (const s of shots.filter((_, i) => i % Math.max(1, Math.ceil(shots.length / 4)) === 0).slice(0, 4)) {
    const k = listKeyframes(ws.db, s.id).find((x) => x.role === 'mid');
    if (k) images.push({ path: ws.abs(k.path), about: `${shotNo(ws.db, s.id)} 原片` });
  }
  const lines = [
    `- 分鏡 ${shots.length} 個（換角 ${shots.filter((s) => s.mode === 'replace').length}、去字 ${shots.filter((s) => s.mode === 'clean').length}、沿用 ${shots.filter((s) => s.mode === 'keep').length}）；已通過 ${summary?.approved ?? 0}/${summary?.toGenerate ?? 0}；目前步驟：${summary?.step ?? '?'}`,
    ...cast.map(
      (c) =>
        `- 角色「${c.label}」（\`${c.id}\`，${c.shotIds.length} 個分鏡）→ ${c.personaId ? `換成 ${getPersona(ws.db, c.personaId).name}` : '保留'}`,
    ),
    `- 分鏡列表：\`anirecast shots list ${project.slug}\`；每個分鏡的階段：\`anirecast review status ${project.slug}\``,
  ];
  const style = typeof project.settings.styleNotes === 'string' ? project.settings.styleNotes : '';
  if (style) lines.push(`- 畫風說明：${style}`);
  return { lines, images, context: { summary, cast } };
}

function targetSection(ws: Workspace, project: Project, type: HandoffTarget, id: string | null) {
  if (type === 'shot' && id) return shotSection(ws, id, null);
  if (type === 'board' && id) return shotSection(ws, getBoard(ws.db, id).shotId, id);
  if (type === 'take' && id) return shotSection(ws, getTake(ws.db, id).shotId, id);
  if (type === 'design' && id) {
    const d = getDesign(ws.db, id);
    return d.castMemberId
      ? bindingSection(ws, project.id, d.castMemberId, id)
      : personaSection(ws, project.id, d.personaId, id);
  }
  if (type === 'persona' && id) return personaSection(ws, project.id, id, null);
  if (type === 'cast' && id) {
    const c = getCastMember(ws.db, id);
    const base = bindingSection(ws, project.id, id, null);
    return {
      lines: [
        ...base.lines,
        `- 出現在 ${c.shotIds.length} 個分鏡；造型：${c.looks.map((l) => `${l.label}（${l.lookPolicy}）`).join('、') || '一種'}`,
      ],
      images: base.images,
      context: { cast: c, binding: base.context },
    };
  }
  if (type === 'task' && id) {
    const ctx = taskContext(ws, id);
    const t = ctx.task;
    const base = t.shotId
      ? shotSection(ws, t.shotId, ctx.target?.id ?? null)
      : ctx.target && 'personaId' in ctx.target
        ? ctx.target.castMemberId
          ? bindingSection(ws, project.id, ctx.target.castMemberId, ctx.target.id)
          : personaSection(ws, project.id, ctx.target.personaId, ctx.target.id)
        : null;
    const payload = t.payload as { comment?: string; contactSheets?: string[] };
    const sheets = (payload.contactSheets ?? []).map((p) => ({ path: ws.abs(p), about: '對照表' }));
    return {
      lines: [
        `### 自動任務 \`${t.id}\`（${t.kind}，${t.status}）`,
        ...(payload.comment ? [`- 人類的意見：${payload.comment}`] : []),
        ...(t.question ? [`- Codex 之前問：${t.question}`] : []),
        ...(t.answer ? [`- 人類回覆過：${t.answer}`] : []),
        ...(t.resultNote ? [`- 結果說明：${t.resultNote}`] : []),
        `- 完整內容：\`anirecast tasks show ${t.id}\``,
        ...(base ? ['', ...base.lines] : []),
      ],
      images: [...sheets, ...(base?.images ?? [])],
      context: { task: ctx, target: base?.context ?? null },
    };
  }
  return projectSection(ws, project);
}

const RESULT_EXAMPLE = {
  summary: '一兩段話：討論的結論、為什麼這樣做、還沒解決的地方。',
  actions: [
    {
      type: 'design.note',
      persona: 'deepseek',
      note: 'covered shoulders, looser cut',
      why: '避免被內容過濾擋下',
    },
    {
      type: 'design.generate',
      persona: 'deepseek',
      kind: 'turnaround',
      from: 'dsg_…',
      extra: 'longer sleeves',
    },
    {
      type: 'board.generate',
      shot: 'sht_…',
      from: 'brd_…',
      extra: 'Keep the camera angle. Keep everything else the same.',
    },
    { type: 'take.generate', shot: 'sht_…', from: 'tak_…', extra: '…', tier: 'draft' },
    { type: 'approve', target: 'brd_…', why: '討論中試做的 v4 最接近原片' },
  ],
  versions: [{ id: 'brd_…', note: '討論中試做的版本，背景比較乾淨' }],
};

const ACTION_DOCS = [
  '| type | 欄位 | 導入時會做什麼 |',
  '| --- | --- | --- |',
  '| `design.note` | `persona`, `note` | 設定這個項目對角色的改編說明（每張角色設計都會用） |',
  '| `design.generate` | `cast`（原片角色 id）或 `persona`, `kind?`（turnaround／expressions／poses，省略＝三張）, `from?`, `extra?` | 依綁定重新設計或修正角色設計（付費） |',
  '| `board.generate` | `shot`, `from?`, `extra?` | 生成或修正分鏡圖（付費） |',
  '| `take.generate` | `shot`, `from?`, `extra?`, `tier?` | 生成或修正分鏡視頻（付費，佔每日配額） |',
  '| `take.still` | `shot`, `tier?` | 用通過的分鏡圖做靜態分鏡視頻（免費） |',
  '| `shot.mode` | `shot`, `mode`（replace／clean／keep／exclude） | 改分鏡的處理方式 |',
  '| `shots.merge` | `first`, `second`, `reason?` | 合併相鄰兩個分鏡（不會強制，已有版本時會失敗） |',
  '| `style.notes` | `text` | 設定項目的畫風說明（之後的生成都會用） |',
  '| `approve` | `target`（brd_／tak_／dsg_） | 通過這個版本（人類勾選才會做，預設不勾） |',
  '| `task.answer` | `task`, `answer` | 回覆一個等人類回覆的自動任務 |',
  '| `task.close` | `task`, `note` | 把一個自動任務標記完成 |',
];

function briefMarkdown(
  ws: Workspace,
  project: Project,
  h: Pick<Handoff, 'id' | 'topic' | 'targetLabel' | 'dir'>,
  section: { lines: string[]; images: BriefImage[] },
): string {
  const dir = ws.abs(h.dir);
  return [
    `# AniRecast · Codex 討論 ${h.id}`,
    '',
    `- 項目：${project.name}（\`${project.slug}\`）· 生成檔位：${TIER_TEXT[project.generationTier]}`,
    `- Workspace：${ws.root}（指令都在這裡執行）`,
    `- 討論對象：${h.targetLabel}`,
    '',
    '## 人類想討論的問題',
    '',
    ...h.topic.split('\n').map((l) => `> ${l}`),
    '',
    '## 目前狀況',
    '',
    ...section.lines,
    '',
    '更完整的資料在同一個資料夾的 `context.json`；任何東西都可以用 anirecast CLI 再查。',
    '',
    '## 圖片',
    '',
    ...(section.images.length ? section.images.map((i) => `- ${i.about}：${i.path}`) : ['- （沒有）']),
    '',
    '## 討論方式',
    '',
    '1. 先看圖、讀這份說明，用繁體中文整理：問題在哪、你的判斷、2–3 個可行做法（各自的費用、配額和風險）。然後停下來，等人類回覆。',
    '2. 這是多輪討論：照人類的回覆調整，重要的決定讓人類做。',
    '3. 會花錢的生成（角色設計、分鏡圖、分鏡視頻）要先問人類並說明大概費用；同意後可以用 anirecast CLI 試做，加 `--wait` 等結果再看圖。分鏡視頻佔每日配額，先看 `anirecast quota`。',
    '4. 不要按「通過」（CLI 會拒絕）；想通過就寫進結論的 `approve`。不要執行 `anirecast tasks done`。',
    `5. 達成結論時，把結論寫成 \`${path.join(dir, 'result.json')}\`（格式見下），再執行 \`anirecast codex submit ${h.id}\`。報錯就照錯誤修正後再送；可以送很多次，以最後一次為準。人類會在網頁上逐項勾選導入。`,
    `6. 需要的草稿或暫存檔放在 \`${path.join(dir, 'work')}\`，不要改 Workspace 裡其他檔案。`,
    '',
    '## result.json 格式',
    '',
    '```json',
    JSON.stringify(RESULT_EXAMPLE, null, 2),
    '```',
    '',
    '`actions` 依序執行，每個都可以加 `why`（給人看的理由）。可以用的 action：',
    '',
    ...ACTION_DOCS,
    '',
    '`persona` 可以寫 id 或 slug；`shot`、`from`、`target`、`task` 寫 id。`versions` 列出你在討論中已經生成、值得人類看的版本。',
    '',
  ].join('\n');
}

/** Paste this into any Codex session to start the discussion there instead. */
export function handoffPrompt(ws: Workspace, h: Pick<Handoff, 'id' | 'dir'>): string {
  return `請用 anirecast skill 和我進行 AniRecast 的 Codex 討論 ${h.id}。Workspace 在 ${ws.root}。先讀 ${path.join(ws.abs(h.dir), 'BRIEF.md')} 並看裡面列出的圖，整理問題和可行做法後等我回覆。`;
}

/** Images and the first message for the Codex thread that hosts the discussion. */
export function handoffKickoff(
  ws: Workspace,
  h: Handoff,
): { images: string[]; text: string; threadName: string } {
  const project = getProject(ws.db, h.projectId);
  const context = fromJson<{ images?: BriefImage[] }>(
    existsSync(ws.abs(`${h.dir}/context.json`))
      ? readFileSync(ws.abs(`${h.dir}/context.json`), 'utf8')
      : '{}',
    {},
  );
  return {
    images: (context.images ?? [])
      .map((i) => i.path)
      .filter((p) => existsSync(p))
      .slice(0, 8),
    threadName: `AniRecast · ${project.name} · 討論 · ${h.targetLabel}`,
    text: [
      `這是 AniRecast 的 Codex 討論 ${h.id}，由人類從網頁發起，會進行多輪對話；和自動任務不同，這裡不用 \`anirecast tasks done\`。`,
      `1. 先讀 ${path.join(ws.abs(h.dir), 'BRIEF.md')}（附上的圖就是裡面列出的），照 anirecast skill 的「Codex 討論」一節進行。`,
      '2. 用繁體中文整理問題、你的判斷和 2–3 個可行做法（費用、配額、風險），然後停下來等人類回覆。',
      '3. 會花錢的生成先問人類。不要按通過。',
      `4. 達成結論後寫 result.json，執行 \`anirecast codex submit ${h.id}\`。`,
    ].join('\n'),
  };
}

export function createHandoff(
  ws: Workspace,
  input: {
    projectRef: string;
    targetType: HandoffTarget;
    targetId?: string | null;
    topic: string;
    actor: string;
  },
  now: number = Date.now(),
): Handoff {
  if (!HANDOFF_TARGETS.includes(input.targetType))
    throw new AniError('usage', `Target must be one of ${HANDOFF_TARGETS.join(', ')}`);
  const topic = input.topic.trim();
  if (!topic) throw new AniError('usage', 'Say what to discuss (topic)');
  const project = getProject(ws.db, input.projectRef);
  const targetId = input.targetType === 'project' ? null : (input.targetId ?? null);
  if (input.targetType !== 'project' && !targetId)
    throw new AniError('usage', `A ${input.targetType} discussion needs the ${input.targetType} id`);
  const owner = projectOfTarget(ws.db, input.targetType, targetId);
  if (owner && owner !== project.id) throw new AniError('usage', `${targetId} belongs to another project`);
  if (input.targetType === 'persona' && targetId) getPersona(ws.db, targetId);
  const id = newId('hof', now);
  const dir = `${projectDir(project)}/codex/${id}`;
  const label = targetLabel(ws.db, input.targetType, targetId);
  const section = targetSection(ws, project, input.targetType, targetId);
  mkdirSync(ws.abs(`${dir}/work`), { recursive: true });
  writeFileSync(
    ws.abs(`${dir}/BRIEF.md`),
    briefMarkdown(ws, project, { id, topic, targetLabel: label, dir }, section),
  );
  writeFileSync(
    ws.abs(`${dir}/context.json`),
    JSON.stringify(
      {
        id,
        topic,
        target: { type: input.targetType, id: targetId, label },
        images: section.images,
        data: section.context,
      },
      null,
      2,
    ),
  );
  run(
    ws.db,
    `INSERT INTO handoffs (id, project_id, target_type, target_id, topic, status, dir, created_by, created_at, updated_at)
     VALUES (:id, :projectId, :type, :targetId, :topic, 'open', :dir, :actor, :now, :now)`,
    { id, projectId: project.id, type: input.targetType, targetId, topic, dir, actor: input.actor, now },
  );
  event(ws.db, { id, projectId: project.id }, 'handoff.created', input.actor, {
    targetType: input.targetType,
    targetId,
  });
  return getHandoff(ws.db, id);
}

export function setHandoffThread(
  db: Db,
  id: string,
  threadId: string,
  actor: string,
  now: number = Date.now(),
): Handoff {
  run(db, 'UPDATE handoffs SET thread_id = :threadId, updated_at = :now WHERE id = :id', {
    id,
    threadId,
    now,
  });
  const h = getHandoff(db, id);
  event(db, h, 'handoff.thread', actor, { threadId });
  return h;
}

export function closeHandoff(db: Db, id: string, actor: string, now: number = Date.now()): Handoff {
  getHandoff(db, id);
  run(db, `UPDATE handoffs SET status = 'closed', updated_at = :now WHERE id = :id`, { id, now });
  const h = getHandoff(db, id);
  event(db, h, 'handoff.closed', actor);
  return h;
}

// ---- the result --------------------------------------------------------------------------------------

/** The result file Codex writes in the discussion folder (or another file). */
export function readHandoffResultFile(ws: Workspace, h: Handoff, file?: string): unknown {
  const target = file ? path.resolve(file) : ws.abs(`${h.dir}/result.json`);
  if (!existsSync(target))
    throw new AniError('not_found', `No result file at ${target}`, {
      hint: `Write the conclusion to ${ws.abs(`${h.dir}/result.json`)} first (format in BRIEF.md).`,
    });
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    throw new AniError('usage', `${target} is not valid JSON: ${(error as Error).message}`);
  }
}

const ACTION_TYPES: readonly HandoffActionType[] = [
  'design.note',
  'design.generate',
  'board.generate',
  'take.generate',
  'take.still',
  'shot.mode',
  'shots.merge',
  'style.notes',
  'approve',
  'task.answer',
  'task.close',
];
const MODES: readonly ShotMode[] = ['replace', 'clean', 'keep', 'exclude'];

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Checks a result against the workspace: every action known, required fields present, every id existing in
 * this project. All problems are reported at once so Codex can fix the file inside the discussion.
 */
function parseResult(ws: Workspace, h: Handoff, raw: unknown, actor: string, now: number): HandoffResult {
  const db = ws.db;
  const problems: string[] = [];
  const r = (raw ?? {}) as { summary?: unknown; actions?: unknown; versions?: unknown };
  const summary = text(r.summary);
  if (!summary) problems.push('summary: write the conclusion for the human');
  if (r.actions !== undefined && !Array.isArray(r.actions)) problems.push('actions: must be an array');
  if (r.versions !== undefined && !Array.isArray(r.versions)) problems.push('versions: must be an array');
  const inProject = (projectId: string, what: string, at: string) => {
    if (projectId !== h.projectId) problems.push(`${at}: ${what} belongs to another project`);
  };
  const tryGet = <T>(at: string, get: () => T): T | undefined => {
    try {
      return get();
    } catch (error) {
      problems.push(`${at}: ${(error as Error).message}`);
      return undefined;
    }
  };
  const shotAt = (id: unknown, at: string) => {
    const ref = text(id);
    if (!ref) {
      problems.push(`${at}: missing shot id`);
      return undefined;
    }
    const shot = tryGet(at, () => getShot(db, ref));
    if (shot) inProject(projectOfShot(db, shot.id).id, ref, at);
    return shot;
  };
  const personaAt = (ref: unknown, at: string) => {
    const id = text(ref);
    if (!id) {
      problems.push(`${at}: missing persona`);
      return undefined;
    }
    const p = tryGet(at, () => getPersona(db, id));
    if (p && p.kind !== 'character') problems.push(`${at}: ${p.name} is not a character`);
    return p;
  };
  const taskAt = (ref: unknown, at: string) => {
    const id = text(ref);
    if (!id) {
      problems.push(`${at}: missing task id`);
      return undefined;
    }
    const t = tryGet(at, () => getAgentTask(db, id));
    if (t) inProject(t.projectId, id, at);
    return t;
  };
  const tierAt = (v: unknown, at: string): GenerationTier | undefined => {
    if (v === undefined) return undefined;
    if (!TIERS.includes(v as GenerationTier)) problems.push(`${at}: tier must be one of ${TIERS.join(', ')}`);
    return v as GenerationTier;
  };
  const versionOf = (id: string, at: string) => {
    if (id.startsWith('brd_')) {
      const b = tryGet(at, () => getBoard(db, id));
      if (b) inProject(projectOfShot(db, b.shotId).id, id, at);
      return (
        b && {
          kind: 'board' as const,
          shotId: b.shotId,
          label: `${shotNo(db, b.shotId)} 分鏡圖 v${b.version}`,
        }
      );
    }
    if (id.startsWith('tak_')) {
      const t = tryGet(at, () => getTake(db, id));
      if (t) inProject(projectOfShot(db, t.shotId).id, id, at);
      return (
        t && {
          kind: 'take' as const,
          shotId: t.shotId,
          label: `${shotNo(db, t.shotId)} 分鏡視頻 v${t.version}`,
        }
      );
    }
    if (id.startsWith('dsg_')) {
      const d = tryGet(at, () => getDesign(db, id));
      if (d) inProject(d.projectId, id, at);
      return (
        d && {
          kind: 'design' as const,
          shotId: null,
          label: `${getPersona(db, d.personaId).name} ${KIND_TEXT[d.kind]} v${d.version}`,
        }
      );
    }
    problems.push(`${at}: ${id} is not a board (brd_), take (tak_) or design (dsg_) id`);
    return undefined;
  };
  const extraText = (extra: string | undefined) => (extra ? `：${extra}` : '');

  const items: HandoffItem[] = [];
  for (const [i, a] of (
    (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  ).entries()) {
    const at = `actions[${i}]`;
    const type = a?.type as HandoffActionType;
    if (!ACTION_TYPES.includes(type)) {
      problems.push(`${at}.type: "${String(a?.type)}" is not one of ${ACTION_TYPES.join(', ')}`);
      continue;
    }
    const why = text(a.why);
    const extra = text(a.extra);
    const from = text(a.from);
    const base = { ...(why ? { why } : {}) };
    let item: HandoffItem | undefined;
    if (type === 'design.note') {
      const p = personaAt(a.persona, at);
      const note = typeof a.note === 'string' ? a.note.trim() : undefined;
      if (note === undefined) problems.push(`${at}.note: missing (an empty string clears the note)`);
      if (p && note !== undefined)
        item = {
          action: { type, persona: p.id, note, ...base },
          label: `${p.name} 的改編說明改成：${note || '（清空）'}`,
          paid: false,
        };
    } else if (type === 'design.generate') {
      const kind = a.kind as DesignKind | undefined;
      if (kind !== undefined && !DESIGN_KINDS.includes(kind))
        problems.push(`${at}.kind: must be one of ${DESIGN_KINDS.join(', ')}`);
      const d = from ? tryGet(`${at}.from`, () => getDesign(db, from)) : undefined;
      if (d && d.projectId !== h.projectId) problems.push(`${at}.from: ${from} belongs to another project`);
      const castRef = text(a.cast);
      const personaRef = text(a.persona);
      let bindings: Binding[] = [];
      if (d) bindings = [{ castMemberId: d.castMemberId ?? '', personaId: d.personaId }];
      else if (castRef || personaRef)
        bindings =
          tryGet(`${at}.${castRef ? 'cast' : 'persona'}`, () =>
            resolveBindings(db, h.projectId, (castRef ?? personaRef) as string),
          ) ?? [];
      else problems.push(`${at}: say which character: cast (original character id), persona or from`);
      if (bindings.length) {
        const names = bindings
          .map((b) => {
            const c = b.castMemberId ? getCastMember(db, b.castMemberId) : null;
            return `${c ? `「${c.label}」→ ` : ''}${getPersona(db, b.personaId).name}`;
          })
          .join('、');
        item = {
          action: {
            type,
            ...(castRef ? { cast: castRef } : {}),
            ...(personaRef ? { persona: personaRef } : {}),
            ...(kind ? { kind } : {}),
            ...(from ? { from } : {}),
            ...(extra ? { extra } : {}),
            ...base,
          },
          label: `${d ? `修正 ${names} 的${KIND_TEXT[d.kind]}（依 v${d.version}）` : `重新設計 ${names} 的${kind ? KIND_TEXT[kind] : '三張角色設計'}`}${extraText(extra)}`,
          paid: true,
        };
      }
    } else if (type === 'board.generate' || type === 'take.generate' || type === 'take.still') {
      const shot = shotAt(a.shot, `${at}.shot`);
      const tier = type === 'board.generate' ? undefined : tierAt(a.tier, `${at}.tier`);
      let base2: Board | Take | undefined;
      if (from && type === 'board.generate') base2 = tryGet(`${at}.from`, () => getBoard(db, from));
      if (from && type === 'take.generate') base2 = tryGet(`${at}.from`, () => getTake(db, from));
      if (base2 && shot && base2.shotId !== shot.id)
        problems.push(`${at}.from: ${from} is not a version of ${shot.id}`);
      if (shot) {
        const no = shotNo(db, shot.id);
        const what =
          type === 'board.generate' ? '分鏡圖' : type === 'take.generate' ? '分鏡視頻' : '靜態分鏡視頻';
        item = {
          action: {
            type,
            shot: shot.id,
            ...(from && type !== 'take.still' ? { from } : {}),
            ...(extra && type !== 'take.still' ? { extra } : {}),
            ...(tier ? { tier } : {}),
            ...base,
          } as HandoffAction,
          label: `${base2 ? `修正 ${no} 的${what}（依 v${base2.version}）` : `生成 ${no} 的${what}`}${tier ? `・${TIER_TEXT[tier]}` : ''}${type === 'take.still' ? '' : extraText(extra)}`,
          paid: PAID.has(type),
        };
      }
    } else if (type === 'shot.mode') {
      const shot = shotAt(a.shot, `${at}.shot`);
      const mode = a.mode as ShotMode;
      if (!MODES.includes(mode)) problems.push(`${at}.mode: must be one of ${MODES.join(', ')}`);
      else if (shot)
        item = {
          action: { type, shot: shot.id, mode, ...base },
          label: `${shotNo(db, shot.id)} 改成「${MODE_TEXT[mode]}」`,
          paid: false,
        };
    } else if (type === 'shots.merge') {
      const first = shotAt(a.first, `${at}.first`);
      const second = shotAt(a.second, `${at}.second`);
      if (first && second && (first.clipId !== second.clipId || second.orderIndex !== first.orderIndex + 1))
        problems.push(`${at}: ${first.id} and ${second.id} are not neighbours (second must follow first)`);
      const reason = text(a.reason);
      if (first && second)
        item = {
          action: { type, first: first.id, second: second.id, ...(reason ? { reason } : {}), ...base },
          label: `合併 ${shotNo(db, first.id)} 和 ${shotNo(db, second.id)}${reason ? `：${reason}` : ''}`,
          paid: false,
        };
    } else if (type === 'style.notes') {
      const t = typeof a.text === 'string' ? a.text.trim() : undefined;
      if (t === undefined) problems.push(`${at}.text: missing (an empty string clears it)`);
      else
        item = {
          action: { type, text: t, ...base },
          label: `項目的畫風說明改成：${t || '（清空）'}`,
          paid: false,
        };
    } else if (type === 'approve') {
      const target = text(a.target);
      if (!target) problems.push(`${at}.target: missing version id`);
      const v = target ? versionOf(target, `${at}.target`) : undefined;
      if (target && v) item = { action: { type, target, ...base }, label: `通過 ${v.label}`, paid: false };
    } else if (type === 'task.answer' || type === 'task.close') {
      const t = taskAt(a.task, `${at}.task`);
      const body = text(type === 'task.answer' ? a.answer : a.note);
      if (!body) problems.push(`${at}.${type === 'task.answer' ? 'answer' : 'note'}: missing`);
      if (t && type === 'task.answer' && t.status !== 'needs_user')
        problems.push(`${at}: task ${t.id} is not waiting for an answer`);
      if (t && body)
        item =
          type === 'task.answer'
            ? {
                action: { type, task: t.id, answer: body, ...base },
                label: `回覆任務 ${t.id}：${body}`,
                paid: false,
              }
            : {
                action: { type, task: t.id, note: body, ...base },
                label: `完成任務 ${t.id}：${body}`,
                paid: false,
              };
    }
    if (item) items.push(item);
  }
  const versions: HandoffResult['versions'] = [];
  for (const [i, v] of (
    (Array.isArray(r.versions) ? r.versions : []) as Array<Record<string, unknown>>
  ).entries()) {
    const id = text(v?.id);
    if (!id) {
      problems.push(`versions[${i}].id: missing`);
      continue;
    }
    const found = versionOf(id, `versions[${i}]`);
    if (found) versions.push({ id, ...found, note: text(v.note) ?? '' });
  }
  if (problems.length)
    throw new AniError(
      'usage',
      `result.json has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`,
      {
        details: { problems },
        hint: 'Fix result.json and run `anirecast codex submit` again.',
      },
    );
  return { summary: summary as string, items, versions, submittedBy: actor, submittedAt: now };
}

/** Stores Codex's conclusion (replacing an earlier one) for the human to import. */
export function submitHandoff(
  ws: Workspace,
  id: string,
  raw: unknown,
  actor: string,
  now: number = Date.now(),
): Handoff {
  const h = getHandoff(ws.db, id);
  if (h.status === 'closed') throw new AniError('conflict', 'This discussion is closed');
  const result = parseResult(ws, h, raw, actor, now);
  run(
    ws.db,
    `UPDATE handoffs SET status = 'submitted', result_json = :result, applied_json = NULL, updated_at = :now WHERE id = :id`,
    { id, result: toJson(result), now },
  );
  event(ws.db, h, 'handoff.submitted', actor, {
    actions: result.items.length,
    versions: result.versions.length,
    replacedApplied: h.applied.length,
  });
  return getHandoff(ws.db, id);
}

function applyOne(ws: Workspace, h: Handoff, a: HandoffAction, actor: string): string[] {
  const project = getProject(ws.db, h.projectId);
  const tier = (t?: GenerationTier) => t ?? project.generationTier;
  switch (a.type) {
    case 'design.note':
      setDesignNote(ws.db, project.id, a.persona, a.note, actor);
      return [a.persona];
    case 'design.generate':
      return queueDesign(ws, project.id, a.from ? null : (a.cast ?? a.persona ?? null), actor, {
        ...(a.kind ? { kind: a.kind } : {}),
        ...(a.extra ? { extra: a.extra } : {}),
        ...(a.from ? { fromDesignId: a.from } : {}),
      }).map((q) => q.design.id);
    case 'board.generate':
      return [
        queueBoard(ws, a.shot, actor, {
          ...(a.extra ? { extra: a.extra } : {}),
          ...(a.from ? { fromBoardId: a.from } : {}),
        }).board.id,
      ];
    case 'take.generate':
      return [
        queueTake(ws, a.shot, tier(a.tier), actor, {
          ...(a.extra ? { extra: a.extra } : {}),
          ...(a.from ? { fromTakeId: a.from } : {}),
        }).take.id,
      ];
    case 'take.still':
      return [queueStillTake(ws, a.shot, tier(a.tier), actor).take.id];
    case 'shot.mode':
      updateShot(ws.db, a.shot, { mode: a.mode }, actor);
      return [a.shot];
    case 'shots.merge': {
      const merged = mergeShots(
        ws.db,
        a.first,
        a.second,
        actor,
        Date.now(),
        a.reason ? { reason: a.reason } : {},
      );
      recomputeShotModes(ws.db, project.id);
      enqueueJob(ws.db, {
        type: 'shots.prepare',
        lane: 'media',
        projectId: project.id,
        payload: { shotIds: [merged.id] },
        requestedBy: actor,
      });
      return [merged.id];
    }
    case 'style.notes':
      updateProjectSettings(ws.db, project.id, { styleNotes: a.text || null }, actor);
      return [project.id];
    case 'approve':
      submitReview(ws, { targetId: a.target, verdict: 'approve', actor });
      return [a.target];
    case 'task.answer':
      return [answerAgentTask(ws.db, a.task, a.answer, actor).id];
    case 'task.close':
      return [completeAgentTask(ws.db, a.task, { note: a.note }, actor).id];
  }
}

/**
 * Imports the ticked actions (all by default) in order. Each succeeds or fails on its own; an action that
 * already succeeded is never run twice. Importing is the human's decision, so Codex cannot do it.
 */
export function applyHandoff(
  ws: Workspace,
  id: string,
  opts: { indices?: number[]; actor: string },
  now: number = Date.now(),
): Handoff {
  if (opts.actor.startsWith('codex:'))
    throw new AniError(
      'conflict',
      "Importing a discussion is the human's decision; Codex submits, the human imports",
    );
  const h = getHandoff(ws.db, id);
  if (h.status === 'closed') throw new AniError('conflict', 'This discussion is closed');
  if (!h.result) throw new AniError('conflict', 'Codex has not submitted a conclusion yet');
  const result = h.result;
  const done = new Set(h.applied.filter((x) => x.ok).map((x) => x.index));
  const indices = (opts.indices ?? result.items.map((_, i) => i)).filter((i) => !done.has(i));
  for (const i of indices)
    if (!result.items[i])
      throw new AniError('usage', `No action #${i + 1} (there are ${result.items.length})`);
  const outcomes: AppliedItem[] = [];
  for (const i of indices) {
    const item = result.items[i] as HandoffItem;
    try {
      const refs = tx(ws.db, () => applyOne(ws, h, item.action, opts.actor));
      outcomes.push({ index: i, ok: true, refs, error: null, by: opts.actor, at: now });
    } catch (error) {
      outcomes.push({
        index: i,
        ok: false,
        refs: [],
        error: (error as Error).message,
        by: opts.actor,
        at: now,
      });
    }
  }
  const applied = [...h.applied.filter((x) => !indices.includes(x.index)), ...outcomes].sort(
    (a, b) => a.index - b.index,
  );
  run(
    ws.db,
    `UPDATE handoffs SET status = 'imported', applied_json = :applied, updated_at = :now WHERE id = :id`,
    {
      id,
      applied: toJson(applied),
      now,
    },
  );
  event(ws.db, h, 'handoff.imported', opts.actor, {
    ok: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
  });
  return getHandoff(ws.db, id);
}
