# 交接：Claude 全局接管 AniRecast

- 日期：2026-10-26。程式碼還沒開始改，工作區乾淨（`output/` 本來就在，不是這次的）。
- 開新 session：`cd /Users/alex/Documents/lien/AniRecast && claude "接手：先讀 .trellis/tasks/10-26-claude-takeover/handoff.md"`
- 工作清單：Claude 任務清單第 23 項（P：Claude 全局接管）。

## 人類已經決定的事（不要再問）

- 評審意見預設**全部交給 Claude**，Codex 不再自動接單；網頁上仍可手動指定 Codex。
- 人類在 Claude TUI 說「處理任務」，Claude 就逐一處理；分析鏡頭、分析人物、生成設計圖等也都在 TUI 對話完成。
- 不要做「daemon 用 `claude -p` 在背景自動處理」：人類選的是在 TUI 處理。

## 已確認的現況

- **CLI 已涵蓋網頁所有功能**（已逐一比對 `apps/daemon/src/api/routes.ts` 的路由），不用補指令。對照幾個容易漏看的：
  - `cast/identify` → `cast analyze`
  - 官方設定集 → `design refs --search/--accept/--reject/--add-file`
  - 畫風 → `project style --analyze/--set`
  - 工作 → `jobs pause/resume/cancel/retry`
- **Claude Code 的 shell 有 `CLAUDECODE=1`**。CLI 目前只認 `CODEX_THREAD_ID`，所以 Claude 執行的指令都被記成 `user`（`packages/core/src/events.ts:73`）。
- **Claude Code 還沒裝 anirecast skill**：只有 `~/.codex/skills/anirecast` → `skills/anirecast`，`~/.claude/skills/` 底下沒有。
- **Workspace 只有給 Codex 的 `AGENTS.md`**：Workspace 是 `/Users/alex/Documents/lien/mediaHub`，裡面沒有 `CLAUDE.md`。

## 要做的事（依序）

### 1. Claude 的身分

`actorFromEnv`（`packages/core/src/events.ts:73`）在 `CLAUDECODE === '1'` 時回傳 `'claude'`。

以下規則是依身分判斷的，逐一決定 `'claude'` 該怎麼處理：

| 位置 | 現在 | 要改成 |
|---|---|---|
| `packages/core/src/domain/generation.ts:389` | 只擋 `codex:` 按通過 | **也擋 `claude`**。不改的話，加了身分反而放寬「不替人類通過」 |
| `packages/core/src/domain/designs.ts:350` | 同上，設計圖的通過 | 也擋 `claude` |
| `packages/core/src/domain/cast.ts:7,84` | `DecisionSource = 'codex' \| 'user'`；不是 user 就當 codex | `cast_decisions.source` 有 CHECK（只允許 codex/user），不想做 migration 就沿用 `'codex'`（代理人、不鎖定），在註解寫明 |
| `packages/core/src/domain/boundaries.ts:101` `isHumanActor` | 只有 `user` 算人類 | 維持：Claude 的決定不鎖定，人類可改 |
| `packages/core/src/domain/overlays.ts:99` | `codex:` → codex，其他 → user | 改成非 `user` 都記 codex，或加註說明 |
| `packages/core/src/domain/identity.ts:197,214` | `assigned_by === 'user'` 才算鎖定 | 維持 |
| `packages/core/src/domain/versions.ts:40,125`（discard / prune） | 只擋 `codex:` | 維持：人類在 TUI 明確要求時，Claude 可以做 |
| `packages/core/src/domain/handoffs.ts:1210` | 只擋 `codex:` | 看一下用途再決定 |

### 2. 「等 Claude 處理」的狀態用 `open`，不要用 `needs_user`

現在的 `handOffToClaude`（`packages/core/src/domain/claude.ts:45`）會寫 brief、呼叫 `askUser`，任務變成 `needs_user`，網頁顯示一段指令讓人類複製。這不適合當預設，因為：

- 每則評審意見都會變成一個問題。
- `routeTask`（`claude.ts:196`）第 203 行 `if (... || p.handoff) return codex`：人類一回答，任務就退回 Codex，跟「Codex 不再自動接單」衝突。

改法：

