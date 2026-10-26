/**
 * API shapes. Type-only imports from @anirecast/core: they are erased at build time, so no Node code
 * reaches the bundle. Never import values from core here (mirror constants in `labels.ts`).
 */
import type {
  AgentTask,
  Board,
  designOverview,
  Handoff,
  ImageModelSpec,
  Job,
  LocalConfig,
  LockInfo,
  Manifest,
  ProjectModels,
  projectOverview,
  projectSummaries,
  Review,
  shotDetail,
  Take,
  VideoModelSpec,
} from '@anirecast/core';

export type {
  AgentTask,
  AgentTaskStatus,
  AnalysisItem,
  AniEvent,
  AssetKind,
  AssignedBy,
  Board,
  BoardRole,
  CastAnalysis,
  CastMember,
  CastReference,
  Clip,
  Design,
  DesignKind,
  GenerationTier,
  Handoff,
  HandoffResult,
  HandoffStatus,
  HandoffTarget,
  ImageModelSpec,
  InspectResult,
  Job,
  JobStatus,
  KeyedProvider,
  Keyframe,
  Look,
  LookPolicy,
  OverlayCategory,
  Persona,
  PersonaImage,
  PersonaView,
  Project,
  ProjectModels,
  ProjectStep,
  Render,
  Review,
  Shot,
  ShotMode,
  ShotStage,
  Source,
  Take,
  TextOverlay,
  Tracklet,
  Verdict,
  VersionStatus,
  VideoModelSpec,
} from '@anirecast/core';

export type ProjectOverview = ReturnType<typeof projectOverview>;
export type ProjectSummary = ReturnType<typeof projectSummaries>[number];
export type DesignOverview = ReturnType<typeof designOverview>;
export type BindingDesigns = DesignOverview['bindings'][number];
export type UnboundCast = DesignOverview['unbound'][number];
export type OverviewShot = ProjectOverview['shots'][number];
export type ShotDetail = ReturnType<typeof shotDetail>;
export type ShotCastEntry = ShotDetail['cast'][number];
export type WithReviews<T> = T & { reviews: Review[] };

export interface WorkspaceInfo {
  root: string;
  manifest: Manifest;
  lock: LockInfo | null;
  latestEventSeq: number;
  config: {
    provider: LocalConfig['provider'] | string;
    models: LocalConfig['models'];
    budget: LocalConfig['budget'];
    codex: { autoDispatch: boolean; model: string | null; effort: string | null };
    recentWorkspaces: string[];
  };
  spend: { totalUsd: number };
}

export interface CodexStatus {
  enabled: boolean;
  codex?: { command: string; version: string | null; source: string } | null;
  projectId?: string | null;
  busyTaskId?: string | null;
  lastError?: string | null;
  rateLimits?: unknown;
}

export interface Health {
  version: string;
  pid: number;
  startedAt: number;
  workspace: { root: string; id: string; name: string };
  activeJobs: Array<{ id: string; type: string; lane: string }>;
  codex: CodexStatus;
}

export interface QuotaStatus {
  model: string;
  /** null = this model has no daily limit configured. */
  limit: number | null;
  used: number;
  pending: number;
  remaining: number | null;
  exhausted: boolean;
  dayStart: number;
  resetsAt: number;
}

export interface CostSummary {
  totalUsd: number;
  capUsd: number | null;
  breakdown: Array<{ model: string; tier: string | null; calls: number; usd: number }>;
  /** Today's requests per model, workspace-wide (blocked requests count against the quota). */
  quota?: QuotaStatus[];
}

export interface QueueResult<T> {
  queued: Array<T & { job: Job }>;
  errors: Array<{ shotId: string; error: { code: string; message: string; hint?: string } }>;
}

export type BoardQueue = QueueResult<{ board: Board }>;
export type TakeQueue = QueueResult<{ take: Take }>;

export type ReviewResult = {
  review: Review;
  task?: AgentTask;
  queued?: { board?: Board; take?: Take; jobId: string };
};

/** `/api/settings`: what is configured; key values never leave the daemon. */
export interface SettingsInfo {
  keys: Array<{ provider: 'gemini' | 'fal' | 'jev'; label: string; source: 'env' | 'keychain' | 'missing' }>;
  jevBaseUrl: string;
  models: LocalConfig['models'];
  limits: LocalConfig['limits'];
  continuity: LocalConfig['continuity'];
  budget: LocalConfig['budget'];
  codex: { autoDispatch: boolean; model: string | null; effort: string | null };
  quota: QuotaStatus[];
}

/** `GET /api/codex/:id`: a Codex discussion with what the page needs around it. */
export interface DiscussionView {
  handoff: Handoff;
  prompt: string;
  folder: string;
  resultFileExists: boolean;
  targetShotId: string | null;
  threadId?: string | null;
  openError?: string | null;
}

/** `GET /api/models`: what can be chosen, and the workspace defaults. */
export interface ModelCatalogue {
  image: ImageModelSpec[];
  video: VideoModelSpec[];
  defaults: ProjectModels & Record<string, string>;
}
