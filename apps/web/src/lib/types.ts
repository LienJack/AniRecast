/**
 * API shapes. Type-only imports from @anirecast/core: they are erased at build time, so no Node code
 * reaches the bundle. Never import values from core here (mirror constants in `labels.ts`).
 */
import type {
  AgentTask,
  Board,
  Job,
  LocalConfig,
  LockInfo,
  Manifest,
  projectOverview,
  projectSummaries,
  Review,
  shotDetail,
  Take,
} from '@anirecast/core';

export type {
  AgentTask,
  AgentTaskStatus,
  AniEvent,
  AssetKind,
  AssignedBy,
  Board,
  CastMember,
  Clip,
  GenerationTier,
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
} from '@anirecast/core';

export type ProjectOverview = ReturnType<typeof projectOverview>;
export type ProjectSummary = ReturnType<typeof projectSummaries>[number];
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
    codex: { autoDispatch: boolean };
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
  codex: { autoDispatch: boolean };
  quota: QuotaStatus[];
}
