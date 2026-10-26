import {
  CheckIcon,
  ImageIcon,
  RefreshCwIcon,
  SendIcon,
  SparklesIcon,
  UndoIcon,
  VideoIcon,
  WandIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DiscussInCodex } from '@/components/codex';
import { DirectorNote } from '@/components/director-note';
import { ShimmerText, useActiveJob } from '@/components/generating';
import { ModelSelect } from '@/components/models';
import { EMPTY_PROMPT, PromptBox, type PromptValue, promptFields } from '@/components/prompt-box';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { BOARD_ROLE_LABEL, TIER_LABEL } from '@/lib/labels';
import { useAction, useModels, useOverview } from '@/lib/queries';
import type { AgentTask, Board, BoardRole, GenerationTier, ShotDetail, Take } from '@/lib/types';

type Queue = { queued: unknown[]; errors: Array<{ error: { message: string } }> };
const FINISHED = ['ready', 'approved', 'stale', 'rejected'];
const isBusy = (v: { status: string } | undefined) => v?.status === 'queued' || v?.status === 'generating';
const invalidate = [['shot'], ['project']];

/**
 * The model a panel's buttons use: picked here, else — for a storyboard frame — the shown version's own (if in the
 * catalogue), else the project's. Videos always start from the project's video model, whatever made the one on show.
 */
function useModelPick(kind: 'image' | 'video', version: { model: string } | undefined, projectRef: string) {
  const catalogue = useModels().data;
  const project = useOverview(projectRef).data?.models;
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const list = kind === 'image' ? catalogue?.image : catalogue?.video;
  const own =
    kind === 'image' && version && list?.some((m) => m.id === version.model) ? version.model : undefined;
  return [picked ?? own ?? (kind === 'image' ? project?.image : project?.video), setPicked] as const;
}

const copy = (text: string, done: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast.success(done),
    () => toast.error('無法寫入剪貼簿', { description: text }),
  );

/**
 * What Codex is doing with the feedback on this version, and 交給 Claude 接手: a brief for Claude Code and the
 * command that starts it, copied for the terminal (Codex hands over on its own when the fix needs code).
 */
function WorkingTasks({ tasks, targetId }: { tasks: AgentTask[]; targetId: string | undefined }) {
  const working = tasks.filter(
    (t) =>
      (t.payload as { targetId?: string }).targetId === targetId && !['done', 'cancelled'].includes(t.status),
  );
  const handOff = useAction(
    (id: string) =>
      api.post<{ command: string }>(`/api/tasks/${id}/handoff`, { reason: '人類要 Claude 接手' }),
    {
      invalidate: [['shot'], ['project']],
      onSuccess: (r) => void copy(r.command, '交接資料已整理，接手指令已複製：貼到終端機執行'),
    },
  );
  return working.map((t) => {
    const handoff = (t.payload as { handoff?: { to: string } }).handoff;
    const command = handoff ? t.question?.split('執行：')[1]?.trim() : undefined;
    return (
      <div key={t.id} className="flex flex-wrap items-center gap-1.5 text-[11px] text-sky-200">
        <span>
          {handoff
            ? `已交給 Claude 接手：${(t.question ?? '').split('。要接手')[0]}`
            : `Codex ${t.status === 'needs_user' ? `需要你回覆：${t.question ?? ''}` : '正在依意見修改…'}`}
        </span>
        {command ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            title={command}
            onClick={() => void copy(command, '接手指令已複製：貼到終端機執行')}
          >
            複製接手指令
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            disabled={handOff.isPending}
            title="把意見、這一鏡的版本、Codex 試過的整理成交接資料，複製讓 Claude Code 接手的指令"
            onClick={() => handOff.mutate(t.id)}
          >
            交給 Claude 接手
          </Button>
        )}
      </div>
    );
  });
}

/**
 * Under a storyboard frame: generate this moment alone, approve it, regenerate it (another model if picked), and
 * say what to change — redrawn at once by the AI director, or handed to Codex — with images attached.
 */
