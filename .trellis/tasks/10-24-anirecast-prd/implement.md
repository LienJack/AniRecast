# AniRecast 實作計畫（macOS MVP）

這份文件同時是**進度紀錄**：每完成一步就填上 `done:` 的 commit hash。中斷或對話被壓縮後，從第一個沒有 `done` 的步驟接著做。

需求以 [prd.md](prd.md) 為準，設計以 [design.md](design.md) 為準。

## 全域規則

- **花費**：開發期 Gemini API 上限 **USD 40**（2026-10-25 你批准）。
  - 每一筆付費呼叫都記在 [research/spend-ledger.md](research/spend-ledger.md)；達到上限就停用真實 API，改用 fake provider。
  - 自動化測試一律不打 Gemini 或 Codex。
- **commit**：每一步在 `pnpm typecheck && pnpm test && pnpm lint` 全綠後 commit，作者 LienJack；不 push。
- **生成檔位**：開發與實驗一律用 `draft`（Omni 360p），大致完成才用 `preview`（720p），`final`（1080p）只在最後跑一次（2026-10-25 你的要求）。
- **開發用 Workspace** 放在 repo 內的 `./workspaces/`（已 gitignore），不碰 `mediaHub`。預設路徑寫在設定裡，不寫死在程式碼。
- **daemon**：開發期用背景行程手動跑；launchd LaunchAgent 到 S12 才安裝，安裝時會告知。
- **金鑰**：接受 `GEMINI_API_KEY` 或 `GEMINI_OMNI_API_KEY`；開發時用 `--env-file=.env` 帶入；`auth set-key` 從 stdin 讀，不從參數讀。
- **資料庫**：Node 內建的 `node:sqlite`，加上手寫的 SQL 遷移檔，不用 ORM。理由：實測在 Codex 沙箱內可寫；沒有原生模組（Windows M7 不用編譯）；資料表約 20 張，規模不大。

## 步驟

### S0 Python sidecar 風險驗證 — done: a7e7c06
- 產出：`python/`（uv，Python 3.12），依賴 dghs-imgutils 0.19、scenedetect 0.7.2、scikit-learn、onnxruntime 1.31。
- 驗證：imgutils 頭部與人物偵測可用，熱啟動每張 0.1–1.3 秒。CCIP 門檻 0.178：原角色 A 和人設 P 差 0.28–0.38（不同人）；同一個 P 在分鏡圖和人設表之間差 0.08–0.09（同一人）。
- 注意：imgutils 會在執行時試圖用 pip 安裝 onnxruntime，所以必須在 `pyproject.toml` 明確宣告。

### S1 Monorepo 骨架 — done: 3b28baf
- 產出：pnpm workspace、`tsconfig.base.json`、Biome、Vitest。
  - packages：`shared`、`core`、`media`、`providers`、`cli`；
  - apps：`daemon`、`web`（先放佔位）。
  - 根目錄 scripts：`typecheck`、`test`、`lint`、`anirecast`。
- 驗證：`pnpm install && pnpm typecheck && pnpm test && pnpm lint`。

### S2 Core：Workspace、DB、jobs、events — done: 7e2039b
- 產出：
  - Workspace：manifest、跨平台命名檢查、鎖檔、`AGENTS.md` 產生、開啟時的版本與遷移檢查；
  - 資料庫：`node:sqlite` 連線（WAL、busy_timeout）、遷移執行器、全部資料表（design §5）；
  - `events`（與狀態變更同一個交易寫入）、`jobs`（含通道）、`daemon_heartbeat`；
  - 本機設定 `~/.config/anirecast/config.json`；金鑰讀取。
- 驗證：Vitest 涵蓋 init/open/驗證失敗、命名規則、遷移、兩個連線同時寫入。

### S3 CLI 與 daemon 骨架 — done: 3b23b7e
- CLI：`workspace init|open|status`、`doctor`（先檢查 ffmpeg、yt-dlp、deno、Python、金鑰）、`jobs list|show|watch|cancel|retry`。
  - 輸出規範：stdout 一個 JSON（`{ok,data|error}`），進度寫到 stderr。
  - 心跳過期時回傳 `daemon_not_running`。
- daemon：`anirecast serve`。
  - 心跳、各通道的 job runner（先實作一個 noop job）；
  - events 追蹤器把新 events 推給 SSE；
  - HTTP：`/api/health`、`/api/events`（SSE）。
- 驗證：整合測試。CLI 排一個 noop job → daemon 執行 → `jobs watch` 看得到完成的 event。

### S4 來源、節選、分鏡 — done: f1d545a
- 產出：
  - `source import <file>`、`source add <url>`（yt-dlp job）；
  - `project create`；
  - `clip set`（固定幀率母版、`audio.wav`、Web 代理檔）；
  - `shots detect`（sidecar 用 scenedetect 回傳 JSON）與關鍵幀；
  - `shots split|merge|set`。
- 驗證：用 ffmpeg 合成一支已知剪接點的影片（色塊加 drawtext），斷言剪接點位置、每個分鏡的幀範圍首尾相接，以及幀數總和。

### S5 Provider 層與成本 — done: 2456408
- 產出：介面 `ImageGen`、`VideoEdit`、`VisionAnalyze`、`FilesUpload`。
  - `fake` 實作：影片做帶色調的重編碼並保持幀數相同；JSON 回傳罐頭資料。
  - `gemini` 實作：Interactions API 與 Files API，去掉 `steps[].signature`。
  - 成本帳本與花費上限保護：超過上限時拒絕真實呼叫。
