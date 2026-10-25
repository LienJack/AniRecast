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

1. **桌面端的實際畫面我看不到。** 只能確認預設清單裡有，而桌面版的側邊欄應該用的就是這份清單（app bundle 裡呼叫 `thread/list` 時用的是互動型篩選，並且 `useStateDbOnly: true`）。需要你自己看一眼。
2. **執行中能不能在桌面端即時看到，未驗證。** 對話在 AniRecast 自己的 app-server 程序裡跑；桌面版可能要跑完、或重新整理後才看得到。而且兩個程序同時寫同一個 thread 有風險。所以規則是：**即時進度在 AniRecast Web 看；桌面端在跑完之後閱讀或接續對話；處理中的 thread 不要在桌面端發訊息。**
3. **`codex://threads/<id>` 深層連結**是從 app bundle 找到的，官方沒有文件；只在 macOS 桌面版 26.1013 確認存在。Bundle 裡在 `win32` 平台會跳過 `setAsDefaultProtocolClient`，Windows 可能改由安裝程式註冊，**未驗證**。
4. **Thread 只存在各台電腦自己的 `~/.codex`。** A 電腦的 thread id 在 B 電腦不存在。所以 AniRecast 必須自己保存 Codex 的回報（最後訊息、改動摘要），Codex thread 只是「這台電腦上的檢視」。

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
- 桌面端的專案記錄在 `~/.codex/state_5.sqlite` 的 `projects` / `project_roots`（內部格式），app-server 沒有新增專案的 API。目前 AniRecast 的路徑不在任何專案底下。推測桌面端只在側邊欄顯示工作目錄落在已知專案底下的 thread，**這點待你確認**。
- Drizzle 0.45.4 沒有 `node:sqlite` driver（有 better-sqlite3 和 sqlite-proxy）。實測用的是 Node 內建的 `node:sqlite`。

## 測試 thread

- `01a171cb-6289-79f3-beab-28c95832600d`，名稱「AniRecast 自動派發測試（可刪除）」，cwd 是 AniRecast repo。保留到你在桌面端確認看得到為止，之後刪除。