export function BoardActions({
  projectRef,
  shotId,
  role,
  board,
  tasks,
}: {
  projectRef: string;
  shotId: string;
  role: BoardRole;
  board: Board | undefined;
  tasks: AgentTask[];
}) {
  const label = BOARD_ROLE_LABEL[role];
  const [model, setModel] = useModelPick('image', board, projectRef);
  const [say, setSay] = useState<PromptValue>(EMPTY_PROMPT);
  const finished = board && FINISHED.includes(board.status);
  const generate = useAction(
    (fromBoardId: string | undefined) =>
      api.post<Queue>(`/api/projects/${encodeURIComponent(projectRef)}/boards`, {
        shotIds: [shotId],
        // Asked for by a person: drawn even where detection saw nobody (someone only partly in view).
        ...(fromBoardId ? { fromBoardId } : { role, force: true }),
        ...(model ? { model } : {}),
        ...promptFields(say),
      }),
    {
      invalidate,
      onSuccess: (r) => {
        if (r.queued.length) toast.success(`已排入${label}分鏡圖`);
        for (const e of r.errors) toast.error(`${label}無法生成`, { description: e.error.message });
        setSay(EMPTY_PROMPT);
      },
    },
  );
  const review = useAction(
    (verdict: 'approve' | 'regenerate' | 'changes') =>
      api.post('/api/reviews', {
        targetId: board?.id,
        verdict,
        ...(verdict === 'changes' ? promptFields(say, 'comment') : {}),
        ...(verdict === 'regenerate' && model ? { model } : {}),
      }),
    {
      invalidate,
      success: (_r, v) =>
        v === 'approve' ? `${label}已通過` : v === 'regenerate' ? '已排入重新生成' : '意見已交給 Codex',
      onSuccess: (_r, v) => {
        if (v === 'changes') setSay(EMPTY_PROMPT);
      },
    },
  );
  const said = Boolean(say.text.trim() || say.images.length);
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground text-xs">模型</span>
        <ModelSelect
          kind="image"
          value={model}
          onChange={setModel}
          label={`${label}分鏡圖模型`}
          className="w-44"
        />
        {!board || board.status === 'failed' ? (
          <Button size="sm" disabled={generate.isPending} onClick={() => generate.mutate(undefined)}>
            <ImageIcon />
            {board ? '再' : ''}生成{label}
          </Button>
        ) : null}
        {finished && board.status !== 'approved' ? (
          <Button
            size="sm"
            variant="success"
            disabled={review.isPending}
            onClick={() => review.mutate('approve')}
          >
            <CheckIcon />
            通過{label}
          </Button>
        ) : null}
        {finished ? (
          <Button
            size="sm"
            variant="outline"
            disabled={review.isPending}
            title="同樣的輸入再畫一次（用左邊選的模型）"
            onClick={() => review.mutate('regenerate')}
          >
            <RefreshCwIcon />
            重新生成
          </Button>
        ) : null}
        {finished ? (
          <DiscussInCodex
            projectRef={projectRef}
            targetType="board"
            targetId={board.id}
            what={`${label}分鏡圖 v${board.version}`}
            label="Codex 討論"
            variant="ghost"
          />
        ) : null}
      </div>
      {isBusy(board) ? null : (
        <PromptBox
          projectRef={projectRef}
          value={say}
          onChange={setSay}
          label={`${label}的意見或要求`}
          placeholder={
            finished
              ? `對${label}的意見：例如「頭再低一點、表情更驚訝」（可以附圖、貼上或拖進來）`
              : `給 AI 導演的要求（可留空；可以附圖）`
          }
          onSubmit={() => (finished && said ? generate.mutate(board.id) : undefined)}
        />
      )}
      {finished ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={!said || generate.isPending}
            title="不經過 Codex：AI 導演照這段話和附圖直接重畫"
            onClick={() => generate.mutate(board.id)}
          >
            <WandIcon />
            照這段話重畫
          </Button>
          <Button
            size="sm"
            disabled={!say.text.trim() || review.isPending}
            title="交給 Codex：它會看圖和你的附圖、改提示詞、重畫並檢查"
            onClick={() => review.mutate('changes')}
          >
            <SendIcon />
            要求修改（Codex）
          </Button>
        </div>
      ) : null}
      <WorkingTasks tasks={tasks} targetId={board?.id} />
    </div>
  );
}