- 驗證：fake 的單元測試；gemini 的請求組裝與回應解析，用 `research/gemini-api-spike/*.response.json` 當固定測資。

### S6 人設、角色、處理方式 — done: 3b38b6f
- 產出：
  - `persona add|list|show|edit|archive`；
  - 資料表 `cast_members`／`looks`／`tracklets`／`cast_decisions`；
  - `cast map`、`look-policy`；
  - 分鏡處理方式的自動判定（design §6）。
- 驗證：單元測試涵蓋處理方式判定與 stale 傳播。

### S7 分鏡圖 → 分鏡視頻 → 合成 → 對比（fake 端到端）— done: 3a0cfe9
- 產出：
  - `board generate`、`take generate`（換角、去字）；
  - 對齊：幀數校驗、24fps 重新標記與還原、1080p、去音軌；
  - `render`（草稿與正式）；
  - 對比：hstack 匯出檔，以及給 Web 用的 vstack 代理檔；
  - `review approve|request-changes|keep-original`。
- 驗證：用 fake provider 端到端跑完。斷言每鏡幀數一致、成片 1920×1080、總幀數等於節選、音訊長度相符。

### S8 Codex 派發 — done: 20a082f、b2f639a（真實 Codex 整合測試通過，見 research/codex-dispatch-visibility.md）
- 產出：
  - `agent_tasks`、`tasks next|list|done|ask`；
  - app-server 用戶端：找 codex 執行檔、啟動時用 `experimentalApi` 自我檢查、依根目錄找到專案 id；
  - thread 對應（每分鏡一個、每項目一個角色辨識 thread）、沙箱政策、`localImage` 與 `skill` 輸入、用量帳本；
  - Workspace `AGENTS.md`；`skills/anirecast/SKILL.md`。
- 驗證：用假的 app-server 做單元測試；手動整合腳本跑一次真 Codex（耗用 Codex 額度），確認 thread 出現在桌面端的 Workspace 專案底下。

### S9 Web — done: 0d217da（API）、45e9fc7（UI）
- 產出（Vite、React 19、TanStack Router 與 Query、shadcn/ui、Tailwind v4）：
  - Workspace 選擇、下載合集、項目總覽；
  - 原片與節選播放器（逐幀、入點與出點）、分鏡格狀列表；
  - 角色表（依造型的裁切圖、拖曳改歸屬、鎖定）、素材庫；
  - 評審台（vstack 加 canvas 滑塊、版本歷史、Codex 說明與「在 Codex 打開」）；
  - 成片頁、任務中心；以 SSE 即時更新。
- 驗證：Vitest 元件測試；Playwright 測主要流程（fake provider）；用瀏覽器實際操作一遍並截圖。
- 實際完成：daemon API 有測試（apps/daemon/test/api.test.ts）；UI 在 headless Chrome 實際操作並截圖（總覽、評審台、角色表，console 沒有錯誤、圖片都載入）。**Vitest 元件測試和 Playwright 還沒做**，留作後續。

### S10 分析：字幕、描述、同一人識別 — done: 9233d50（真實 Flash 分析在 S11 驗證）
- 產出：
  - Flash 視覺分析：疊加字幕三類、外觀描述、分鏡描述；
  - sidecar：頭部與人物偵測 → 出場片段 → CCIP → 帶約束的分群 → 造型；
  - `cast_review` Agent 任務與對照圖；
  - 人工鎖定作為硬約束。
- 驗證：單元測試涵蓋同框互斥、鎖定決定不被推翻；用 fixture 量測準確度。

### S11 Fixture 與真實接口端到端（付費，記帳）— done: 9f3cbcd（結果見 research/s11-real-run.md，花費 USD 2.82）
- 產出：
  - 測試人設 2–3 個（Nano Banana）；
  - 自製測試 OP：
    - 重用 spike 的 10 秒片段，再生成 3–4 段：同一角色兩套服裝、雙人同框、純風景；
    - 用 drawtext 燒上假的工作人員字幕，再接成一支。
  - 用真實 Gemini 跑完整流程一次；比較 1080p 做法；自動派發 Codex 一次。
- 驗證：成片、對比影片、同一人識別準確度；花費寫進帳本。預估 USD 10–15。

### S12 安裝、doctor、文件 — done: f159195、6244554，README 隨本次進度更新一起提交
- 產出：
  - `anirecast setup`：Python 環境、CLI 連結、skill 連結、launchd LaunchAgent（安裝時會告知你）；
  - `doctor` 補齊所有檢查；
  - README。
- 驗證：在乾淨的 `./workspaces/` 從頭跑一次 doctor 和 setup。
- 實際完成：先跑 `setup --dry-run`，再在這台 Mac 上實際安裝到 mediaHub（launchd `dev.anirecast.daemon`、鑰匙圈 key、`~/.local/bin/anirecast`、`~/.codex/skills/anirecast`、Codex 專案 mediaHub）。`doctor` 15 項全部 OK。README 的開發用 daemon 步驟（workspace init → fake daemon → health／index）也在全新的暫存目錄實際跑過一次。

## 委派

- S1–S3、S5、S7 自己做，因為它們定義了所有介面與契約。
- 契約穩定後，S9（Web）和 S10 的分群程式可以交給 `general-purpose` agent 平行做（參照 `.claude/agents/trellis-implement.md`），我負責驗證。

## 回滾點

- 每一步都是獨立的 commit；有問題就 `git revert` 那一步。
- 開發期不會修改 `~/.codex` 的設定，也不會修改 mediaHub；LaunchAgent 用 `anirecast setup --uninstall` 移除。
