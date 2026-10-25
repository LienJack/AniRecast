/** AGENTS.md written into every workspace root so Codex knows how to operate it (refined in S8). */
export function workspaceAgentsMd(name: string): string {
  return `# AniRecast Workspace：${name}

這個資料夾是 AniRecast 的 Workspace（動漫 OP 角色替換）。一律用 \`anirecast\` CLI 操作，詳細流程見 anirecast skill。

- 在這個資料夾（Workspace 根目錄）執行指令；stdout 一定是一個 JSON 物件 \`{ "ok": true, "data": … }\` 或 \`{ "ok": false, "error": … }\`，進度在 stderr。
- 先跑 \`anirecast workspace status\`；服務沒在跑時任務不會被處理，請告訴人類。
- 模型呼叫、下載、生成都由 AniRecast 服務執行；你負責排任務、讀結果、依評審意見調整提示詞。
- 不要直接新增、修改或刪除 \`sources/\`、\`projects/\`、\`library/\` 與資料庫；版本只增不改。
- 評審的「通過」只能由人類決定；人類鎖定的角色歸屬不要改動。
- 處理 AniRecast 任務：\`anirecast tasks show <task>\`，完成後 \`anirecast tasks done <task> --note "…"\`。
`;
}