/**
 * Under the shot video: model, 預覽 AI 提示詞, generate or regenerate, approve, keep the original, and what to
 * change — redone at once by the director or handed to Codex — with images attached.
 */
export function TakeActions({
  projectRef,
  d,
  take,
  tier,
  onKeepOriginal,
}: {
  projectRef: string;
  d: ShotDetail;
  take: Take | undefined;
  tier: GenerationTier;
  onKeepOriginal: () => void;
}) {
  const shot = d.shot;
  const [model, setModel] = useModelPick('video', take, projectRef);
  const [say, setSay] = useState<PromptValue>(EMPTY_PROMPT);
  const [force, setForce] = useState(false);
  const finished = take && FINISHED.includes(take.status);
  const keyApproved = d.boards.some((b) => b.role === 'key' && b.status === 'approved');
  const needsBoard = shot.mode === 'replace' && !keyApproved;
  const catalogue = useModels().data;
  const modelLabel = (id: string | undefined) => catalogue?.video.find((m) => m.id === id)?.label ?? id;
  const generate = useAction(
    (fromTakeId: string | undefined) =>
      api.post<Queue>(`/api/projects/${encodeURIComponent(projectRef)}/takes`, {
        shotIds: [shot.id],
        tier,
        force,
        ...(fromTakeId ? { fromTakeId } : {}),
        ...(model ? { model } : {}),
        ...promptFields(say),
      }),
    {
      invalidate,
      onSuccess: (r) => {
        if (r.queued.length) toast.success('已排入分鏡視頻');
        for (const e of r.errors) toast.error('分鏡視頻無法生成', { description: e.error.message });
        setSay(EMPTY_PROMPT);
      },
    },
  );
  const review = useAction(
    (verdict: 'approve' | 'regenerate' | 'changes') =>
      api.post('/api/reviews', {
        targetId: take?.id,
        verdict,
        ...(verdict === 'changes' ? promptFields(say, 'comment') : {}),
        ...(verdict === 'regenerate' && model ? { model } : {}),
      }),
    {
      invalidate,
      success: (_r, v) =>
        v === 'approve' ? '分鏡視頻已通過' : v === 'regenerate' ? '已排入重新生成' : '意見已交給 Codex',
      onSuccess: (_r, v) => {
        if (v === 'changes') setSay(EMPTY_PROMPT);
      },
    },
  );
  const planning = useActiveJob('shotId', shot.id, 'take.plan');
  const preview = useAction(
    () => api.post(`/api/shots/${shot.id}/takes/plan`, { ...(model ? { model } : {}), ...promptFields(say) }),
    { success: '已排入：AI 導演看片並撰寫提示詞（約 USD 0.01–0.03）', invalidate: [['jobs']] },
  );
  const still = useAction(() => api.post(`/api/shots/${shot.id}/still-take`, { tier }), {
    success: '已排入：用分鏡圖做靜態鏡頭（不呼叫模型、不收費）',
    invalidate,
  });
  const said = Boolean(say.text.trim() || say.images.length);
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground text-xs">模型</span>
        <ModelSelect kind="video" value={model} onChange={setModel} label="分鏡視頻模型" className="w-52" />
        {!take || take.status === 'failed' ? (
          <Button
            size="sm"
            disabled={generate.isPending || (needsBoard && !force)}
            title={needsBoard && !force ? '關鍵幀分鏡圖通過後才能生成（或勾選強制生成）' : undefined}
            onClick={() => generate.mutate(undefined)}
          >
            <VideoIcon />
            {take ? '再' : ''}生成分鏡視頻
          </Button>
        ) : null}
        {finished && take.status !== 'approved' ? (
          <Button
            size="sm"
            variant="success"
            disabled={review.isPending}
            onClick={() => review.mutate('approve')}
          >
            <CheckIcon />
            通過
          </Button>
        ) : null}
        {finished ? (
          <Button
            size="sm"
            variant="outline"
            disabled={review.isPending}
            title="同樣的輸入再生成一次（用左邊選的模型）"
            onClick={() => review.mutate('regenerate')}
          >
            <RefreshCwIcon />
            重新生成
          </Button>
        ) : null}
        {shot.mode === 'replace' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(planning) || preview.isPending}
            title="AI 導演看原片、分鏡圖和設定集，寫好提示詞、整理要送的參考圖；不生成視頻"
            onClick={() => preview.mutate(undefined)}
          >
            <SparklesIcon />
            {planning ? <ShimmerText>AI 導演看片中…</ShimmerText> : '預覽 AI 提示詞'}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onKeepOriginal}>
          <UndoIcon />
          此鏡沿用原片
        </Button>
        {finished ? (
          <DiscussInCodex
            projectRef={projectRef}
            targetType="take"
            targetId={take.id}
            what={`分鏡 #${shot.orderIndex + 1} 的分鏡視頻 v${take.version}`}
            label="Codex 討論"
            variant="ghost"
          />
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">輸出 {TIER_LABEL[tier]}</span>
      </div>
      {isBusy(take) ? null : (
        <PromptBox
          projectRef={projectRef}
          value={say}
          onChange={setSay}
          label="分鏡視頻的意見或要求"
          placeholder={
            finished
              ? '對這段視頻的意見：例如「轉身慢一點、裙擺別飄」（可以附圖、貼上或拖進來）'
              : '給 AI 導演的要求（可留空；可以附圖）'
          }
          onSubmit={() => (finished && said ? generate.mutate(take.id) : undefined)}
        />
      )}
      {finished ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={!said || generate.isPending}
            title="不經過 Codex：AI 導演照這段話和附圖直接重做"
            onClick={() => generate.mutate(take.id)}
          >
            <WandIcon />
            照這段話重做
          </Button>
          <Button
            size="sm"
            disabled={!say.text.trim() || review.isPending}
            title="交給 Codex：它會看片段、你的附圖，改提示詞、重做並檢查"
            onClick={() => review.mutate('changes')}
          >
            <SendIcon />
            要求修改（Codex）
          </Button>
        </div>
      ) : null}
      {needsBoard && (!take || take.status === 'failed') ? (
        <Label className="text-[11px]">
          <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
          關鍵幀分鏡圖還沒通過，仍然強制生成
        </Label>
      ) : null}
      {keyApproved ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          disabled={still.isPending}
          title="影片模型一直擋這個分鏡時使用：把已通過的關鍵幀分鏡圖做成同長度的鏡頭，帶一點推近"
          onClick={() => still.mutate(undefined)}
        >
          <ImageIcon />
          改用分鏡圖做靜態鏡頭
        </Button>
      ) : null}
      {d.takePlan?.status === 'failed' && !planning ? (
        <span className="text-red-300 text-xs">預覽失敗：{d.takePlan.error ?? ''}</span>
      ) : null}
      {d.takePlan?.result && !planning ? (
        <>
          <span className="text-[11px] text-muted-foreground">
            {modelLabel(d.takePlan.result.model)} 的預覽 · 生成時 AI 導演會再看一次
          </span>
          <DirectorNote
            params={{ director: d.takePlan.result.director }}
            prompt={d.takePlan.result.prompt}
            refLabel={(i) => `<IMAGE_REF_${i}>`}
          />
        </>
      ) : null}
      <WorkingTasks tasks={d.tasks} targetId={take?.id} />
    </div>
  );
}
