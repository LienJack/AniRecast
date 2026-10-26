import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  all,
  assertWithinBudget,
  type Board,
  type BoardRole,
  createAgentTask,
  getShot,
  listAgentTasks,
  listBoards,
  listKeyframes,
  projectDir,
  projectOfShot,
  queueBoard,
  recordCost,
  roleKeyframe,
  updateBoard,
} from '@anirecast/core';
import { cropGrid, ffmpeg } from '@anirecast/media';
import { estimateVisionCost } from '@anirecast/providers';
import { toEnvelopeError } from '@anirecast/shared';
import type { JobContext } from '../runner.ts';
import { metered } from './metered.ts';

interface Judgement {
  needed?: boolean;
  similarity?: number;
  reason?: string;
}

const MOMENT = {
  type: 'object',
  properties: { needed: { type: 'boolean' }, similarity: { type: 'number' }, reason: { type: 'string' } },
  required: ['needed', 'similarity', 'reason'],
};

/** What JEV decided for a first or last frame of a batch, kept on the key board. */
export interface FollowUpDecision {
  needed: boolean;
  similarity: number | null;
  reason: string;
  boardId: string | null;
}

/**
 * After a batch's key frame is drawn: JEV compares the shot's original first and last frames with its key frame;
 * a moment that is essentially the same picture gets no storyboard frame of its own, the others are queued —
 * drawn from the key frame so the new characters stay identical.
 */
