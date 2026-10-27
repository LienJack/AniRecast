# Serpent 的資產管理：AniRecast 該學什麼（2026-10-26 研讀）

問題：開源的數位資產管理軟體 Serpent 怎麼管資產？AniRecast 的人設庫、生成版本和工作區檔案，有哪些做法值得搬過來，哪些不該搬？

- Serpent：<https://github.com/dolag233/Serpent>，commit `dbf4c27b637be2c01aa54628cd2a58cc95f70e62`（2026-10-25，release 0.3.3），淺層 clone 後**只讀原始碼與文件**，沒有安裝、建置或執行任何東西。研讀日 2026-10-26。clone 已在研讀後刪除，下面的行號以這個 commit 為準。
- AniRecast：讀 2026-10-26 的工作樹（HEAD `2480dfc`）。同時有其他 agent 在改 `cast.ts`、`designs.ts`、`generation.ts`、`versions.ts`、`agents-md.ts` 等檔，行號可能已經偏移幾行。
- 正式工作區 `/Users/alex/Documents/lien/mediaHub` 只看了目錄清單、`du` 和一個 `persona.json`，沒有開資料庫，沒有改任何東西。

## Serpent 是什麼

Electron 桌面版的素材庫，給遊戲美術、影視後期和設計師用，定位類似 Eagle / Billfish（`README.md`）。一個「資源庫」就是一個資料夾：使用者檔案放在 `Assets/`，SQLite 放在 `.serpent/library.db`，縮圖和代理檔放在 `.serpent/artifacts/`（`docs/developer/architecture.md`）。只有 Library Worker 程序能碰資料庫和檔案，Renderer 拿不到任意路徑（同一份文件的「不变量」）。核心是一個 51k 行的 `src/worker/library-service.ts`，schema 版本 **59**（`MIGRATIONS`，library-service.ts:3615 起；architecture.md 寫的「v33」已經過時）。

兩者定位不同：Serpent 管的是**使用者帶進來的檔案**，AniRecast 管的主要是**自己生成的版本**。比較時要記住這一點。

## 結論：比較表

