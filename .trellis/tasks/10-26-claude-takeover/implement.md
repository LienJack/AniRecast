# Implement：Claude 全局接管

## 分工（兩個 trellis-implement 子代理平行，檔案不重疊）

**A：身分、分派、領取（handoff 第 1–5、8 節）**

- `packages/core/src/events.ts`、`config.ts`、`domain/{generation,designs,cast,overlays,handoffs,boundaries,identity,versions,claude,agent-tasks}.ts`
- `apps/daemon/src/codex/dispatcher.ts`、`apps/daemon/src/api/routes.ts`
- `packages/cli/src/commands/generate.ts`（`tasks next|list|handoff`）
- 測試：`apps/daemon/test/**`、`packages/core/test/**` 中與上述相關的

**B：網頁與 Claude 入口（handoff 第 6–7 節）**

- `apps/web/**`
- `packages/cli/src/commands/setup.ts`、`doctor.ts`
- `skills/anirecast/SKILL.md`
- `packages/core/src/workspace.ts`、`packages/core/src/agents-md.ts`
- 測試：與上述相關的

兩邊依 `design.md` 的契約對齊（`payload.routedTo`、`/api/settings` 的 `agents`、`claudeCommand`）。

## 步驟

1. [A] `actorFromEnv` 認 `CLAUDECODE`；共用的代理人判斷；依身分的規則逐一處理並加註。
2. [A] `config.agents.default`；`routeTask` 改成依明確指定 → 預設 → auto 判斷；刪掉 `p.handoff → codex`。
3. [A] 建立任務時寫入 `routedTo`；`handOffToClaude` 不問人類、放回 `open`。
4. [A] `listAgentTasks` / `claimNextAgentTask` / `claimAgentTask` 的代理人篩選與檢查；CLI `--for`。
5. [A] dispatcher：補分派、只領 Codex 的、非 auto 時跳過 `sceneChanges`；`/api/settings` 加 `agents`。
6. [A] 測試：改 `take-director.test.ts` 的預期；新增 routedTo 篩選、Claude 不能通過、auto 仍走舊判斷。
7. [B] 網頁：版本工作列、`AgentPick`、任務中心、總覽。
8. [B] `setup` / `doctor` 的 Claude skill 連結；SKILL.md；Workspace `CLAUDE.md`。
9. [主] 全量 `set -o pipefail; pnpm -s check`；trellis-check 審查；分 commit。
10. [主] 建立 `~/.claude/skills/anirecast` symlink（`anirecast setup`）；確認 daemon 閒置後重啟；`pnpm --filter @anirecast/web build`；驗收。

## 驗證指令

- `set -o pipefail; pnpm -s check`
- 子代理平行期間只跑自己範圍的型別檢查與測試；別人負責的檔案出錯時回報，不要修。

## Review gate / 回滾點

- 每個子代理完成後主代理看 diff、跑全量 check 再 commit。
- daemon 重啟前用 until 迴圈確認：`activeJobs` 空、`codex.busyTaskIds` 空、queued/running 工作 0、claimed 任務 0。
- 回滾：`git revert` 對應 commit，重啟 daemon、重新 build 網頁。