- 只分派一次，結果存進 `payload.routedTo: 'claude' | 'codex'`（加上 reasons）；狀態維持 `open`。
- 刪掉 `p.handoff → codex` 這條規則。
- 分派的優先順序：
  1. 人類明確指定的 `p.agent`（`codex` 或 `claude`）
  2. 設定的預設值。預設是 `claude` 時，**所有任務種類**都歸 Claude，包括 cast_review、shot_review、boards_review。
  3. 預設是 `auto` 時，才用現在的判斷：3 人以上、鏡頭內有切鏡、退回 2 次以上。
- `handOffToClaude` 保留給「Codex 主動交給 Claude」的情況，但也改成設 `routedTo: 'claude'`、維持 `open`。brief 照寫。

### 3. 設定

- 在 `packages/core/src/config.ts` 新增 `agents: { default: 'claude' | 'codex' | 'auto' }`，程式預設 `'claude'`。
- **不要關掉 `codex.autoDispatch`**：dispatcher 還要接 `routedTo === 'codex'` 的任務，網頁上手動選 Codex 才會動。

### 4. Dispatcher

- `apps/daemon/src/codex/dispatcher.ts:151` 的 `tick()`：找下一個任務時跳過 `routedTo === 'claude'` 的。還沒分派的任務先分派、寫入 `routedTo`。
- 第 164–176 行分派到 Claude 時，原本呼叫 `handOffToClaude` 問人類；改成只記錄 `routedTo`，不要問人類。
- 第 219 行的 `route()` 會對每個任務跑 `sceneChanges`，很花時間：預設值不是 `auto` 時直接跳過。

### 5. 領取任務

- `claimNextAgentTask` 和 `listAgentTasks`（`packages/core/src/domain/agent-tasks.ts:70,146`）加上代理人篩選：`json_extract(payload_json, '$.routedTo')`。
- `claimAgentTask`（`agent-tasks.ts:173`）也要檢查：Codex 不能領取 `routedTo` 是 `claude` 的任務。
- CLI 的 `tasks next` 和 `tasks list`（`packages/cli/src/commands/generate.ts:962` 起）加 `--for claude|codex`，預設依操作者：
  - `claude` → 只領 Claude 的
  - `codex:` → 只領 Codex 的
  - `user` → 全部（`apps/daemon/test/generation-flow.test.ts` 的 `tasks next` 靠這個才會通過）

### 6. 網頁

- `apps/web/src/components/version-actions.tsx:118` 現在是從 `t.question.split('執行：')` 取出指令，改完後就失效。改成依 `payload.routedTo` 顯示「等 Claude 處理」，再附一個通用的複製指令，例如：`cd /Users/alex/Documents/lien/mediaHub && claude "處理 AniRecast 待辦任務"`。
- `AgentPick`（第 71 行）：預設選項的文字改成「預設（Claude）」，或依設定顯示。
- 任務中心（`TasksPage.tsx`）和總覽頁的「進行中的 Agent 任務」：把等 Claude 的任務數量和指令顯示出來。

### 7. Claude 的入口

- **安裝 skill**：
  - 這台 Mac 建立 `~/.claude/skills/anirecast` → `/Users/alex/Documents/lien/AniRecast/skills/anirecast` 的 symlink，跟 Codex 的連結一樣。
  - `packages/cli/src/commands/setup.ts:40` 和 `doctor.ts:171` 也要加上 Claude 的連結和檢查。
- **SKILL.md**（`skills/anirecast/SKILL.md`）：
  - frontmatter 的 `description` 是 Claude Code 判斷要不要載入的依據，要加中文觸發詞：分析鏡頭、分析人物、生成設計圖、生成分鏡圖、處理任務、合成。
  - 新增「從 Claude Code 操作」一節，內容包括：
    - 常見要求 → 指令對照表
    - 處理任務的循環：`tasks next --for claude` → 做 → `tasks done`
    - 用 Read 看 PNG（可以看圖，不能看影片，影片用 `take sheet` 或抽幀）
    - 付費生成前先列預算給人類同意
    - 不按通過
    - 可以改程式碼，但要過 check、commit 前看 diff