| 面向 | Serpent | AniRecast | 落差 |
| --- | --- | --- | --- |
| 資料模型與存放位置 | 一個資產對應一個真實檔案（`assets`），內容變更寫成 `revisions`（origin：`import / external_change / replace / relink`，有 `parent_revision_id`；library-service.ts:1225–1245、1545–1558）。檔名就是資產名稱，改名會改真實檔案（`docs/glossary.md`「资产名称」）。資料夾對應 `Assets/` 下的真實目錄；另有「連結資料夾」原地引用外部目錄（1301–1375）。 | 工作區固定五個目錄 `library/personas, sources, projects, cache, trash`（workspace.ts:17）。人設庫是 `personas` + `persona_images`，圖片放 `library/personas/<slug>/refs/<img_id>.<ext>`（personas.ts:242）。生成物是只增不改的版本列：`boards / takes / designs`（migrations.ts:216–258、485–506），檔案放 `projects/<slug>/shots/<shotId>/boards/b001.jpg` 這種路徑。 | 模型方向不同，不必對齊。AniRecast 的問題在**路徑把歸屬寫死了**：合併鏡頭後，搬到存活鏡頭的 board 列 `path` 還指向被刪鏡頭的資料夾（shots.ts:349–351 只改 `shot_id` 和 `version`）。 |
| ID、雜湊、去重 | 資產、修訂、衍生檔都是 UUID（library-service.ts:19487–19488、24312）。跨裝置另有 `sync_id`（2379）。路徑另存正規化的 `path_identity`（NFC + casefold），用唯一索引防止大小寫衝突（1266–1298）。去重：每個修訂存 SHA‑1 `content_fingerprint`，以 `(byte_size, content_fingerprint)` 建索引（3045–3048、3360–3373）。匯入時同路徑算「名稱衝突」，路徑空著但內容相同算「疑似重複」，兩種都**交給使用者決定**（`classifyImportEntryConflict`，43250–43290；`findActiveManagedAssetByContent`，43093）。註：glossary 寫「檔名＋大小相同」，跟程式碼不符，以程式碼為準。 | ID 是帶前綴的 ULID（`per_ / img_ / ref_ / shot_ / tak_`，shared/src/ids.ts）。人設和專案另有唯一 slug，查詢時 id 和 slug 都能用（personas.ts:110–116）。sha256 去重**只在同一個人設內**（personas.ts:238–240）或同一個原作角色內（references.ts:107–118），衝突直接報錯。來源影片用 URL 唯一索引去重（migrations.ts:45）。 | AniRecast 缺全庫範圍的內容去重：同一張圖可以存進兩個人設，各存一份。生成輸出本身沒有雜湊（boards / takes / designs 沒有 sha256 欄位）。 |
| 版本與來源（lineage） | 修訂只記錄「內容換過」，**舊的位元組不一定保留**。面向使用者的版本管理不在 MVP（glossary「修订」「版本管理」）。衍生檔用 `artifactKey` 綁定 資產 + 修訂 + 角色 + 生成器 id + 生成器版本 + 設定雜湊，所以換了生成器就自然是新檔（artifact-policy.ts:352–362）。AI 內容另存一張表，記錄 `model_id / model_version / revision_id`，不覆蓋人工內容（1574–1588；glossary「AI 内容」）。 | 比 Serpent 強。每個版本記錄 prompt、model、params、`inputs_json`（每個輸入有 role、path、**sha256**，plan.ts:255–256）、`parent_id`、`remote_json`、成本、建立者。檔案旁邊另寫一份不可變的 provenance JSON（daemon generation.ts:92–95、177、285、570、660）。另有審核、approved / rejected / stale 狀態，事件流每筆都記 actor。 | AniRecast 的生成 lineage 已經足夠。弱的是**衍生檔**：來源影片的縮圖和代理檔、鏡頭的 `source.mp4` 和 frames、cache 裡的 compare 和 raw 檔，都沒有生成器版本，也沒有登記表。 |
| 標籤與搜尋 | 標籤有獨立的表（不分大小寫唯一），人工標籤和 AI 標籤分開存（1377–1399）。合集、智慧合集（存搜尋條件）。全文搜尋用 FTS5 trigram，涵蓋檔名、標籤、描述、來源網址、作者、資料夾路徑、metadata（1453–1495；search-query.ts:1–30）。搜尋語法支援 `tag:`、`-`、`|`（glossary「搜索表达式」）。另有實驗性的語義搜尋。 | `personas.tags_json` 是自由字串陣列（migrations.ts:124）。`listPersonas` 只能用 kind 和 archived 過濾（personas.ts:118–128），CLI `persona list` 也只有 `--kind`（cli cast.ts:110）。UI 只有角色、物品、場景三個分頁（LibraryPage.tsx），沒有搜尋。圖片靠 `view` 和 `label` 讓 planner 挑選。 | 規模差很多：mediaHub 只有 7 個人設、約 111 張參考圖（依舊 probe 的路徑清單統計）。目前缺搜尋不算痛點。 |
| Metadata 與授權 | `asset_metadata`：描述、評分、喜歡、色卡、`source_page_url`、`author`、`entity_version`（1401–1411、1856）。作者從 EXIF / IPTC / XMP 讀（author-from-exif.ts）。影音的 `copyright` 標籤也會讀出來（embedded-metadata.ts:26、128）。**沒有授權（license）欄位。** | 人設：名稱、描述、tags、kind。圖片：view、label、寬高、sha256。原作官方圖（`cast_references`）有 `source_url / page_url / score / note / status`（migrations.ts:620–637）。來源影片有 url、site、uploader，以及 yt-dlp 的 `info_path`。**也沒有授權欄位。** | 兩邊都沒有授權欄位。AniRecast 的官方參考圖已經記下出處，真要對外發布時再補一個授權備註即可。 |
| 縮圖 | 縮圖、影片封面、聯絡表、代理檔、色卡、GLB 都登記在 `revision_artifacts`，有 kind、status（pending / generating / ready / failed）、generator_version、invalidated_at（1592–1616、3304–3330）。檔案平鋪在 `.serpent/artifacts/<artifactId>.jpg|webp`（24404、25112）。失敗的衍生檔按錯誤碼區分永久與可重試，可重試的 30 分鐘後退避重排（derived-artifact-repair.ts:29–41、72–140）。 | 來源影片有 `cache/sources/<id>/thumb.jpg` 和代理檔（sources.ts:73；daemon handlers/sources.ts:22）。角色頭像用頭部裁切圖（cast_members.thumb_path）。**人設卡片直接載入原圖**（PersonasPage.tsx:475 `fileUrl(primaryImage(p)?.path)`），參考圖最大到 1144×2048 以上。 | 縮圖沒有登記表，失敗或過時的縮圖不會自己重做。人設庫小，影響有限。 |
| 匯入與匯出 | 匯入：拖放、資料夾遞迴、序列幀、瀏覽器擴充（附來源網址）、直接開 Eagle / Billfish 庫（eagle-library.ts、billfish-library.ts）。匯出：整庫匯出成資料夾或 zip，含 DB 快照與 artifacts，可選含連結資料夾的內容（`exportLibraryToFolder` 49430、`exportLibraryToZip` 50055；收集清單見 49620–49660）。WebDAV 同步：`manifest.json` 以資產為鍵記錄 sha256 與版本號，metadata 另存 sidecar `metadata/entries/<syncId>.json`，人工層和 AI 層分開（sync/manifest.ts:11–28、sync/sync-metadata.ts:1–30）。 | 匯入：來源影片（URL 下載或本機）、人設圖（上傳或 CLI）、官方參考圖（網路搜尋或貼上）。匯出：只有成片 render。`persona.json` 每次變更都會重寫在 refs 旁邊（`writeMirror`，personas.ts:131–139），但**整個 repo 沒有任何程式讀回它**。 | 人設庫沒辦法帶到另一個工作區。mirror 檔已經存在，缺的是讀回去的那一步。 |
| 孤兒清理 | 開庫時對 `.serpent/artifacts/` 做一次清掃：**先從 DB 收集仍被引用的路徑**，只看平鋪的根目錄，跳過 `.tmp`，mtime 在 5 分鐘內的不刪（生成器先寫檔、後寫 DB 列，ORPHAN_ARTIFACT_GRACE_MS，441；`reconcileOrphanArtifactFiles`，31392–31480）。檔案操作有 `file_operations` 日誌（preparing / applying / committed / rolled_back / failed，1247–1257），重開時收拾中斷的操作（9664–9696）。資產用 `deleted_at` 進回收站（1530–1536）。可被 DB 標成 `missing`，可批次重新定位。 | 刪版本時把檔案和旁邊的 `.json` 移到 `trash/versions/<project>/…`，並寫 `versions.json`（versions.ts:32–109、118–207）。來源影片移到 `trash/sources/<id>`（sources.ts:185–233）。**沒有掃描，也沒有「檔案遺失」狀態**。`doctor` 只檢查工具和設定，不檢查檔案（cli doctor.ts:50–190）。檔案先 rename，之後才開 DB 交易（versions.ts:63–69 → 79）。分割、合併鏡頭和重設 keyframes 只動 DB 列，不處理檔案（shots.ts:281 `splitShot`、381–385 `mergeShots`、500 `setKeyframes`）。 | **落差最大的一項**。見下方 probe 摘要：mediaHub 一個專案裡，已被刪除的鏡頭留下的資料夾共約 51 MB（大部分檔案已無引用），另有約 16 MB 沒有引用的 cache 檔。 |
| Agent / 外掛怎麼引用資產 | MCP（本機 loopback HTTP）：每次呼叫都要帶明確的 `libraryId` 和 `assetId`，不保留 session 預設值（docs/manual/mcp/api-reference.md）。寫入帶 `expectedVersion`（command-registry.ts:566–585），換檔帶 `expectedRevisionId`（plugin-sdk.ts:158–161），屬於樂觀鎖。永久刪除走兩階段 challenge（challengeId + planHash + idempotencyKey）。glossary 規定「精確引用」只能是穩定 ID 或唯一的庫內路徑，標籤、搜尋條件都不算。 | Agent 只能透過 CLI 和 skill 操作，不准直接動 `sources/ projects/ library/` 與 DB（agents-md.ts；skills/anirecast/SKILL.md:20）。`tasks show` / `board show` 給 `absPath` 讓 agent 看圖。刪除類操作擋掉 `codex:` actor（versions.ts:40、125）。 | AniRecast 的做法已經夠用，也比較簡單。可借的只有一個小點：人設 PATCH 加樂觀鎖（UI 和 CLI agent 可能同時改）。 |
| 瀏覽與管理 UI | 左側欄（全部、回收站、資料夾、合集、智慧合集），平鋪或瀑布流畫布，右側 Inspector（標籤、評分、描述、來源網址、技術 metadata、AI 結果）。另有標籤管理、過濾面板、重複檔對話框、重新定位預覽（docs/user-guide/basics.md；renderer `InspectorPanel.tsx`、`TagManagementWorkspace.tsx`、`ContentDuplicateDialog.tsx`、`RelinkPreview.tsx`）。 | 人設庫三個分頁，卡片顯示主圖、tags、封存狀態。詳情頁可以放大圖、設主圖、上傳，編輯 label 和 view（PersonasPage.tsx:297–519）。**參考圖只能加不能刪**（daemon 沒有刪除路由，routes.ts:575–617）。trash 只存在磁碟上，UI 看不到。 | 人設庫小，不需要 Serpent 那套。缺的只有兩樣：刪除或隱藏一張參考圖，以及看得到 trash。 |

