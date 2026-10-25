# Codex 自動派發：session 能不能在桌面端看到（2026-10-24 實測）

問題：AniRecast 自動把評審意見交給 Codex 處理時，你能不能在 Codex 桌面端看到那個 session？方案還要能在其他裝了 Codex 的電腦上運作。

探測腳本：[`codex-dispatch/`](codex-dispatch/)。全部在本機執行，沒有修改任何 Codex 設定。

## 測試環境

- Codex 桌面版 26.1013.31256（`/Applications/ChatGPT.app`，bundle id `com.openai.codex`），內建 `codex-cli 0.163.0-alpha.10.2`。
- PATH 上的 `codex`（`~/.local/bin/codex`）是 0.156.0；npm 上最新是 0.164.0。
- `~/.codex/config.toml` 設定 `model = "gpt-6.1-sol"`。

## 結論

| 方式 | session 來源標記 | 會不會出現在 Codex 預設的 thread 清單 |
| --- | --- | --- |
| `codex exec` | `exec` | **不會**。本機 38 個 exec session，預設清單一個都沒列出；明確指定 `sourceKinds` 含 `exec` 時才會出現 |
| `codex app-server`（JSON-RPC over stdio） | `vscode`（與桌面版自己的 thread 相同） | **會**。實測建立的 thread 在預設清單中，名稱就是 `thread/name/set` 設的那個 |

- App-server 的 `thread/list` 說明寫著：沒指定 `sourceKinds` 時，預設只列「互動型來源」。實測結果：預設清單是 `{"vscode":132,"cli":1}`；全部列出時是 `{"vscode":132,"exec":38,"cli":1}`。
- 你在 vfx-monorepo 用 Codex Python SDK 跑的 64 個 Blender Agent session，originator 是 `codex_python_sdk`、來源標記是 `vscode`，走的是同一個機制。
- 用 `clientInfo.name = "anirecast"` 建立的 thread，rollout 裡的 originator 就是 `anirecast`，之後要篩選很方便。
- 一輪對話中收得到 `item/agentMessage/delta`、`item/started`、`item/completed`、`thread/tokenUsage/updated`、`account/rateLimits/updated`，所以 AniRecast Web 可以即時顯示進度和用量。
- `turn/start` 的輸入支援 `localImage`（本機圖片路徑）和 `skill`（name + path）：可以直接把分鏡圖附給 Codex，並且明確指定使用 repo 裡的 skill，不需要每台電腦先安裝。

## 實際踩到的坑

- **用 PATH 上的 0.156 跑會失敗**：`The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account`（HTTP 400 `model_not_found`）。改用桌面版內建的 0.163 就成功了。
  → AniRecast 不能盲目使用 PATH 上的 `codex`。要按這個順序找：設定檔指定的路徑 → 桌面版內建的 codex → PATH，並選版本最新的那個。`doctor` 要真的跑一輪探測，把錯誤原文顯示出來。
- 失敗的那個測試 thread 已經用 `thread/delete` 刪掉了。

## 未驗證／限制

1. ~~桌面端的實際畫面~~ → 已由下一節「桌面端側邊欄與專案歸屬」實測解決。
2. **執行中能不能在桌面端即時看到，未驗證。** 對話在 AniRecast 自己的 app-server 程序裡跑，桌面端收不到那個程序的即時通知。而且兩個程序同時寫同一個 thread 有風險。所以規則是：**即時進度在 AniRecast Web 看；桌面端在跑完之後閱讀或接續對話；處理中的 thread 不要在桌面端發訊息。**
3. **`codex://threads/<id>` 深層連結**：官方沒有文件，從 app bundle 找到。**macOS 桌面版 26.1013 實測可用**，直接跳到該 thread，內容完整。Bundle 裡在 `win32` 平台會跳過 `setAsDefaultProtocolClient`，Windows 待 M7 驗證。
4. Codex 紀錄只要求在本機桌面端看得到，不處理跨電腦遷移（2026-10-24 你確認的範圍）。

## 桌面端側邊欄與專案歸屬（2026-10-25 實測，你在桌面端確認）

- **只看工作目錄不夠。** 你把 `/Users/alex/Documents/lien/AniRecast` 加為專案之後，工作目錄就是這個路徑的測試 thread 仍然**沒有**出現在專案底下，而是出現在「最近項目」。
- **桌面端怎麼決定 thread 屬於哪個專案**：
  - 舊方式：記在 `~/.codex/.codex-global-state.json` 的 `thread-project-assignments`。
  - 新方式：由 app-server 管理的 `thread.projectId`，存在 `state_5.sqlite` 的 `threads.project_id`。
  - 你的桌面端目前狀態是 `projectsMigrated: true`、`threadAssignmentsMigrated: false`（還有 63 個 thread 歸屬待遷移）。
- **外部建立的 thread 不會被自動歸入專案。** 你機器上 94 個 Python SDK／exec 建的 thread 沒有一個被歸入專案。專案存在之後才建立的新 thread，60 秒內也沒有被登記。
- **有效的做法（實測，你確認看到了）**：
  - `initialize` 時宣告 `capabilities.experimentalApi = true`；
  - 用 `project/list` 依根目錄找到專案 id（例如 AniRecast 專案是 `01a171da-…`）；
  - 用 `thread/metadata/update { threadId, projectId }` 指派，thread 就出現在該專案底下。
  - 實驗性的 `ThreadStartParams.projectId` 可以在建立時直接指定（schema 有，尚未單獨實測）。
  - 指派成功時，app-server 會發出 `thread/project/updated` 通知。
