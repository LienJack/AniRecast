/** AGENTS.md written into every workspace root so Codex knows how to operate it (refined in S8). */
export function workspaceAgentsMd(name: string): string {
  return `# AniRecast Workspace：${name}

這個資料夾是 AniRecast 的 Workspace。用 \`anirecast\` CLI 操作，不要直接修改裡面的檔案。

- 每個指令的 stdout 都是一個 JSON 物件 \`{ "ok": true, "data": … }\` 或 \`{ "ok": false, "error": … }\`；進度寫在 stderr。
- 先跑 \`anirecast workspace status\` 確認 Workspace 與服務狀態；服務沒在跑時，任務不會被處理。
- 生成類工作（分鏡圖、分鏡視頻、合成）由 AniRecast 服務執行。你負責排任務、讀結果、依評審意見調整提示詞。
- 不要直接刪除或覆寫 \`sources/\`、\`projects/\`、\`library/\` 底下的檔案；版本只增不改。
- 評審的通過與否由人類決定；你可以提出建議，但不要代替人類按「通過」。
`;
}
