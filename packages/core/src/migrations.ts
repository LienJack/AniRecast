import { AniError } from '@anirecast/shared';
import type { Db } from './db.ts';

interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Rebuilds tables (SQLite cannot change a CHECK in place). Runs with foreign keys off, as SQLite's
   * documented procedure requires, and checks them before switching them back on.
   */
  rebuildsTables?: boolean;
}

/** Times are epoch milliseconds. Paths are workspace-relative POSIX strings. */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE workspace_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  url TEXT,
  site TEXT,
  title TEXT NOT NULL,
  uploader TEXT,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  fps_num INTEGER,
  fps_den INTEGER,
  file_path TEXT,
  info_path TEXT,
  thumb_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'downloading', 'ready', 'failed', 'trashed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX sources_url ON sources(url) WHERE url IS NOT NULL AND status != 'trashed';

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  generation_tier TEXT NOT NULL DEFAULT 'draft' CHECK (generation_tier IN ('draft', 'preview', 'final')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  in_frame INTEGER NOT NULL,
  out_frame INTEGER NOT NULL,
  fps_num INTEGER NOT NULL,
  fps_den INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  frame_count INTEGER NOT NULL,
  file_path TEXT,
  audio_path TEXT,
  proxy_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE shots (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id),
  order_index INTEGER NOT NULL,
  start_frame INTEGER NOT NULL,
  end_frame INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'keep' CHECK (mode IN ('replace', 'clean', 'keep', 'exclude')),
  mode_source TEXT NOT NULL DEFAULT 'auto' CHECK (mode_source IN ('auto', 'user')),
  remove_other_overlays INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'detected',
  rep_frame INTEGER NOT NULL,
  description TEXT,
  camera_json TEXT,
  source_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (end_frame >= start_frame)
);
CREATE INDEX shots_clip ON shots(clip_id, order_index);

CREATE TABLE keyframes (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  frame INTEGER NOT NULL,
  role TEXT NOT NULL,
  path TEXT NOT NULL
);
CREATE INDEX keyframes_shot ON keyframes(shot_id);

CREATE TABLE text_overlays (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  keyframe_id TEXT REFERENCES keyframes(id) ON DELETE SET NULL,
  bbox_json TEXT NOT NULL,
  text TEXT,
  category TEXT NOT NULL CHECK (category IN ('staff_credit', 'title_or_other', 'in_scene')),
  remove INTEGER NOT NULL,
  decided_by TEXT NOT NULL DEFAULT 'auto' CHECK (decided_by IN ('auto', 'codex', 'user'))
);
CREATE INDEX text_overlays_shot ON text_overlays(shot_id);

CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE persona_images (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  path TEXT NOT NULL,
  view TEXT NOT NULL DEFAULT 'other',
  is_primary INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX persona_images_persona ON persona_images(persona_id);

CREATE TABLE cast_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  thumb_path TEXT,
  persona_id TEXT REFERENCES personas(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'not_a_character', 'merged')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cast_members_project ON cast_members(project_id);

CREATE TABLE looks (
  id TEXT PRIMARY KEY,
  cast_member_id TEXT NOT NULL REFERENCES cast_members(id),
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  representative_tracklet_id TEXT,
  look_policy TEXT NOT NULL DEFAULT 'persona' CHECK (look_policy IN ('persona', 'follow_source'))
);
CREATE INDEX looks_cast ON looks(cast_member_id);

CREATE TABLE tracklets (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  cast_member_id TEXT REFERENCES cast_members(id),
  look_id TEXT REFERENCES looks(id),
  identity_vec BLOB,
  appearance_vec BLOB,
  confidence REAL,
  assigned_by TEXT NOT NULL DEFAULT 'auto' CHECK (assigned_by IN ('auto', 'codex', 'user'))
);
CREATE INDEX tracklets_shot ON tracklets(shot_id);
CREATE INDEX tracklets_cast ON tracklets(cast_member_id);

CREATE TABLE detections (
  id TEXT PRIMARY KEY,
  tracklet_id TEXT NOT NULL REFERENCES tracklets(id) ON DELETE CASCADE,
  keyframe_id TEXT REFERENCES keyframes(id) ON DELETE SET NULL,
  frame INTEGER NOT NULL,
  head_bbox_json TEXT,
  body_bbox_json TEXT,
  attrs_json TEXT NOT NULL DEFAULT '{}',
  head_crop_path TEXT,
  body_crop_path TEXT
);
CREATE INDEX detections_tracklet ON detections(tracklet_id);

CREATE TABLE cast_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('must_link', 'cannot_link', 'assign', 'not_a_character')),
  tracklet_a TEXT REFERENCES tracklets(id),
  tracklet_b TEXT REFERENCES tracklets(id),
  cast_member_id TEXT REFERENCES cast_members(id),
  source TEXT NOT NULL CHECK (source IN ('codex', 'user')),
  locked INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  confidence REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX cast_decisions_project ON cast_decisions(project_id);