## 建議（依 價值 ÷ 工作量 排序）

工作量是粗估（人日 = 一個人專心做一天，含測試）。

1. **檔案完整性報告（先只報告，不刪）**。新增 `anirecast workspace check-files`，或掛在 `doctor --files` 底下。
   - 做法：先從 DB 收集**所有**引用路徑，再走 `projects/ cache/ library/` 比對，列出「沒有被引用的檔」和「被引用但不存在的檔」。
   - 引用路徑包括：各表的 path 欄位、版本檔旁邊的 `.json`、`inputs_json[*].path`、`remote_json` / `params_json` 裡的 compare / raw 路徑、detections 的裁切圖。
   - 照 Serpent 的方式：先建引用集合再碰檔案系統，忽略最近幾分鐘內寫入的檔（正在生成的版本）。
   - 價值高：這是所有清理工作的前提，也能發現被引用但遺失的檔。約 1–1.5 人日。
   - 碰到的檔案：新增 `packages/core/src/domain/files.ts`（或 `integrity.ts`），`packages/cli/src/commands/doctor.ts` 或 `workspace.ts`，加測試。
   - 第一步就要把所有路徑來源盤點完整。漏一個，就會把還在用的檔誤判成孤兒。
2. **丟棄或清理版本時，連 cache 的 compare 和 raw 一起搬進 trash**。
   - `discardShotVersions` 的註解說會搬「a take's review compare clip」，但程式只搬 `path` 和 `.json`（versions.ts:55–61）。compare 在 `cache/projects/<slug>/takes/<shot>-tNNN.compare.mp4`（daemon generation.ts:559），raw 在 `…-<takeId>.raw.mp4`（495）。
   - 約 2–3 小時，只改 `versions.ts`，加測試。
