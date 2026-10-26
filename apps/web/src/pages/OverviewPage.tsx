import { Link, useParams } from '@tanstack/react-router';
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotIcon,
  ImageIcon,
  SaveIcon,
  ScanSearchIcon,
  VideoIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DiscussInCodex } from '@/components/codex';
import { ConfirmDialog, EmptyState, ErrorState, Loading, PageHeader, Tag, Thumb } from '@/components/common';
import { ModeBadge, StageBadge, TaskCard } from '@/components/domain';
import { ModelSelect } from '@/components/models';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, fileUrl } from '@/lib/api';
import { formatDuration, formatTime, formatTimecode, formatUsd } from '@/lib/format';
import {
  RENDER_STATUS_LABEL,
  RENDER_STATUS_TONE,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_TONE,
  TIER_LABEL,
  TIERS,
  type Tone,
} from '@/lib/labels';
import { qk, useAction, useOverview, useProjectCost, useWorkspace } from '@/lib/queries';
import type { BoardQueue, GenerationTier, ProjectModels, ProjectOverview, TakeQueue } from '@/lib/types';
import { cn } from '@/lib/utils';

const TONE_BG: Record<Tone, string> = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  info: 'bg-sky-400',
  danger: 'bg-red-500',
  neutral: 'bg-zinc-500',
  muted: 'bg-zinc-700',
  accent: 'bg-violet-400',
};

type StepState = 'done' | 'active' | 'todo';

function pipeline(o: ProjectOverview): Array<{ label: string; state: StepState; detail: string }> {
  const work = o.shots.filter((s) => s.mode === 'replace' || s.mode === 'clean');
  const replace = o.shots.filter((s) => s.mode === 'replace');
  const boardsDone = replace.filter((s) => s.stage.startsWith('take_') || s.stage === 'approved').length;
  const approved = work.filter((s) => s.stage === 'approved').length;
  const mapped = o.cast.filter((c) => c.personaId).length;
  const readyRenders = o.renders.filter((r) => r.status === 'ready');
  const state = (done: boolean, started: boolean): StepState => (done ? 'done' : started ? 'active' : 'todo');
  return [
    {
      label: '節選',
      state: state(o.clip?.status === 'ready', Boolean(o.clip)),
      detail: o.clip ? `${o.clip.frameCount} 幀` : '未設定',
    },
    { label: '分鏡', state: state(o.shots.length > 0, Boolean(o.clip)), detail: `${o.shots.length} 個` },
    {
      label: '角色',
      state: state(o.cast.length > 0 && mapped > 0, o.cast.length > 0),
      detail: `${o.cast.length} 個，${mapped} 個已對應`,
    },
    {
      label: '分鏡圖',
      state: state(replace.length > 0 && boardsDone === replace.length, boardsDone > 0),
      detail: `${boardsDone}/${replace.length}`,
    },
    {
      label: '分鏡視頻',
      state: state(work.length > 0 && approved === work.length, approved > 0),
      detail: `${approved}/${work.length} 通過`,
    },
    {
      label: '成片',
      state: state(
        readyRenders.some((r) => r.kind === 'final'),
        readyRenders.length > 0,
      ),
      detail: `${readyRenders.length} 版`,
    },
  ];
}

/** Which models this project generates with; each request can still pick another on the review page. */
function ModelsCard({ projectRef, models }: { projectRef: string; models: ProjectModels }) {
  const save = useAction(
    (patch: Partial<ProjectModels>) =>
      api.patch(`/api/projects/${encodeURIComponent(projectRef)}/models`, patch),
    { success: '已更新模型', invalidate: [['project']] },
  );
  const row = (slot: keyof ProjectModels, label: string, kind: 'image' | 'video', hint: string) => (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <ModelSelect
        kind={kind}
        value={models[slot]}
        onChange={(id) => save.mutate({ [slot]: id })}
        label={label}
      />
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>模型</CardTitle>
        <span className="ml-auto text-muted-foreground text-xs">
          這個項目預設用的模型；評審頁每次生成也能另選
        </span>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        {row('image', '分鏡圖', 'image', '每個換角分鏡的第一張參考圖')}
        {row('design', '角色設計', 'image', '三視圖、表情、動作')}
        {row('video', '分鏡視頻（Video-to-Video）', 'video', '把原片分鏡改成換角後的版本，幀數對齊原片')}
      </CardContent>
    </Card>
  );
}

/**
 * 畫風與光影: the notes every design, board and take prompt carries (written here, or read from the clip by the
 * vision model), and how many generated shots know their lighting.
 */
