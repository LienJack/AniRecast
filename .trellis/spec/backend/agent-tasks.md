# Agent Identity and Task Routing

> Who an actor is, what an agent may do, and which agent works on an agent task. Established by task
> `10-26-claude-takeover` (2026-10-26).

---

## Scenario: actor identity and agent task routing

### 1. Scope / Trigger

- Any code that records an actor, guards a human-only action (approve), creates or claims an `agent_tasks` row,
  or changes `apps/daemon/src/codex/dispatcher.ts`.
- Cross-layer: core (`events.ts`, `domain/agent-tasks.ts`, `domain/claude.ts`), daemon (dispatcher, `/api/settings`,
  `/api/reviews`, `/api/tasks/:id/handoff`), CLI (`tasks next|list|handoff`, `review request-changes --agent`), web.

### 2. Signatures

```ts
// packages/core/src/events.ts
actorFromEnv(env = process.env): string            // 'codex:<thread>' | 'claude' | 'user'
isAgentActor(actor: string): boolean               // codex:* or claude

// packages/core/src/domain/agent-tasks.ts
type RoutedTo = 'claude' | 'codex'
interface TaskRoute { to: RoutedTo; reasons: string[] }
presetRoute(payload, fallback: 'claude' | 'codex' | 'auto'): TaskRoute | null
createAgentTask(db, input, now?)                   // writes routedTo when presetRoute returns one
routeAgentTask(db, id, route, actor, { reopen?, extra? }, now?)
listAgentTasks(db, { status?, projectId?, shotId?, agent?: RoutedTo })
claimNextAgentTask(db, claimedBy, { kind?, agent?: RoutedTo }, now?)

// packages/core/src/domain/claude.ts
claudeCommand(workspaceRoot): string               // cd <ws> && claude "處理 AniRecast 待辦任務"
routeTask(ws, taskId, { cuts?, fallback? }): TaskRoute   // the `auto` judgement (people, cuts, rejections)
handOffToClaude(ws, taskId, input, actor, now?): { brief: string; command: string }
```

CLI: `anirecast tasks next|list [--for claude|codex|all]`, `anirecast review request-changes --agent claude|codex`.

### 3. Contracts

- **Env**: `CODEX_THREAD_ID` (set in a Codex turn) wins over `CLAUDECODE=1` (set by Claude Code's shell); neither →
  `user`. The dispatcher strips `CLAUDECODE` from the Codex app-server environment.
- **Config**: `agents.default: 'claude' | 'codex' | 'auto'` in `~/.config/anirecast/config.json`, default `claude`.
  `codex.autoDispatch` stays on: the dispatcher still serves tasks routed to Codex.
- **Payload**: `payload.agent?` (human's pick), `payload.routedTo?: RoutedTo`, `payload.routeReasons?: string[]`,
  `payload.handoff?` (brief path). Precedence in `presetRoute`: `handoff` → explicit `agent` → `agents.default`;
  `null` under `auto` (the dispatcher computes `routeTask`, scanning cuts only then).
- **Status**: a task waiting for its agent is `open`. Routing never asks the human (`askUser` is not part of routing).
- **API**: `GET /api/settings` → `agents: { default, claudeCommand }`. `POST /api/tasks/:id/handoff` →
  `{ brief, command }`. Events: `agent_task.created` carries `routedTo`; new `agent_task.routed` carries `to`, `reasons`.
- **CLI default `--for`**: `claude` actor → `claude`; `codex:*` → `codex`; `user` → all.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| `isAgentActor(actor)` approves a board / take / design | `AniError('conflict')` (agents recommend, never approve) |
| `codex:*` claims a task with `routedTo === 'claude'` | `AniError('conflict')` |
| Handoff on a `done` / `cancelled` task | `AniError('conflict')` |
| Handoff on a `claimed` / `needs_user` task | reopened: `open`, claim cleared, `routedTo: 'claude'` |
| Codex turn ends, task still `claimed` but `claimedBy !== 'dispatcher'` | dispatcher leaves it alone |
| `agents.default: 'auto'` and dispatcher off | tasks stay unrouted; only `--for all` / `user` sees them |

### 5. Good / Base / Bad Cases

- Good: web review with no pick → `open`, `routedTo: 'claude'`; Claude runs `tasks next` (no flag) and gets it.
- Base: human picks Codex → `routedTo: 'codex'` → dispatcher claims it as `dispatcher`.
- Bad: Codex runs `tasks handoff` mid-turn, Claude claims, the turn ends → must stay Claude's claim, not `needs_user`.

### 6. Tests Required

- `packages/core/test/agent-tasks.test.ts`: filtered claim by `routedTo`; Codex refused on a Claude task; `auto` uses
  the old difficulty rules.
- `packages/core/test/{boards,designs}.test.ts`: `claude` cannot approve; design `--agent codex` → `routedTo: 'codex'`.
- `apps/daemon/test/dispatcher.test.ts`: dispatcher claims only Codex's tasks; a task handed to Claude during a turn
  and claimed by Claude is not touched when the turn ends (`MOCK_HANDOFF=1` in the mock app-server).

### 7. Wrong vs Correct

#### Wrong

```ts
if (actor.startsWith('codex:')) throw new AniError('conflict', '…');   // claude slips through
if (after.status === 'claimed') askUser(db, task.id, '…', ACTOR);        // may be Claude's claim now
```

#### Correct

```ts
if (isAgentActor(actor)) throw new AniError('conflict', '…');
if (after.status === 'claimed' && after.claimedBy === ACTOR) askUser(db, task.id, '…', ACTOR);
```