3. **合併或分割鏡頭時，把不再被引用的檔搬進 trash**。
   - 被刪鏡頭的 `frames/`、`source.mp4`，以及被刪 keyframes 對應的 frame 圖，照 `trash/versions` 的格式搬到 `trash/shots/<project>/<shotId>-<time>/`，附 manifest。
   - **不能整個資料夾搬走**：合併過來的 board 列 `path` 還指向舊資料夾，舊版本的 `inputs_json` 也可能引用舊 frame。必須沿用第 1 項的引用集合。
   - 約 0.5 人日（在第 1 項完成之後）。檔案：`shots.ts`（`splitShot`、`mergeShots`，以及 281、382、500 行刪 keyframes 的地方）。
4. **人設匯出與匯入**。把現在只寫不讀的 `persona.json` 加上 `refs/` 當作交換格式。
   - 匯入時用 sha256 驗證每張圖，slug 衝突就改名。這相當於 Serpent 的「整庫匯出」和「sync sidecar」，但只做人設庫。
   - 價值：repo 裡已經有 `workspaces/dev-codex`、`fixture-op` 和正式的 mediaHub，人設目前只能手動重建。約 1 人日。
   - 檔案：`personas.ts`（新增 `importPersona`），`packages/cli/src/commands/cast.ts`（`persona export|import`），`apps/daemon/src/api/routes.ts`。