export async function followUpKeyBoard(ctx: JobContext, board: Board): Promise<void> {
  const { workspace: ws, services, signal, job } = ctx;
  const roles = ((board.params.followUps as BoardRole[] | undefined) ?? []).filter((r) => r !== 'key');
  if (board.role !== 'key' || !roles.length || board.params.followUpDecision) return;
  const shot = getShot(ws.db, board.shotId);
  const project = projectOfShot(ws.db, shot.id);
  const frames = listKeyframes(ws.db, shot.id);
  const key = frames.find((k) => k.frame === board.frame) ?? roleKeyframe(ws, shot, 'key');
  const originals = Object.fromEntries(roles.map((r) => [r, roleKeyframe(ws, shot, r)])) as Record<
    BoardRole,
    ReturnType<typeof roleKeyframe>
  >;
  const decision: Partial<Record<BoardRole, FollowUpDecision>> = {};
  // The same frame as the key frame needs nothing more.
  const toJudge = roles.filter((r) => {
    if (originals[r].frame !== key.frame) return true;
    decision[r] = { needed: false, similarity: 1, reason: '和關鍵幀是同一幀', boardId: null };
    return false;
  });
  if (toJudge.length) {
    const model = services.config.models.continuity;
    const images = [key.path, ...toJudge.map((r) => originals[r].path), ...(board.path ? [board.path] : [])];
    try {
      if (services.provider.name !== 'fake')
        assertWithinBudget(ws.db, services.config.budget.capUsd, estimateVisionCost(model, images.length));
      const answer = await metered(ctx, { model, kind: 'vision', shotId: shot.id }, () =>
        services.provider.analyzeImages<Partial<Record<BoardRole, Judgement>>>({
          model,
          prompt: [
            "Image 1 is the key frame of a shot from an anime opening; the next images are the same shot's",
            toJudge.map((r, i) => `${r} frame (Image ${i + 2})`).join(' and '),
            board.path ? `; the last image is the key frame redrawn with replaced characters.` : '.',
            '\nA storyboard frame is drawn for the first or last frame only when it differs meaningfully from the key frame:',
            'another pose, gesture, expression, head or body angle, framing or camera position, other people in view, or different light.',
            'If it is essentially the same picture as the key frame (a still shot, or motion too small to matter for the video model), its own storyboard frame is not needed.',
            `For ${toJudge.join(' and ')} say: needed, similarity to the key frame from 0 to 1, and reason — one short line in Traditional Chinese.`,
          ].join(' '),
          images: images.map((p) => ({
            path: ws.abs(p),
            mimeType: p.endsWith('.png') ? 'image/png' : 'image/jpeg',
          })),
          responseSchema: {
            type: 'object',
            properties: Object.fromEntries(toJudge.map((r) => [r, MOMENT])),
            required: toJudge,
          },
          signal,
        }),
      );
      recordCost(ws.db, {
        jobId: job.id,
        projectId: project.id,
        provider: answer.provider,
        model,
        usage: answer.usage,
        usd: answer.provider === 'fake' ? 0 : answer.costUsd,
      });
      for (const r of toJudge) {
        const j = answer.data?.[r];
        decision[r] = {
          needed: j?.needed !== false,
          similarity: typeof j?.similarity === 'number' ? j.similarity : null,
          reason: (j?.reason ?? '').trim() || (j?.needed === false ? '和關鍵幀幾乎一樣' : '和關鍵幀不同'),
          boardId: null,
        };
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // Without a judgement, draw them: missing a moment costs more than one extra frame.
      for (const r of toJudge)
        decision[r] = {
          needed: true,
          similarity: null,
          reason: `JEV 判斷失敗（${toEnvelopeError(error).message}），照常生成`,
          boardId: null,
        };
    }
  }
  for (const r of roles) {
    const d = decision[r];
    if (!d?.needed) continue;
    try {
      d.boardId = queueBoard(ws, shot.id, 'daemon', {
        role: r,
        consistentWith: board.id,
        model: board.model,
        params: { batch: board.params.batch },
      }).board.id;
    } catch (error) {
      d.needed = false;
      d.reason = toEnvelopeError(error).message;
    }
  }
  updateBoard(ws.db, board.id, { params: { ...board.params, followUpDecision: decision } }, 'daemon');
}

/**
 * When nothing of a 生成全部分鏡圖 batch is left to draw: review sheets (each shot a row — original key frame, key
 * frame, first, last) and a boards_review task for Codex. Once per batch.
 */
export async function finishBoardBatch(ctx: JobContext, board: Board): Promise<void> {
  const { workspace: ws, job, signal } = ctx;
  const batch = typeof board.params.batch === 'string' ? board.params.batch : null;
  if (!batch) return;
  const project = projectOfShot(ws.db, board.shotId);
  const pending = all<{ n: number }>(
    ws.db,
    `SELECT COUNT(*) AS n FROM jobs WHERE type = 'board.generate' AND status IN ('queued', 'running') AND id != :job
       AND json_extract(payload_json, '$.boardId') IN (SELECT id FROM boards WHERE json_extract(params_json, '$.batch') = :batch)`,
    { job: job.id, batch },
  )[0]!.n;
  if (pending > 0) return;
  const reviewed = listAgentTasks(ws.db, { projectId: project.id }).some(
    (t) => t.kind === 'boards_review' && (t.payload as { batch?: string }).batch === batch,
  );
  if (reviewed) return;
  const shotIds = all<{ shot_id: string }>(
    ws.db,
    `SELECT DISTINCT b.shot_id FROM boards b JOIN shots s ON s.id = b.shot_id
      WHERE json_extract(b.params_json, '$.batch') = :batch ORDER BY s.order_index`,
    { batch },
  ).map((r) => r.shot_id);
  // Columns stay put: a moment not drawn is a dark cell.
  const blank = ws.abs(`${projectDir(project)}/boards-review/${batch}/blank.jpg`);
  mkdirSync(path.dirname(blank), { recursive: true });
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0x181818:size=320x180', '-frames:v', '1', blank], {
    signal,
  });
  const rows: Array<{ shotNo: number; cells: string[] }> = [];
  const boards: Array<Record<string, unknown>> = [];
  for (const shotId of shotIds) {
    const shot = getShot(ws.db, shotId);
    const mine = listBoards(ws.db, shotId).filter((b) => b.params.batch === batch);
    const key = mine.find((b) => b.role === 'key');
    const original =
      key?.frame != null ? listKeyframes(ws.db, shotId).find((k) => k.frame === key.frame) : undefined;
    const cells = [
      original?.path,
      ...(['key', 'first', 'last'] as const).map((r) => mine.find((b) => b.role === r)?.path),
    ].map((p) => (p ? ws.abs(p) : blank));
    rows.push({ shotNo: shot.orderIndex + 1, cells });
    for (const b of mine)
      boards.push({
        shotNo: shot.orderIndex + 1,
        shotId,
        role: b.role,
        boardId: b.id,
        version: b.version,
        status: b.status,
        path: b.path,
        ...(b.role === 'key' && b.params.followUpDecision ? { followUps: b.params.followUpDecision } : {}),
      });
  }
  const sheets: string[] = [];
  for (let i = 0; i < rows.length; i += 6) {
    const rel = `${projectDir(project)}/boards-review/${batch}/sheet-${i / 6 + 1}.jpg`;
    await cropGrid(
      rows.slice(i, i + 6).map((r) => r.cells),
      ws.abs(rel),
      { cell: 320, maxPerRow: 4 },
      { signal },
    );
    sheets.push(rel);
  }
  createAgentTask(ws.db, {
    kind: 'boards_review',
    projectId: project.id,
    payload: {
      batch,
      contactSheets: sheets,
      sheetRows: rows.map((r) => r.shotNo),
      columns: ['原片關鍵幀', '關鍵幀分鏡圖', '首幀分鏡圖（有的話）', '尾幀分鏡圖（有的話）'],
      boards,
    },
    createdBy: 'system',
  });
}
