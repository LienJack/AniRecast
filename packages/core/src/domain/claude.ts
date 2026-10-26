import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AniError } from '@anirecast/shared';
import { all, run, toJson } from '../db.ts';
import type { Workspace } from '../workspace.ts';
import { askUser, getAgentTask } from './agent-tasks.ts';
import { findActiveClip } from './clips.ts';
import { listBoards, listTakes } from './generation.ts';
import { getProject, projectDir } from './projects.ts';
import { getShot } from './shots.ts';

/** Where a task's brief for Claude Code goes, and the payload it records on the task. */
export interface ClaudeHandoff {
  to: 'claude';
  brief: string;
  reason: string;
  by: string;
  at: number;
}

const money = (usd: number | null | undefined) => (usd ? `USD ${usd.toFixed(2)}` : '—');

/** Who is replaced in a shot and in which of its frames (0 = its first), from the person detections. */
function onScreen(ws: Workspace, shotId: string, startFrame: number): string[] {
  return all<{ label: string; persona: string | null; first: number; last: number }>(
    ws.db,
    `SELECT c.label, p.name AS persona, MIN(d.frame) - :start AS first, MAX(d.frame) - :start AS last
       FROM tracklets t JOIN cast_members c ON c.id = t.cast_member_id
       LEFT JOIN personas p ON p.id = c.persona_id
       JOIN detections d ON d.tracklet_id = t.id
      WHERE t.shot_id = :shot GROUP BY c.id ORDER BY first`,
    { shot: shotId, start: startFrame },
  ).map(
    (r) =>
      `- 「${r.label}」→ ${r.persona ? `"${r.persona}"` : '不替換'}：偵測到的幀 ${r.first}–${r.last}（偵測是抽樣的，實際出現可能更長）`,
  );
}

/**
 * Hands an agent task to Claude Code: writes a brief with everything needed to take over — what the human asked,
 * the shot, every version with its model, range and cost, the target's instruction and references, what the agent
 * tried and suggests — and puts the task to the human with the one command that starts Claude on it. For work
 * Codex cannot do: code changes (its sandbox writes only the workspace) or a problem the CLI cannot reach.
 */