CREATE TABLE shot_cast_overrides (
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  cast_member_id TEXT NOT NULL REFERENCES cast_members(id),
  persona_id TEXT REFERENCES personas(id),
  keep INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shot_id, cast_member_id)
);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'ready', 'approved', 'rejected', 'failed', 'stale')),
  path TEXT,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  inputs_json TEXT NOT NULL DEFAULT '[]',
  parent_id TEXT REFERENCES boards(id),
  remote_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (shot_id, version)
);

CREATE TABLE takes (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  version INTEGER NOT NULL,
  board_id TEXT REFERENCES boards(id),
  tier TEXT NOT NULL CHECK (tier IN ('draft', 'preview', 'final')),
  segment_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'ready', 'approved', 'rejected', 'failed', 'stale')),
  path TEXT,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  inputs_json TEXT NOT NULL DEFAULT '[]',
  parent_id TEXT REFERENCES takes(id),
  remote_json TEXT NOT NULL DEFAULT '{}',
  frames_in INTEGER,
  frames_out INTEGER,
  conform_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (shot_id, version)
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('board', 'take', 'render')),
  target_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'changes', 'regenerate', 'keep_original')),
  comment TEXT,
  annotations_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reviews_target ON reviews(target_type, target_id);

CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('review_feedback', 'cast_review')),
  review_id TEXT REFERENCES reviews(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT REFERENCES shots(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'done', 'needs_user', 'cancelled')),
  claimed_by TEXT,
  claimed_at INTEGER,
  question TEXT,
  answer TEXT,
  result_note TEXT,
  result_target_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX agent_tasks_status ON agent_tasks(status, created_at);

