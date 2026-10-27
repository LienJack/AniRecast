# PRD：Claude 全局接管

來源：`handoff.md`（2026-10-26，人類已決定的事不再問）。

## 目標

評審意見與其他 agent 任務預設交給 Claude，在 Claude Code TUI 裡由人類說「處理任務」逐一處理；Codex 只接人類在網頁手動指定的任務。

## 需求

1. **身分**：在 Claude Code shell（`CLAUDECODE=1`）執行的 CLI，操作者記為 `claude`，不再記成 `user`。
2. **不替人類通過**：`claude` 跟 `codex:` 一樣不能按分鏡圖、影片、設計圖的「通過」。Claude 的決定不鎖定，人類可改。
3. **等 Claude 的任務維持 `open`**：分派結果寫在 `payload.routedTo`（`claude` | `codex`）與 `payload.routeReasons`，不再呼叫 `askUser` 讓任務變成 `needs_user`；人類回答後也不會退回 Codex。
4. **分派順序**：人類明確指定的 `agent` → 設定 `agents.default`（預設 `claude`，所有任務種類都歸 Claude）→ 設定為 `auto` 時才用原本的難度判斷（3 人以上、鏡頭內有切鏡、退回 2 次以上）。
5. **Codex 仍能接手動指定的任務**：`codex.autoDispatch` 不關；dispatcher 只領 `routedTo === 'codex'` 的任務，Codex 不能領 `routedTo === 'claude'` 的任務。
6. **CLI 領取**：`tasks next` / `tasks list` 加 `--for claude|codex`，預設依操作者（`claude` → Claude 的、`codex:` → Codex 的、`user` → 全部）。
7. **網頁**：顯示「等 Claude 處理」與一個通用的複製指令；`AgentPick` 的預設選項標示為 Claude；任務中心與總覽顯示等 Claude 的任務數量與指令。
8. **Claude 入口**：`~/.claude/skills/anirecast` symlink（`anirecast setup` 會建、`doctor` 會檢查）；SKILL.md 加中文觸發詞與「從 Claude Code 操作」一節；Workspace 產生 `CLAUDE.md`（`@AGENTS.md` + Claude 專用說明）。
9. **部署**：daemon 在確認閒置後重啟；網頁重新 build。

## 驗收

- `set -o pipefail; pnpm -s check` 全過（目前 116 個測試），新增測試涵蓋：依 `routedTo` 篩選領取、Claude 不能按通過、預設 `auto` 時仍走原本判斷。
- 在網頁對一個版本留評審意見 → 任務 `open`、`routedTo: claude`，Codex 不會領。
- 在 Claude TUI（cwd 在 mediaHub）說「處理任務」→ `tasks next --for claude` 能領到、做完、`tasks done`。
- 網頁手動選 Codex → Codex 會接。

## 不做

- 不做 daemon 用 `claude -p` 背景自動處理。
- 不做 `cast_decisions.source` 的 migration（沿用 `'codex'` 代表代理人）。
- push 前要先問人類。

## 附帶：Serpent 資產管理研究（清單第 24 項）

研究結果寫到 `.trellis/tasks/10-24-anirecast-prd/research/serpent-asset-management.md`，完成後刪除 `~/.cache/ranolabs/sessions/2026-10-26-serpent-study/`。