5. **檔案操作的順序與日誌**。現在 `discardShotVersions`、`pruneFailedVersions`、`trashSource` 都是先 rename 檔案、後開 DB 交易。中途出錯會留下「DB 還在、檔案已經搬走」的狀態。
   - 最小改法：先把 `versions.json` 寫成 `pending` 並列出要搬的檔，再搬檔，DB commit 後改成 `done`；daemon 啟動時處理還停在 `pending` 的項目。這是 Serpent `file_operations` 的極簡版。
   - 約 0.5 人日。檔案：`versions.ts`、`sources.ts`、daemon 啟動流程。
6. **人設卡片用縮圖**。新增參考圖時，用 ffmpeg 產一張長邊約 512 px 的縮圖到 `cache/library/<imgId>.jpg`。
   - 檔名或旁邊的 JSON 帶上來源 sha256 和生成器版本，借 `artifactKey` 的想法：換了生成器就重做，cache 整個刪掉也能重建。
   - 約 0.5–1 人日。檔案：`personas.ts`、`references.ts`、`packages/media/src/ffmpeg.ts`、`PersonasPage.tsx`。
   - 人設庫只有 7 個，排在後面。
7. **生成輸出也記 sha256 和大小**。可以寫進 provenance JSON，或在 boards / takes / designs 加欄位。之後完整性報告能分辨「檔案被換掉」和「檔案遺失」。約 0.5 人日。檔案：daemon `handlers/generation.ts`，以及 `migrations.ts`（如果要加欄位）。
8. 其餘價值較低的小項：
   - `persona list --tag` 與 UI 的 tag 過濾（2–3 小時，不需要 tag 表）。
   - 人設 PATCH 帶 `expectedUpdatedAt` 樂觀鎖（約 0.5 人日）。
   - 參考圖「隱藏」：不刪檔、不破壞舊版本的 `inputs_json`（約 0.5 人日）。
   - `cast_references` 加授權備註欄位：等到真的要對外發布時再做。

## 不該學的

- **連結資料夾、重新定位、Eagle / Billfish 匯入、WebDAV 同步**：AniRecast 的工作區是自給自足的，檔案幾乎都是自己生成的。規則是「一個正本、只在一台機器上用」，用不到外部目錄引用和多機同步帶來的複雜度。
- **原地換內容的修訂模型**（`asset.content.replace`、`origin = replace`）：跟 AniRecast「版本只增不改」直接衝突。生成工作需要的是並排比較、審核、approved / stale，Serpent 這一塊反而比較弱。
- **可逆操作歷史**（`operation_history` 三張表、forward / inverse recipe、barrier、stale；library-service.ts:3508–3545）：成本很高。AniRecast 已經有 `events` 稽核紀錄、`trash/` 加 `versions.json`，破壞性操作也只能由人執行。現在需要的是第 5 項的「不留半套狀態」，不是 undo / redo。
- **MCP 伺服器、外掛沙箱（QuickJS）、兩階段 challenge 協定**：AniRecast 的 agent 透過 CLI、skill 和 actor 前綴權限工作，規模剛好。再加一層 MCP 只會出現兩套入口。可以吸收的是原則（明確目標、樂觀鎖），不是這套協定。
- **FTS5、語義搜尋、AI 自動標籤、色卡與顏色過濾**：這些是給上萬素材用的。AniRecast 的參考圖是 planner 和 director 依 view、label 挑的，不是人在大庫裡搜尋。
- **資產名稱等於真實檔名**：AniRecast 刻意只用小寫 ASCII 生成路徑，顯示名稱放在 DB（naming.ts:7、47），這樣跨平台比較安全，應該保留。
- **51k 行的單一 `library-service.ts`**，以及「遷移只加不改」加「寬鬆讀舊庫」的相容紀律：Serpent 要開別人電腦上的舊庫才需要這些。AniRecast 由 daemon 統一遷移，CLI 要求 schema 是最新的（workspace.ts `openWorkspace`），不需要背這個成本。

