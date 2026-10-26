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