function StyleCard({
  projectRef,
  notes,
  shots,
}: {
  projectRef: string;
  notes: string;
  shots: ProjectOverview['shots'];
}) {
  const [text, setText] = useState(notes);
  useEffect(() => setText(notes), [notes]);
  const generated = shots.filter((s) => s.mode === 'replace' || s.mode === 'clean');
  const lit = generated.filter((s) => s.lighting).length;
  const save = useAction(
    () => api.patch(`/api/projects/${encodeURIComponent(projectRef)}/style`, { notes: text }),
    { success: '已儲存畫風說明', invalidate: [['project']] },
  );
  const analyze = useAction(
    (relight: boolean) =>
      api.post(`/api/projects/${encodeURIComponent(projectRef)}/style/analyze`, { relight }),
    { success: '已排入畫風與光影分析', invalidate: [qk.jobs] },
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>畫風與光影</CardTitle>
        <span className="ml-auto text-muted-foreground text-xs">
          角色設計、分鏡圖、分鏡視頻的提示詞都會帶上；光影 {lit}/{generated.length} 個分鏡已分析
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="這部動畫的畫風：線條、臉和眼睛的畫法、頭身比、賽璐璐陰影、配色與飽和度、後製效果…（留空時用原片角色分析的畫風）"
          className="min-h-20 text-xs"
          aria-label="畫風說明"
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={analyze.isPending}
            title="視覺模型看 6 張代表幀寫畫風說明，再逐一看換角／去字分鏡的光影（約 USD 0.1）"
            onClick={() => analyze.mutate(lit > 0 && lit === generated.length)}
          >
            <ScanSearchIcon />
            {lit === generated.length && lit > 0 ? '用 AI 重新分析畫風與光影' : '用 AI 分析畫風與光影'}
          </Button>
          <Button
            size="sm"
            disabled={text.trim() === notes.trim() || save.isPending}
            onClick={() => save.mutate(undefined)}
          >
            <SaveIcon />
            儲存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const overview = useOverview(ref);
  const cost = useProjectCost(ref);
  const workspace = useWorkspace();
  const [batch, setBatch] = useState<'boards' | 'takes' | null>(null);
  // Model for the batch being confirmed: the project's choice unless changed in the dialog.
  const [batchModel, setBatchModel] = useState<string | undefined>(undefined);
  const setTier = useAction(
    (tier: GenerationTier) => api.post(`/api/projects/${encodeURIComponent(ref)}/tier`, { tier }),
    { success: (_r, t) => `生成檔位改為${TIER_LABEL[t]}`, invalidate: [['project'], ['shot'], qk.projects] },
  );
  const report = (r: BoardQueue | TakeQueue, what: string) => {
    toast.success(r.queued.length ? `已排入 ${r.queued.length} 個${what}` : `沒有需要生成的${what}`);
    for (const e of r.errors) toast.error(`${what}無法生成`, { description: e.error.message });
    setBatch(null);
  };
  const genBoards = useAction(
    (model: string | undefined) =>
      api.post<BoardQueue>(`/api/projects/${encodeURIComponent(ref)}/boards`, model ? { model } : {}),
    { onSuccess: (r) => report(r, '分鏡圖') },
  );
  const genTakes = useAction(
    (v: { tier: GenerationTier; model: string | undefined }) =>
      api.post<TakeQueue>(`/api/projects/${encodeURIComponent(ref)}/takes`, {
        tier: v.tier,
        ...(v.model ? { model: v.model } : {}),
      }),
    { onSuccess: (r) => report(r, '分鏡視頻') },
  );

  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  const o = overview.data;
  const fps = o.clip
    ? { num: o.clip.fpsNum, den: o.clip.fpsDen }
    : { num: o.source.fpsNum ?? 24, den: o.source.fpsDen ?? 1 };
  const counts = STAGE_ORDER.map((st) => [st, o.shots.filter((s) => s.stage === st).length] as const).filter(
    ([, n]) => n > 0,
  );
  const tier = o.project.generationTier;
  const provider = workspace.data?.config.provider;

  return (
    <div className="flex flex-col">
      <PageHeader
        title={o.project.name}
        description={
          <span>
            來源：{o.source.title} · {formatDuration(o.source.durationMs)} · {o.source.width}×
            {o.source.height}
            {o.clip
              ? ` · 節選 v${o.clip.version}：${formatTimecode(o.clip.inFrame, fps)} – ${formatTimecode(o.clip.outFrame, fps)}`
              : ''}
          </span>
        }
        actions={
          <>
            <DiscussInCodex projectRef={ref} targetType="project" what="整個項目" />
            <span className="text-muted-foreground text-xs">生成檔位</span>
            <Select value={tier} onValueChange={(v) => setTier.mutate(v as GenerationTier)}>
              <SelectTrigger size="sm" aria-label="生成檔位">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TIER_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <div className="flex flex-col gap-4 p-5">
        <Card>
          <CardContent className="grid grid-cols-2 gap-2 md:grid-cols-6">
            {pipeline(o).map((step) => (
              <div
                key={step.label}
                className={cn(
                  'flex items-center gap-2 rounded-md border p-2',
                  step.state === 'done' && 'border-emerald-500/30 bg-emerald-500/5',
                  step.state === 'active' && 'border-sky-500/30 bg-sky-500/5',
                )}
              >
                {step.state === 'done' ? (
                  <CheckCircle2Icon className="size-4 text-emerald-400" />
                ) : step.state === 'active' ? (
                  <CircleDotIcon className="size-4 text-sky-300" />
                ) : (
                  <CircleDashedIcon className="size-4 text-muted-foreground" />
                )}
                <div className="flex flex-col">
                  <span className="font-medium text-xs">{step.label}</span>
                  <span className="text-[11px] text-muted-foreground">{step.detail}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <ModelsCard projectRef={ref} models={o.models} />
        <StyleCard projectRef={ref} notes={String(o.project.settings.styleNotes ?? '')} shots={o.shots} />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card>
            <CardHeader>
              <CardTitle>分鏡進度</CardTitle>
              <div className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!o.shots.length}
                  onClick={() => {
                    setBatchModel(undefined);
                    setBatch('boards');
                  }}
                >
                  <ImageIcon />
                  全部關鍵分鏡生成分鏡圖
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!o.shots.length}
                  onClick={() => {
                    setBatchModel(undefined);
                    setBatch('takes');
                  }}
                >
                  <VideoIcon />
                  排入分鏡視頻（{TIER_LABEL[tier]}）
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {o.shots.length ? (
                <>
                  <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-secondary">
                    {counts.map(([st, n]) => (
                      <div
                        key={st}
                        className={TONE_BG[STAGE_TONE[st]]}
                        style={{ width: `${(n / o.shots.length) * 100}%` }}
                        title={`${STAGE_LABEL[st]} ${n}`}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {counts.map(([st, n]) => (
                      <Tag key={st} tone={STAGE_TONE[st]}>
                        {STAGE_LABEL[st]} {n}
                      </Tag>
                    ))}
                  </div>
                  <table className="w-full text-xs">
                    <thead className="text-left text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-1.5 font-normal">#</th>
                        <th className="py-1.5 font-normal">畫面</th>
                        <th className="py-1.5 font-normal">處理方式</th>
                        <th className="py-1.5 font-normal">階段</th>
                        <th className="py-1.5 text-right font-normal">長度</th>
                        <th className="py-1.5 text-right font-normal">角色</th>
                        <th className="py-1.5 text-right font-normal">字幕</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {o.shots.map((s) => (
                        <tr key={s.id} className="border-b border-border/50">
                          <td className="py-1 font-mono">{s.orderIndex + 1}</td>
                          <td className="py-1">
                            <Thumb
                              src={fileUrl(s.thumb)}
                              alt={`分鏡 ${s.orderIndex + 1}`}
                              className="h-9 w-16 rounded"
                            />
                          </td>
                          <td className="py-1">
                            <ModeBadge mode={s.mode} />
                          </td>
                          <td className="py-1">
                            <StageBadge stage={s.stage} />
                          </td>
                          <td
                            className={cn(
                              'py-1 text-right font-mono',
                              (s.seconds ?? 0) > 10 && 'text-amber-300',
                            )}
                          >
                            {s.seconds?.toFixed(2)}s
                          </td>
                          <td className="py-1 text-right font-mono">{s.castCount}</td>
                          <td className="py-1 text-right font-mono">{s.overlays}</td>
                          <td className="py-1 text-right">
                            <Link
                              to="/projects/$ref/review/$shotId"
                              params={{ ref, shotId: s.id }}
                              className="text-primary hover:underline"
                            >
                              評審
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : (
                <EmptyState>
                  還沒有分鏡。
                  <Link to="/projects/$ref/clip" params={{ ref }} className="text-primary hover:underline">
                    前往原片與節選
                  </Link>
                </EmptyState>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>成本</CardTitle>
                <span className="ml-auto text-muted-foreground text-xs">供應器 {provider ?? '—'}</span>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {cost.data ? (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="font-semibold text-xl">{formatUsd(cost.data.totalUsd)}</span>
                      <span className="text-muted-foreground text-xs">
                        這個項目 · 上限 {cost.data.capUsd === null ? '未設定' : formatUsd(cost.data.capUsd)}
                      </span>
                    </div>
                    {cost.data.breakdown.length ? (
                      <table className="w-full text-xs">
                        <tbody>
                          {cost.data.breakdown.map((b) => (
                            <tr key={`${b.model}-${b.tier}`} className="border-b border-border/50">
                              <td className="py-1">{b.model}</td>
                              <td className="py-1 text-muted-foreground">
                                {b.tier ? (TIER_LABEL[b.tier as GenerationTier] ?? b.tier) : ''}
                              </td>
                              <td className="py-1 text-right font-mono">{b.calls} 次</td>
                              <td className="py-1 text-right font-mono">{formatUsd(b.usd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        還沒有付費呼叫（fake 供應器不計費）。
                      </span>
                    )}
                    {(cost.data.quota ?? [])
                      .filter((q) => q.limit !== null)
                      .map((q) => (
                        <div
                          key={q.model}
                          className={`text-xs ${q.exhausted || q.remaining === 0 ? 'text-red-300' : 'text-muted-foreground'}`}
                          title="整個 Workspace 今天送出的請求；被安全過濾擋下的也算"
                        >
                          {q.model} 今日 {q.used}/{q.limit} 次{q.pending ? ` · 排隊 ${q.pending}` : ''}
                          {q.exhausted ? ' · 配額已用完' : ''} · {formatTime(q.resetsAt)} 重置
                        </div>
                      ))}
                  </>
                ) : cost.isError ? (
                  <ErrorState error={cost.error} className="m-0" />
                ) : (
                  <Loading className="p-0" />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>進行中的 Agent 任務</CardTitle>
                <Link
                  to="/projects/$ref/tasks"
                  params={{ ref }}
                  className="ml-auto text-primary text-xs hover:underline"
                >
                  任務中心
                </Link>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {o.openTasks.map((t) => (
                  <TaskCard key={t.id} task={t} showShot projectSlug={o.project.slug} />
                ))}
                {!o.openTasks.length ? (
                  <span className="text-muted-foreground text-xs">沒有進行中的任務。</span>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>成片</CardTitle>
                <Link
                  to="/projects/$ref/renders"
                  params={{ ref }}
                  className="ml-auto text-primary text-xs hover:underline"
                >
                  全部
                </Link>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5">
                {[...o.renders]
                  .sort((a, b) => b.version - a.version)
                  .slice(0, 5)
                  .map((r) => (
                    <div key={r.id} className="flex items-center gap-2 text-xs">
                      <span className="font-mono">r{String(r.version).padStart(3, '0')}</span>
                      <Tag tone={r.kind === 'final' ? 'accent' : 'neutral'}>
                        {r.kind === 'draft' ? '草稿' : '正式'}
                      </Tag>
                      <Tag tone={RENDER_STATUS_TONE[r.status] ?? 'neutral'}>
                        {RENDER_STATUS_LABEL[r.status] ?? r.status}
                      </Tag>
                      <span className="ml-auto text-muted-foreground">{formatTime(r.createdAt)}</span>
                    </div>
                  ))}
                {!o.renders.length ? (
                  <span className="text-muted-foreground text-xs">還沒有成片。</span>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={batch !== null}
        onOpenChange={(open) => !open && setBatch(null)}
        title={batch === 'boards' ? '為所有換角分鏡生成分鏡圖？' : `排入分鏡視頻（${TIER_LABEL[tier]}）？`}
        description={
          batch === 'boards'
            ? '每個換角分鏡各生成一張新的分鏡圖。使用真實供應器時會產生費用。'
            : '只排入還需要生成的換角與去字分鏡（待生成、已過期或失敗的）。使用真實供應器時會產生費用。'
        }
        confirmLabel="開始生成"
        pending={genBoards.isPending || genTakes.isPending}
        onConfirm={() => {
          const model = batchModel ?? (batch === 'boards' ? o.models.image : o.models.video);
          if (batch === 'boards') genBoards.mutate(model);
          else genTakes.mutate({ tier, model });
        }}
      >
        {batch ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">用哪個模型</span>
            <ModelSelect
              kind={batch === 'boards' ? 'image' : 'video'}
              value={batchModel ?? (batch === 'boards' ? o.models.image : o.models.video)}
              onChange={setBatchModel}
              label={batch === 'boards' ? '分鏡圖模型' : '分鏡視頻模型'}
            />
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