## 舊 probe 的發現（孤兒檔案）

這段來自前一個中斷的 session 留在 `~/.cache/ranolabs/sessions/2026-10-26-serpent-study/probe/` 的清單（2026-10-26 20:40–20:48 產生，該資料夾已在本次研讀後刪除）。**產生這些清單的腳本沒有保存**。下面的數字是我用 `comm` 交叉比對清單得到的，方法是推回去的，不是重跑。`referenced.txt`（745 條）和 `allref.txt`（1537 條）是兩份收集範圍不同的「被引用路徑」，確切怎麼收集的無從得知。範圍只有專案 `lycoris-op`。

- **磁碟上有 80 個鏡頭資料夾，DB 只有 40 個鏡頭**（`shotdirs.txt` 對 `shotids.txt`）。多出來的 40 個 id 全部出現在事件紀錄裡（`event_shots.txt` 剛好 80 個），跟「合併或分割刪掉了鏡頭列，但沒處理資料夾」相符（shots.ts:381）。2026-10-26 再看一次 `mediaHub/projects/lycoris-op/shots/`，仍然是 80 個資料夾，這 40 個合計約 **51 MB**。
- 這 40 個資料夾裡有 212 個檔：130 張 `frames/*.jpg`、40 個 `source.mp4`、42 個 `boards/b001.jpg|json`。舊 probe 把 212 個全標成孤兒，這是**多算了**：
  - 42 個 board 檔仍然被 DB 引用，因為合併把 board 列搬到存活的鏡頭，`path` 卻沒改。
  - 另有 23 張 frame 出現在 `allref.txt`，推測是舊版本的 `inputs_json`。
  - 真正沒有被任何清單引用的是 **147 個檔（107 張 frame + 40 個 `source.mp4`）**。如果不把歷史 inputs 算作引用，是 170 個。
- `projects/lycoris-op/crops/` 底下以已刪鏡頭 id 命名的資料夾**仍被引用**（`allref.txt` 有 317 條路徑落在這 40 個 id 底下，大多是 crops）。tracklets 搬走了，detections 的裁切圖路徑沒改。所以這些資料夾不能按「鏡頭已不存在」來清。
- 存活的 40 個鏡頭裡，另有 12 個鏡頭共 49 張 `frames/*.jpg` 沒被引用，推測是分割、合併或 `setKeyframes` 重設 keyframes 時刪了列、沒刪檔（shots.ts:281、382、500）。
- `cache/projects/lycoris-op/takes/`：71 個 `*.compare.mp4` 有 18 個沒被引用，71 個 `*.raw.mp4` 有 28 個不在 raw 引用清單，全是 `-tNNN` 命名，合計約 **16 MB**。
  - 現在的程式 raw 改用 take id 命名（daemon generation.ts:495），compare 仍用 `tNNN`（559）。
  - 逐一對照後，這 46 個檔**全部**屬於兩類鏡頭：已被刪除的鏡頭（compare 和 raw 各涉及 12 個鏡頭），或在 `trash/versions/lycoris-op/` 裡有丟棄紀錄的鏡頭（compare 涉及 6 個、raw 涉及 16 個）。這跟第 2 項建議說的「丟棄版本時沒搬 cache」相符。
- 結論：程式碼和清單都指向三個孤兒來源，分別是**分割或合併鏡頭**、**重設 keyframes**、**丟棄版本時漏掉 cache**。清理一定要以完整的引用集合為準（建議 1），不能用「鏡頭 id 已不存在」這種捷徑。

## 未驗證／限制

1. 沒有開 mediaHub 的資料庫。上面的引用數字全部來自舊 probe 的清單，下一步應該由建議 1 的工具在 dry-run 模式重算一次。
2. Serpent 只讀了資產管理相關的程式碼和文件，沒有實際跑起來，UI 的描述來自使用手冊和元件檔名。
3. 建議的工作量是粗估，沒有對照 AniRecast 現有測試的覆蓋範圍。
