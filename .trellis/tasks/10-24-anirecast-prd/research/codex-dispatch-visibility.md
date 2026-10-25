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

## 測試 thread

- `01a171cb-6289-79f3-beab-28c95832600d`，名稱「AniRecast 自動派發測試（可刪除）」，cwd 是 AniRecast repo。保留到你在桌面端確認看得到為止，之後刪除。