CREATE TABLE codex_threads (
  scope TEXT NOT NULL CHECK (scope IN ('shot', 'project_cast')),
  scope_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE codex_usage (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES agent_tasks(id),
  thread_id TEXT NOT NULL,
  tokens_json TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('generate', 'media', 'agent', 'io')),
  project_id TEXT REFERENCES projects(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  progress REAL NOT NULL DEFAULT 0,
  message TEXT,
  result_json TEXT,
  error_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL,
  cost_actual REAL,
  requested_by TEXT NOT NULL,
  worker_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX jobs_queue ON jobs(lane, status, created_at);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  project_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE daemon_heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host TEXT NOT NULL,
  pid INTEGER NOT NULL,
  version TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE renders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('draft', 'final')),
  tier TEXT NOT NULL CHECK (tier IN ('draft', 'preview', 'final')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  path TEXT,
  compare_path TEXT,
  compare_proxy_path TEXT,
  shots_snapshot_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE cost_ledger (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  project_id TEXT REFERENCES projects(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}',
  usd REAL NOT NULL,
  at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'provider request log',
    // Every request sent to a model, paid or not: blocked requests cost nothing but still use the daily quota.
    sql: `
CREATE TABLE provider_requests (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video_edit', 'vision')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'blocked', 'rejected', 'rate_limited', 'error')),
  detail TEXT,
  job_id TEXT REFERENCES jobs(id),
  project_id TEXT REFERENCES projects(id),
  shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL
);
CREATE INDEX provider_requests_model_at ON provider_requests(model, at);
CREATE INDEX provider_requests_shot ON provider_requests(shot_id);
`,
  },
  {
    version: 3,
    name: 'shot boundaries and shot review tasks',
    rebuildsTables: true,
    sql: `
CREATE TABLE agent_tasks_v3 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('review_feedback', 'cast_review', 'shot_review')),
  review_id TEXT REFERENCES reviews(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT REFERENCES shots(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'done', 'needs_user', 'cancelled')),
  claimed_by TEXT,
  claimed_at INTEGER,
  question TEXT,
  answer TEXT,
  result_note TEXT,
  result_target_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO agent_tasks_v3 SELECT * FROM agent_tasks;
DROP TABLE agent_tasks;
ALTER TABLE agent_tasks_v3 RENAME TO agent_tasks;
CREATE INDEX agent_tasks_status ON agent_tasks(status, created_at);

CREATE TABLE codex_threads_v3 (
  scope TEXT NOT NULL CHECK (scope IN ('shot', 'project_cast', 'project_shots')),
  scope_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
INSERT INTO codex_threads_v3 SELECT * FROM codex_threads;
DROP TABLE codex_threads;
ALTER TABLE codex_threads_v3 RENAME TO codex_threads;

-- One row per cut (at_frame = first frame of the later shot, clip numbering): whether the two sides belong to
-- one continuous moment, and who decided. User decisions are locked; judges never override them.
CREATE TABLE shot_boundaries (
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  at_frame INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('same_moment', 'cut')),
  confidence REAL,
  reason TEXT,
  decided_by TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  sheet_path TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (clip_id, at_frame)
);
`,
  },
  {
    version: 4,
    name: 'asset kinds in the library',
    // The shared library holds characters (personas), items and scenes; existing entries are characters.
    sql: `
ALTER TABLE personas ADD COLUMN kind TEXT NOT NULL DEFAULT 'character' CHECK (kind IN ('character', 'item', 'scene'));
CREATE INDEX personas_kind ON personas(kind, archived);
`,
  },
  {
    version: 5,
    name: 'character design sheets, shot lighting, take segments',
    rebuildsTables: true,
    sql: `
CREATE TABLE reviews_v5 (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('board', 'take', 'render', 'design')),
  target_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'changes', 'regenerate', 'keep_original')),
  comment TEXT,
  annotations_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO reviews_v5 SELECT * FROM reviews;
DROP TABLE reviews;
ALTER TABLE reviews_v5 RENAME TO reviews;
CREATE INDEX reviews_target ON reviews(target_type, target_id);

-- A library character redrawn for one project in that animation's style: turnaround, expressions, poses.
CREATE TABLE designs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  persona_id TEXT NOT NULL REFERENCES personas(id),
  kind TEXT NOT NULL CHECK (kind IN ('turnaround', 'expressions', 'poses')),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'ready', 'approved', 'rejected', 'failed', 'stale')),
  path TEXT,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  inputs_json TEXT NOT NULL DEFAULT '[]',
  parent_id TEXT REFERENCES designs(id),
  remote_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, persona_id, kind, version)
);
CREATE INDEX designs_project ON designs(project_id, persona_id, kind);

-- How a project adapts a library character (e.g. "covered shoulders, looser cut"); the library is untouched.
CREATE TABLE project_personas (
  project_id TEXT NOT NULL REFERENCES projects(id),
  persona_id TEXT NOT NULL REFERENCES personas(id),
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, persona_id)
);

ALTER TABLE shots ADD COLUMN lighting TEXT;
-- Takes generated together in one request (consecutive shots edited as one segment) share an id.
ALTER TABLE takes ADD COLUMN segment_id TEXT;
`,
  },
  {
    version: 6,
    name: 'codex discussions',
    // A hard problem taken to its own multi-round Codex conversation. The conclusion comes back as actions the
    // human ticks and imports. target_type has no CHECK: new kinds of things to discuss keep coming.
    sql: `
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  target_type TEXT NOT NULL,
  target_id TEXT,
  topic TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'submitted', 'imported', 'closed')),
  dir TEXT NOT NULL,
  thread_id TEXT,
  result_json TEXT,
  applied_json TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX handoffs_project ON handoffs(project_id, status);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/** Applies pending migrations in one transaction each. Only the daemon and `workspace init` call this. */
export function migrate(db: Db): { from: number; to: number } {
  const from = schemaVersion(db);
  if (from > LATEST_SCHEMA_VERSION) {
    throw new AniError(
      'schema_mismatch',
      `Workspace schema v${from} is newer than this AniRecast (v${LATEST_SCHEMA_VERSION})`,
      {
        hint: 'Update AniRecast before opening this workspace.',
      },
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    if (m.rebuildsTables) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      if (m.rebuildsTables) {
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length > 0)
          throw new Error(`foreign key check failed: ${JSON.stringify(broken.slice(0, 3))}`);
      }
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new AniError('internal', `Migration ${m.version} (${m.name}) failed`, { cause: error });
    } finally {
      if (m.rebuildsTables) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return { from, to: schemaVersion(db) };
}

/** CLI-side check: the CLI never migrates a live workspace; the daemon does. */
export function assertCurrentSchema(db: Db): void {
  const version = schemaVersion(db);
  if (version === LATEST_SCHEMA_VERSION) return;
  throw new AniError(
    'schema_mismatch',
    version > LATEST_SCHEMA_VERSION
      ? `Workspace schema v${version} is newer than this AniRecast (v${LATEST_SCHEMA_VERSION})`
      : `Workspace schema v${version} needs migration to v${LATEST_SCHEMA_VERSION}`,
    {
      hint:
        version > LATEST_SCHEMA_VERSION
          ? 'Update AniRecast.'
          : 'Start the AniRecast daemon (anirecast serve); it migrates on open.',
    },
  );
}