- **Workspace 的 `CLAUDE.md`**：
  - 在 `packages/core/src/workspace.ts:147`（建立時）和第 181 行起（「仍是我們產生的才更新」）比照 `AGENTS.md` 產生 `CLAUDE.md`。
  - 內容：`@AGENTS.md` 再加幾行 Claude 專用說明（主要操作者是 Claude、「處理任務」要怎麼做、程式碼 repo 的位置）。
  - 內容模板放 `packages/core/src/agents-md.ts`。

### 8. 測試

- `apps/daemon/test/take-director.test.ts`：分派和交接的案例（第 347 行附近預期 `needs_user`，另有「簡單任務給 Codex」的預期）要依新規則改。
- 新增：
  - 依 `routedTo` 篩選的領取
  - Claude 不能按通過
  - 預設 `auto` 時仍走原本的判斷
- 跑 `set -o pipefail; pnpm -s check`（目前 116 個測試全過）。

### 9. 部署

- dispatcher 和 routes 是 daemon 的程式，**要重啟才生效**。之前 `routes.ts` 加的 `still-take` 的 `boardId` 也還在等重啟。
- 重啟前用 until 迴圈確認全部空了才能動：
  - `/api/health` 的 `activeJobs` 是空的
  - `codex.busyTaskIds` 是空的
  - queued／running 的工作數是 0
  - 已 claimed 的任務數是 0
- 重啟指令：`launchctl kickstart -k gui/$(id -u)/dev.anirecast.daemon`。
- 網頁：`pnpm --filter @anirecast/web build`。
- 驗收：
  - 在網頁對一個版本留評審意見 → 任務是 `open`、`routedTo: claude`，Codex 不會領。
  - 在 Claude TUI（cwd 在 mediaHub）說「處理任務」→ 能領到、做完、`tasks done`。
  - 網頁手動選 Codex → Codex 會接。

## 規則（照舊）

- 每完成一小步、check 過就 commit：身分 `LienJack <lienjoe96@gmail.com>`，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不用 `--amend`、`--no-verify`。
- **push 前先問人類。** 目前 `8d5c114`（project prune）還沒 push，其餘已推到 `origin/main`（`4172a58`）。repo 用 HTTPS 以 LienJack 身分推送，不要用 SSH。
- 不要手改 `mediaHub` 的 `sources/`、`projects/`、`library/` 和資料庫，一律透過 `anirecast` CLI。
- ffmpeg 的輸出路徑要確認過才執行：`psnr=f=` 的 `f` 是輸出檔，曾經把原片片段清空。
- 暫存檔放 `~/.cache/ranolabs/sessions/<日期>-<任務>/`，結束前要清理，並在回報裡交代清理結果（見 `/Users/alex/.config/ranolabs/file-management.md`）。

## 另一件事：Serpent 資產管理研究（第 24 項）

- 舊 session 派了一個背景子代理在研究 https://github.com/dolag233/Serpent。交接時還在跑，clone 在 `~/.cache/ranolabs/sessions/2026-10-26-serpent-study/`。
- 研究結果應該寫在 `.trellis/tasks/10-24-anirecast-prd/research/serpent-asset-management.md`：
  - **有這個檔案**：讀過後把重點建議回報給人類（依價值÷工作量排序），並確認暫存資料夾已刪。
  - **沒有這個檔案**（舊 session 結束時子代理被中斷）：重新研究。
    1. shallow clone 到上面的暫存資料夾。只讀，不安裝、不建置、不執行它的任何腳本。
    2. 研究它的資產管理，涵蓋：
       - 資料模型與存放位置
       - ID／hash／去重
       - 版本與來源追溯
       - 標籤與搜尋
       - metadata 與授權
       - 縮圖
       - 匯入匯出
       - 孤兒清理
       - agent 如何引用資產
       - UI
    3. 對照 AniRecast，相關檔案：
       - `personas.ts`、`cast.ts`、`designs.ts`、`generation.ts`、`versions.ts`
       - `workspace.ts` 與 provenance JSON
       - `library/personas/<slug>/refs/`
    4. 寫成上面那個檔案，內容包括：commit hash、日期、比較表、依價值÷工作量排序的建議、不該學的部分。
    5. 刪除暫存資料夾。
