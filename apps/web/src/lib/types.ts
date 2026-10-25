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
  Review,
  shotDetail,
  Take,
} from '@anirecast/core';

export type {
  AgentTask,
  AgentTaskStatus,
  AniEvent,
  AssignedBy,
  Board,
  CastMember,
  Clip,
  GenerationTier,
  InspectResult,
  Job,
  JobStatus,
  Keyframe,
  Look,
  LookPolicy,
  OverlayCategory,
  Persona,
  PersonaImage,
  PersonaView,
  Project,
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

export interface CostSummary {
  totalUsd: number;
  capUsd: number | null;
  breakdown: Array<{ model: string; tier: string | null; calls: number; usd: number }>;
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
