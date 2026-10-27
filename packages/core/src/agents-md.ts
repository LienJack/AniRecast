import { fileURLToPath } from 'node:url';

/** The AniRecast code repository (this checkout), named in the Claude guide. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

/** AGENTS.md written into every workspace root so Codex knows how to operate it (refined in S8). */
export function workspaceAgentsMd(name: string): string {
  return `# AniRecast Workspace：${name}

這個資料夾是 AniRecast 的 Workspace（動漫 OP 角色替換）。一律用 \`anirecast\` CLI 操作，詳細流程見 anirecast skill。

- 在這個資料夾（Workspace 根目錄）執行指令；stdout 一定是一個 JSON 物件 \`{ "ok": true, "data": … }\` 或 \`{ "ok": false, "error": … }\`，進度在 stderr。
- 先跑 \`anirecast workspace status\`；服務沒在跑時任務不會被處理，請告訴人類。
- 模型呼叫、下載、生成都由 AniRecast 服務執行；你負責排任務、讀結果、依評審意見調整提示詞。
- 不要直接新增、修改或刪除 \`sources/\`、\`projects/\`、\`library/\` 與資料庫；版本只增不改。唯一例外是 Codex 討論自己的資料夾 \`projects/<項目>/codex/<hof_…>/\`：結論寫成那裡的 \`result.json\`，草稿放 \`work/\`。
- 評審的「通過」只能由人類決定；人類鎖定的角色歸屬不要改動。
- 處理 AniRecast 任務：\`anirecast tasks show <task>\`，完成後 \`anirecast tasks done <task> --note "…"\`。
- 難的鏡頭（多人、運鏡、切鏡、打鬥）照 anirecast skill 的「Hard shots」；只有一段不對時用 \`take generate … --range a-b --keep <版本>\` 只重做那一段（\`anirecast shots cuts <鏡頭>\` 找切鏡）。
- 需要改程式或 CLI 做不到時：\`anirecast tasks handoff <task> --to claude --reason "…"\` 交給 Claude 接手。
- Codex 討論（\`hof_…\`）是和人類的多輪對話，不是任務：先讀它的 \`BRIEF.md\`，提出做法後等人類回覆；達成共識後寫 \`result.json\` 並執行 \`anirecast codex submit <hof_…>\`。
`;
}

/**
 * CLAUDE.md beside it, for Claude Code started in the workspace: imports AGENTS.md, then what differs for Claude —
 * the main operator, which works its tasks from the TUI and may change the code.
 */
export function workspaceClaudeMd(name: string, repoRoot: string = REPO_ROOT): string {
  return `# AniRecast Workspace：${name}（Claude Code）

@AGENTS.md

## 給 Claude Code

上面的 AGENTS.md 是 Workspace 的共同規則；跟它不同的地方以這裡為準。

- 你（Claude）是這個 Workspace 的主要操作者：評審意見和其他 Agent 任務預設都交給 Claude，等你處理時維持「排隊中」；Codex 只接人類在網頁上指定給它的任務。
- 人類說「處理任務」：\`anirecast tasks next --for claude\` 領一個 → 照 anirecast skill 的「Handling an agent task」做 → \`anirecast tasks done <task> --note "…" [--result <新版本>]\`，再領下一個，直到沒有任務。說不清或試兩次仍不對：\`anirecast tasks ask <task> --question "…"\`。
- 分析鏡頭、分析人物、生成設計圖、生成分鏡圖、合成等要求，對照 anirecast skill 的「從 Claude Code 操作」。
- 看圖用 Read 開 PNG（指令回傳的 \`absPath\`）；影片看不了，用 \`anirecast take sheet <take>\` 看對照圖。
- 會花錢的生成先列出要做什麼和預估花費，人類同意後才排。不要按「通過」。
- \`tasks handoff --to claude\` 是給 Codex 用的，你不用執行。
- 程式碼在 \`${repoRoot}\`，可以改：改完跑 \`set -o pipefail; pnpm -s check\`，commit 前看過 diff；daemon 要重啟才會用到新程式。
`;
}
