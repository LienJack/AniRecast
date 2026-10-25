# AniRecast

把動畫 OP、經典片段裡的角色，逐個分鏡換成你素材庫裡的人設。

流程：下載原片 → 選節選 → 自動切分鏡、找出角色（同一人跨服裝／髮型歸併）→ 對應人設 → Nano Banana 2.1 生成分鏡圖 →
人工評審 → Gemini Omni 依原片與分鏡圖逐鏡生成視頻 → 人工評審 → 合成成片，附左右滑桿對比版。
評審時寫的修改意見會自動派給 Codex 處理，Codex 的對話會出現在 Codex 桌面版裡。

目前只支援 macOS（Windows 在規劃中）。

## 組成

| 部分             | 位置                                   | 說明                                                                                              |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| CLI `anirecast`  | `packages/cli`                         | 主要操作介面，給人和 Codex 用。stdout 一律輸出一個 JSON 物件                                      |
| Daemon           | `apps/daemon`                          | launchd 常駐，`http://127.0.0.1:7878`。唯一會連網、跑工作和呼叫模型的程序，同時提供 Web UI 和 API |
| Web UI           | `apps/web`                             | React 介面：下載合集、素材庫、節選、分鏡、角色表、評審台（含對比滑桿）、成片、任務中心            |
| Core             | `packages/core`                        | Workspace、SQLite schema、領域邏輯                                                                |
| Media／Providers | `packages/media`、`packages/providers` | ffmpeg 處理；Gemini（Nano Banana 2.1、Omni、Flash）與離線用的 fake provider                       |
| Python sidecar   | `python/`                              | 分鏡偵測（PySceneDetect）、角色偵測與同一人識別（imgutils CCIP）                                  |
| Codex skill      | `skills/anirecast`                     | Codex 處理評審意見和角色判斷時依循的規則                                                          |

## 安裝（macOS）

需要：Node.js 24 以上（開發用 26）、pnpm、ffmpeg、yt-dlp、deno、uv。Codex 桌面版可選，裝了才會自動派發。

```sh
brew install ffmpeg deno uv
uv tool install yt-dlp
pnpm install

# 存 Gemini API key 到鑰匙圈（不會寫進 workspace 或設定檔）
pbpaste | ./bin/anirecast auth set-key

# 建立 Python 環境、連結 CLI 和 Codex skill、安裝 launchd daemon、
# 建立（或開啟）workspace，並在 Codex 桌面版加入同名專案
./bin/anirecast --workspace ~/Documents/mediaHub setup

anirecast doctor          # 全部 OK 即可
open http://127.0.0.1:7878
```

`setup --dry-run` 只列出會做的事，不會實際修改；`setup --uninstall` 會移除 daemon 和連結，workspace 和 key 都保留。
需要確保 `~/.local/bin` 在 PATH 裡。

## 使用

Web UI 可以做完整流程。用 CLI 的話：

```sh
anirecast source add "<網址>" --wait                  # 或 source import <檔案>
anirecast project create --source <sourceId> --name "My OP"
anirecast clip set my-op --in 0:00 --out 1:30         # 自動切分鏡 → Flash 分析 → 同一人識別
anirecast jobs watch --until-idle                     # 背景分析跑完才有角色表（Web 的任務中心也看得到）
anirecast persona add --name Shiro --ref shiro.png --description "銀髮、青綠外套"
anirecast cast list my-op
anirecast cast map <castId> --persona shiro
anirecast board generate my-op --all --wait
anirecast review approve <boardId>
anirecast take generate my-op --all --wait            # 預設用項目檔位
anirecast review request-changes <takeId> --comment "左右對調了"   # 自動派給 Codex
anirecast take promote <shotId> --wait                # draft → preview → final
anirecast render create my-op --wait                  # 成片與對比版
anirecast cost my-op
```

完整指令：`anirecast --help`、`anirecast <指令> --help`。

### 生成檔位

為了省錢，先用低畫質反覆試，滿意了再升級：

| 檔位      | 解析度             | Omni 約每秒成本 |
| --------- | ------------------ | --------------- |
| `draft`   | 360p               | USD 0.037       |
| `preview` | 720p               | USD 0.111       |
| `final`   | 1080p（Omni 原生） | USD 0.162       |

`anirecast project tier <project> draft|preview|final` 設定項目預設檔位。預算上限在
`~/.config/anirecast/config.json` 的 `budget.capUsd`，超過就停止生成。

### Codex 自動派發

評審時按「要求修改」，或角色識別有不確定的地方，就會建立 agent 任務。Daemon 透過 `codex app-server` 開一個 thread，
指派到 Codex 桌面版裡與 workspace 同名的專案。Codex 在沙箱內（不能連網，只能寫 workspace）用 CLI 重新生成、
抽樣檢查，最後回報結果。Codex 不能核准版本，也不能推翻人工做的決定。

## Workspace

一個 workspace 就是一個資料夾，整個複製到另一台電腦就能用：

```
anirecast.workspace.json   # 格式與版本
anirecast.db               # SQLite：來源、項目、分鏡、角色、版本、評審、花費
library/personas/          # 公共素材庫（人設參考圖）
sources/                   # 下載合集
projects/<slug>/           # 節選、分鏡幀、分鏡圖、分鏡視頻、成片
cache/  trash/
```

搬移前先停 daemon（`launchctl bootout gui/$(id -u)/dev.anirecast.daemon`），再複製整個資料夾；到新電腦上執行
`anirecast workspace open <dir>` 或 `anirecast --workspace <dir> setup`。API key 和 Codex 對話紀錄不跟著
workspace 走，留在原本那台電腦。

## 開發

```sh
pnpm check        # typecheck + Biome + Vitest，提交前必須通過
pnpm dev:web      # Vite dev server，API 代理到 7878

# 開發用的 daemon：獨立的 workspace 和設定，fake provider 不花錢（用 ffmpeg 模擬生成）
export ANIRECAST_CONFIG_DIR=$PWD/workspaces/.config
pnpm anirecast workspace init workspaces/dev
ANIRECAST_PROVIDER=fake pnpm daemon --workspace workspaces/dev --port 7979
```

一個 workspace 同時只能有一個 daemon（`.anirecast.lock`），launchd 那個已經佔用預設的 workspace。
新設定預設會自動派發給 Codex。開發時如果不想產生 Codex 對話，在 `$ANIRECAST_CONFIG_DIR/config.json` 設定
`"codex": {"autoDispatch": false}`。
`workspaces/` 已列入 gitignore。

需求、設計和進度記在 `.trellis/tasks/10-24-anirecast-prd/`（prd.md、design.md、implement.md、research/）。

## License

Apache-2.0