- **實驗性 API 還有** `project/create|read|update|delete|import|move` 和 `thread/list { projectId }`。其中 `project/create` 也許能自動替 Workspace 建立桌面端專案、省掉手動加入那一步，**未驗證**。
- **桌面端自己的 app-server**（pid 3076）以 stdio 啟動、由桌面端獨占。`codex app-server proxy` 需要的 daemon 控制 socket（`~/.codex/app-server-control/app-server-control.sock`）不存在，所以外部程式無法接上桌面端的 app-server。
- **`codex://new?prompt=…&path=…&projectId=…`** 會在指定專案開新 thread，並把提示詞預先填進輸入框（看起來不會自動送出）。這是備案。
- 實驗性 API 可能隨 Codex 改版變動，所以 AniRecast 啟動時要做自我檢查（見 design.md §8.4）。

## 沙箱與 CLI 通訊（Mac，Codex 0.163 seatbelt 沙箱）

每一輪對話都透過 app-server 執行：`approvalPolicy: never`、`sandboxPolicy.type = workspaceWrite`、`writableRoots = [cwd]`。測試結束後，測試 thread 都已刪除。

| 連線方式 | network off | network on |
| --- | --- | --- |
| HTTP 連 `127.0.0.1:<port>` | **失敗**（curl exit 7，伺服器收不到請求） | 成功 |
| HTTP over Unix socket（socket 在可寫目錄內，或在 `~/.config`） | **失敗**（兩種位置都是 exit 7） | 未測 |
| 沙箱內的 Node 程序寫入可寫目錄裡的 SQLite（WAL），沙箱外的程序同時開著這個 DB | **成功**，外部程序立刻讀到新的那筆資料 | — |

- 結論：**CLI 不走網路，直接讀寫 Workspace 裡的 SQLite**，就能在最嚴格的沙箱（network off、never approve）下運作。前提是 Workspace 在 Codex 的可寫範圍內，也就是 thread 的工作目錄等於 Workspace 根目錄。
- 沙箱內可以看到的環境變數有 `CODEX_SANDBOX=seatbelt`、`CODEX_SANDBOX_NETWORK_DISABLED=1`、`CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_VERSION`。
  - CLI 可以據此判斷自己在沙箱內，不要在沙箱裡啟動 daemon：沙箱裡啟動的 daemon 會繼承沙箱，連不到 Gemini。
  - CLI 也可以把 `CODEX_THREAD_ID` 記進版本的 `created_by`。
- 你的桌面端 thread 實際用的設定：81 個裡有 75 個是 `sandbox: disabled` + `approval: never`，5 個是 managed restricted + never，1 個是 managed restricted + on-request。所以**在你這台電腦上，手動模式本來就不會被擋**。改用 SQLite 是為了換電腦、限制較嚴的設定，以及刻意保持沙箱的自動派發都能穩定運作，不是只為了繞過這台電腦的設定。
- 桌面端的專案記錄在 `~/.codex/state_5.sqlite` 的 `projects` / `project_roots`。專案歸屬見下一節。
- Drizzle 0.45.4 沒有 `node:sqlite` driver（有 better-sqlite3 和 sqlite-proxy）。實測用的是 Node 內建的 `node:sqlite`。

## 測試 thread

所有測試 thread 都已經用 `thread/delete` 刪除（2026-10-25），包括「AniRecast 自動派發測試」和「AniRecast 專案歸屬測試」。探測腳本放在 [`codex-dispatch/`](codex-dispatch/)。

## S8 真實整合測試（2026-10-25，耗用少量 Codex 額度，生成用 fake provider，不花 Gemini 費用）

- 開發用 Workspace：`workspaces/dev-codex`（gitignore），位置在桌面端 AniRecast 專案的根目錄底下。
- 情境：1 個換角分鏡，分鏡圖已通過，分鏡視頻 v1 待評審。送出意見「讓整體色調更溫暖一點（偏橘黃），其他保持不變」。
- 派發器選用桌面版內建的 codex `0.163.0-alpha.10.2`，用 `project/list` 找到 AniRecast 專案 `01a171da-…`。建立的 thread「AniRecast · Codex Test · 分鏡 1」的 `project_id` 正確，**出現在桌面端的 AniRecast 專案底下**。
- Codex 在沙箱裡（關閉網路，只能寫 Workspace）執行了 12 個指令，全部 exit 0：
  - `anirecast tasks show`、`workspace status`、讀 SKILL.md；
  - 兩次 `take generate --from … --extra …`，以及檢查結果。
- 結果：fake provider 只做色相偏移，兩次都不符合「稍微偏暖」。Codex 依 skill 規則停下來，用 `tasks ask` 把任務轉成「需要你回覆」，並在問題中指出目前用的是測試供應器。全程約 1 分鐘。
- 觀察：
  - Codex 先用 `rg` 找 SKILL.md 再讀，表示 `skill` 輸入不一定會自動帶入內容；但指示裡已經寫了 skill 名稱，它會自己找到。
  - Codex 也讀了你全域 `~/.codex/AGENTS.md` 指定的檔案管理規範，這是預期內的行為。
