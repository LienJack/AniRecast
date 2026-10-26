import type {
  AgentTaskStatus,
  AssignedBy,
  GenerationTier,
  JobStatus,
  LookPolicy,
  OverlayCategory,
  PersonaView,
  ShotMode,
  ShotStage,
  Verdict,
  VersionStatus,
} from './types';

/** Mirrors of core constants (core is type-only in the bundle). */
export const TIERS: readonly GenerationTier[] = ['draft', 'preview', 'final'];
export const SHOT_MODES: readonly ShotMode[] = ['replace', 'clean', 'keep', 'exclude'];
export const PERSONA_VIEWS: readonly PersonaView[] = [
  'front',
  'side',
  'back',
  'face',
  'full',
  'sheet',
  'other',
];
export const OVERLAY_CATEGORIES: readonly OverlayCategory[] = ['staff_credit', 'title_or_other', 'in_scene'];
/** Omni accepts at most 10 s per request; longer shots are generated in segments. */
export const OMNI_MAX_SECONDS = 10;

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted' | 'accent';

export const TIER_LABEL: Record<GenerationTier, string> = {
  draft: '草稿 360p',
  preview: '預覽 720p',
  final: '正式 1080p',
};

export const MODE_LABEL: Record<ShotMode, string> = {
  replace: '換角',
  clean: '去字',
  keep: '沿用原片',
  exclude: '排除',
};

export const MODE_TONE: Record<ShotMode, Tone> = {
  replace: 'accent',
  clean: 'info',
  keep: 'neutral',
  exclude: 'muted',
};

export const STAGE_LABEL: Record<ShotStage, string> = {
  keep: '沿用原片',
  excluded: '已排除',
  board_pending: '待生成分鏡圖',
  board_generating: '分鏡圖生成中',
  board_review: '分鏡圖待評審',
  take_pending: '待生成分鏡視頻',
  take_generating: '分鏡視頻生成中',
  take_review: '分鏡視頻待評審',
  approved: '已通過',
  failed: '生成失敗',
  stale: '已過期',
};

export const STAGE_TONE: Record<ShotStage, Tone> = {
  keep: 'neutral',
  excluded: 'muted',
  board_pending: 'neutral',
  board_generating: 'info',
  board_review: 'warning',
  take_pending: 'neutral',
  take_generating: 'info',
  take_review: 'warning',
  approved: 'success',
  failed: 'danger',
  stale: 'danger',
};

export const STAGE_ORDER: readonly ShotStage[] = [
  'board_pending',
  'board_generating',
  'board_review',
  'take_pending',
  'take_generating',
  'take_review',
  'approved',
  'failed',
  'stale',
  'keep',
  'excluded',
];

export const VERSION_STATUS_LABEL: Record<VersionStatus, string> = {
  queued: '排隊中',
  generating: '生成中',
  ready: '待評審',
  approved: '已通過',
  rejected: '要求修改',
  failed: '失敗',
  stale: '已過期',
};

export const VERSION_STATUS_TONE: Record<VersionStatus, Tone> = {
  queued: 'neutral',
  generating: 'info',
  ready: 'warning',
  approved: 'success',
  rejected: 'danger',
  failed: 'danger',
  stale: 'muted',
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  approve: '通過',
  changes: '要求修改',
  regenerate: '直接重生',
  keep_original: '沿用原片',
};

export const VERDICT_TONE: Record<Verdict, Tone> = {
  approve: 'success',
  changes: 'danger',
  regenerate: 'info',
  keep_original: 'neutral',
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: '排隊中',
  running: '執行中',
  succeeded: '完成',
  failed: '失敗',
  cancelled: '已取消',
};

export const JOB_STATUS_TONE: Record<JobStatus, Tone> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'muted',
};

const JOB_TYPE_LABEL: Record<string, string> = {
  'source.download': '下載影片',
  'source.import': '匯入影片',
  'clip.extract': '輸出節選',
  'shots.detect': '分鏡偵測',
  'shots.prepare': '分鏡關鍵幀',
  'shots.analyze': '分鏡分析',
  'cast.identify': '同一人識別',
  'board.generate': '生成分鏡圖',
  'take.generate': '生成分鏡視頻',
  'take.still': '分鏡圖轉靜態視頻',
  'design.generate': '生成角色設計',
  'design.analyze': '原片角色分析',
  'cast.tidy': '整理角色（JEV）',
  'project.style': '畫風與光影分析',
  'shots.continuity': '切點判斷',
  'render.compose': '合成成片',
  noop: '測試任務',
};

export const jobTypeLabel = (type: string): string => JOB_TYPE_LABEL[type] ?? type;

export const LANE_LABEL: Record<string, string> = {
  generate: '生成',
  media: '媒體',
  agent: 'Agent',
  io: '下載／匯入',
};

export const TASK_STATUS_LABEL: Record<AgentTaskStatus, string> = {
  open: '排隊中',
  claimed: 'Codex 處理中',
  done: '完成',
  needs_user: '需要你回覆',
  cancelled: '已取消',
};

export const TASK_STATUS_TONE: Record<AgentTaskStatus, Tone> = {
  open: 'neutral',
  claimed: 'info',
  done: 'success',
  needs_user: 'warning',
  cancelled: 'muted',
};

export const TASK_KIND_LABEL: Record<string, string> = {
  review_feedback: '評審意見',
  cast_review: '同一人識別判斷',
  shot_review: '分鏡切點判斷',
};

export const TARGET_TYPE_LABEL: Record<string, string> = {
  board: '分鏡圖',
  take: '分鏡視頻',
  design: '角色設計',
};

export const OVERLAY_LABEL: Record<OverlayCategory, string> = {
  staff_credit: '工作人員字幕',
  title_or_other: '片名與其他疊字',
  in_scene: '場景內文字',
};

export const ASSIGNED_BY_LABEL: Record<AssignedBy, string> = {
  auto: '程式',
  codex: 'AI（Codex／JEV）',
  user: '你（鎖定）',
};

export const LOOK_POLICY_LABEL: Record<LookPolicy, string> = {
  persona: '用人設的服裝與髮型',
  follow_source: '跟原片走（只換臉和特徵）',
};

export const PERSONA_VIEW_LABEL: Record<PersonaView, string> = {
  front: '正面',
  side: '側面',
  back: '背面',
  face: '臉部特寫',
  full: '全身',
  sheet: '設定表',
  other: '其他',
};

export const SOURCE_STATUS_LABEL: Record<string, string> = {
  pending: '等待中',
  downloading: '下載中',
  ready: '可用',
  failed: '失敗',
  trashed: '已刪除',
};

export const SOURCE_STATUS_TONE: Record<string, Tone> = {
  pending: 'neutral',
  downloading: 'info',
  ready: 'success',
  failed: 'danger',
  trashed: 'muted',
};

export const RENDER_STATUS_LABEL: Record<string, string> = {
  queued: '排隊中',
  rendering: '合成中',
  ready: '完成',
  failed: '失敗',
};

export const RENDER_STATUS_TONE: Record<string, Tone> = {
  queued: 'neutral',
  rendering: 'info',
  ready: 'success',
  failed: 'danger',
};

/** `user`, `system`, `daemon`, `dispatcher`, `codex:<thread>` → readable. */
export function actorLabel(actor: string | null | undefined): string {
  if (!actor) return '—';
  if (actor === 'user') return '你';
  if (actor.startsWith('codex')) return 'Codex';
  if (actor === 'daemon' || actor === 'system' || actor === 'dispatcher') return '系統';
  return actor;
}