export function handOffToClaude(
  ws: Workspace,
  taskId: string,
  input: { reason: string; tried?: string; plan?: string; repoRoot: string },
  actor: string,
  now: number = Date.now(),
): { brief: string; command: string; question: string } {
  const task = getAgentTask(ws.db, taskId);
  if (task.status === 'done' || task.status === 'cancelled')
    throw new AniError('conflict', `Task ${taskId} is ${task.status}`);
  if (!input.reason.trim()) throw new AniError('usage', 'Say why Claude should take over (--reason)');
  const project = getProject(ws.db, task.projectId);
  const shot = task.shotId ? getShot(ws.db, task.shotId) : null;
  const p = task.payload as {
    targetType?: string;
    targetId?: string;
    comment?: string;
    annotations?: Array<{ type?: string; path?: string }>;
    answerImages?: string[];
  };
  const images = [
    ...(p.annotations ?? []).filter((a) => a.type === 'image' && a.path).map((a) => a.path!),
    ...(p.answerImages ?? []),
  ];
  const lines: string[] = [
    `# 接手 AniRecast 任務 ${task.id}`,
    '',
    `> ${actor} 交給 Claude：${input.reason.trim()}`,
    '',
    '## 位置',
    `- Workspace（資料）：${ws.root}。在這裡執行 \`anirecast\`；stdout 一律是一個 JSON 物件。不要手改 sources/、projects/、library/ 和資料庫。`,
    `- 程式碼：${input.repoRoot}。Claude 可以改；改完執行 \`set -o pipefail; pnpm -s check\`，commit 前看過 git status，只 add 自己改的檔案。`,
    `- 網頁：http://127.0.0.1:7878/projects/${project.slug}/review/${shot?.id ?? ''}`,
    '',
    '## 人類的要求',
    `- 任務種類：${task.kind}，狀態：${task.status}`,
    ...(p.comment ? [`- 意見：${p.comment}`] : []),
    ...images.map((img, i) => `- 附圖 ${i + 1}：${ws.abs(img)}`),
    ...(task.question ? [`- 之前問人類：${task.question}`] : []),
    ...(task.answer ? [`- 人類回答：${task.answer}`] : []),
  ];
  if (shot) {
    const clip = findActiveClip(ws.db, project.id);
    const seconds = clip ? (shot.frameCount * clip.fpsDen) / clip.fpsNum : null;
    lines.push(
      '',
      '## 這一鏡',
      `- 分鏡 #${shot.orderIndex + 1}（${shot.id}），clip 幀 ${shot.startFrame}–${shot.endFrame}，共 ${shot.frameCount} 幀${seconds ? `（${seconds.toFixed(2)} 秒）` : ''}，處理方式 ${shot.mode}`,
      ...(shot.description ? [`- 內容：${shot.description}`] : []),
      `- 原片片段：${shot.sourcePath ? ws.abs(shot.sourcePath) : '（還沒切）'}`,
      ...onScreen(ws, shot.id, shot.startFrame),
      '',
      '### 分鏡圖（通過或待審）',
      ...listBoards(ws.db, shot.id)
        .filter((b) => ['approved', 'ready'].includes(b.status))
        .map((b) => `- ${b.role} v${b.version} ${b.status}：${b.path ? ws.abs(b.path) : '—'}`),
      '',
      '### 影片版本',
      '| 版本 | 狀態 | 模型 | 只重做 | 花費 | 建立者 | 錯誤 |',
      '|---|---|---|---|---|---|---|',
      ...listTakes(ws.db, shot.id).map((t) => {
        const range = t.params.range as { start: number; end: number } | undefined;
        return `| v${t.version} (${t.id}) | ${t.status} | ${t.model.replace(/^fal:/, '')} | ${range ? `${range.start}–${range.end}` : ''} | ${money(t.costUsd)} | ${t.createdBy} | ${(t.error ?? '').slice(0, 80)} |`;
      }),
    );
  }
  if (p.targetType === 'take' && p.targetId) {
    const t = listTakes(ws.db, shot?.id ?? '').find((x) => x.id === p.targetId);
    if (t) {
      const director = t.params.director as
        | { references?: Array<{ id: string; label: string }>; critique?: unknown; notes?: string }
        | undefined;
      lines.push(
        '',
        `## 被評的版本 v${t.version}（${t.id}）`,
        `- 檔案：${t.path ? ws.abs(t.path) : '—'}`,
        ...(director?.notes ? [`- 導演備註：${director.notes}`] : []),
        ...(director?.references ?? []).map((r) => `- 參考 ${r.id}：${r.label}`),
        '',
        '送給模型的指令：',
        '```',
        t.prompt,
        '```',
      );
    }
  }
  lines.push(
    '',
    `## ${actor} 試過的`,
    input.tried?.trim() || '（沒寫）',
    '',
    `## ${actor} 建議的做法`,
    input.plan?.trim() || '（沒寫）',
    '',
    '## 規則',
    '- 付費生成前先估價；超出人類同意的預算要先問。影片一次只跑一支，每支最多重試一次。',
    '- 不要替人類按「通過」。',
    '- 重啟 daemon（`launchctl kickstart -k gui/$(id -u)/dev.anirecast.daemon`）前，確認 `/api/health` 的 activeJobs 為空、佇列為 0；重啟會打斷正在跑的付費影片。',
    `- 完成後：\`anirecast tasks done ${task.id} --note "<改了什麼>"${p.targetType ? ' --result <新版本 id>' : ''}\`。`,
    '',
    '## 常用做法（見 skills/anirecast/SKILL.md 的 Hard shots）',
    `- 只重做一段：\`anirecast take plan ${shot?.id ?? '<shot>'} --range a-b --keep <take> --wait\` 先看指令，再 \`anirecast take generate ${project.slug} ${shot?.id ?? '<shot>'} --range a-b --keep <take>\`。`,
    `- 找鏡頭裡的切鏡：\`anirecast shots cuts ${shot?.id ?? '<shot>'}\`；片段壞了：\`anirecast shots prepare <shot>\`。`,
    '- 錨點圖：`anirecast board generate <project> <shot> --role first|last --force`，再用 `--attach <絕對路徑>` 交給影片，並在 --extra 說明它是哪一幀。',
    '- 檢查：`anirecast take sheet <take>`，或用 ffmpeg 在 ~/.cache/ranolabs/sessions/ 下抽幀對照原片。',
  );
  const rel = `${projectDir(project)}/claude/${task.id}.md`;
  const abs = ws.abs(rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join('\n')}\n`);
  const command = `cd ${input.repoRoot} && claude "接手 AniRecast 任務 ${task.id}：先讀 ${abs}"`;
  const question = `${actor} 交給 Claude 接手：${input.reason.trim()}。要接手的話執行：${command}`;
  const handoff: ClaudeHandoff = {
    to: 'claude',
    brief: rel,
    reason: input.reason.trim(),
    by: actor,
    at: now,
  };
  run(ws.db, 'UPDATE agent_tasks SET payload_json = :payload WHERE id = :id', {
    id: task.id,
    payload: toJson({ ...task.payload, handoff }),
  });
  askUser(ws.db, task.id, question, actor, now);
  return { brief: abs, command, question };
}
