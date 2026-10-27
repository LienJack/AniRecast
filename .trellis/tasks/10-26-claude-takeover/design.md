# Design：Claude 全局接管

逐檔的現況與改法見 `handoff.md`；這裡寫兩個子代理之間要對齊的契約。

## 契約

### 身分

- `actorFromEnv`：`CODEX_THREAD_ID` → `codex:<id>`；否則 `CLAUDECODE === '1'` → `'claude'`；否則 `'user'`。
- 代理人判斷：`actor !== 'user'` 就是代理人（`codex:*` 或 `claude`）。需要「是否代理人」的地方用一個共用 helper，不要到處寫 `startsWith('codex:')`。
- 依身分的規則照 `handoff.md` 第 1 節的表：通過（`generation.ts`、`designs.ts`）擋所有代理人；`cast.ts` 的 `DecisionSource` 對 `claude` 記 `'codex'`（CHECK 只允許 codex/user，加註說明）；`overlays.ts` 非 `user` 都記 codex；`boundaries`／`identity` 維持；`versions.ts` discard/prune 維持只擋 `codex:`；`handoffs.ts:1210` 看用途後決定並加註。

### 任務 payload

```ts
payload.agent?: 'auto' | 'codex' | 'claude'   // 人類明確指定（既有）
payload.routedTo?: 'claude' | 'codex'          // 分派結果（新）
payload.routeReasons?: string[]                // 分派理由（新）
payload.handoff?: ClaudeHandoff                // brief 位置（既有，保留）
```

- 分派只做一次；`routedTo` 寫入後不因人類回答而改變。人類之後在網頁按「交給 Claude 接手」或 Codex 執行 `tasks handoff` 時，改成 `routedTo: 'claude'`。
- 新任務：明確 `agent` 或 `agents.default !== 'auto'` 時，建立時就寫入 `routedTo`（不需要算切鏡）。`auto` 且沒有明確指定時留空，由 dispatcher 計算後寫入。
- 既有沒有 `routedTo` 的未完成任務：dispatcher 的 tick 依同一規則補上。
- `handOffToClaude`：照寫 brief、存 `payload.handoff`，設 `routedTo: 'claude'`，**不呼叫 `askUser`**；若任務是 `claimed` 或 `needs_user`，放回 `open` 並清掉領取者，讓 Claude 能領。回傳 `{ brief, command }`，`command` 是下面的通用指令。

### 設定

- `config.agents.default: 'claude' | 'codex' | 'auto'`，程式預設 `'claude'`。
- `GET /api/settings` 增加 `agents: { default, claudeCommand }`，`claudeCommand = cd <workspace root> && claude "處理 AniRecast 待辦任務"`（core 提供一個產生這個字串的函式，網頁與 handoff 共用）。

### 領取

- `listAgentTasks` / `claimNextAgentTask` 接受 `agent?: 'claude' | 'codex'`，以 `json_extract(payload_json, '$.routedTo')` 篩選。
- `claimAgentTask`：操作者是 `codex:*` 而任務 `routedTo === 'claude'` 時拒絕（`conflict`）。
- CLI `tasks next|list --for claude|codex`，預設依操作者；`user` 不篩選。

### Dispatcher

- tick：先替沒有 `routedTo` 的未完成任務分派（`auto` 才跑 `sceneChanges`），再只領 `routedTo === 'codex'` 的任務。分到 Claude 時只記錄，不問人類。

### 網頁

- 等 Claude 的判斷：`payload.routedTo === 'claude'` 且狀態未結束。
- 版本的工作列：顯示「等 Claude 處理」＋複製 `claudeCommand` 的按鈕（從 `/api/settings` 取得；取不到時用 handoff 回傳的 `command`）。不要再從 `question` 字串切出指令。
- `AgentPick` 的 `auto` 選項文字改成「預設（Claude）」或依 `agents.default` 顯示。
- 任務中心與總覽：等 Claude 的任務數量＋複製指令。

### Workspace `CLAUDE.md`

- 模板放 `packages/core/src/agents-md.ts`，跟 `AGENTS.md` 一樣：建立時產生；「仍是我們產生的」才更新。
- 內容：`@AGENTS.md`、主要操作者是 Claude、「處理任務」的循環、程式碼 repo 的位置。

## 相容性與回滾

- 沒有 schema migration；`routedTo` 只在 JSON payload 裡。回滾：還原 commit、重啟 daemon；舊任務多一個欄位不影響舊程式。
- 設定沒有 `agents` 時用預設 `'claude'`；要回到舊行為設 `agents.default: 'auto'`。
