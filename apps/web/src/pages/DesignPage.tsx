import { Link, useParams } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  CheckIcon,
  PaletteIcon,
  RefreshCwIcon,
  SaveIcon,
  ScanSearchIcon,
  SendIcon,
  SparklesIcon,
  WandIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { DiscussInCodex } from '@/components/codex';
import { EmptyState, ErrorState, Loading, PageHeader, Tag, Thumb } from '@/components/common';
import { ActorLink, VersionBadge } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, fileUrl } from '@/lib/api';
import { formatAgo, formatUsd } from '@/lib/format';
import { VERDICT_LABEL, VERDICT_TONE } from '@/lib/labels';
import { qk, useAction, useDesigns, usePersonas, useProjectTasks } from '@/lib/queries';
import type {
  AgentTask,
  AnalysisItem,
  BindingDesigns,
  CastAnalysis,
  DesignKind,
  UnboundCast,
} from '@/lib/types';
import { cn } from '@/lib/utils';

const KIND_TEXT: Record<DesignKind, { title: string; hint: string }> = {
  turnaround: { title: '三視圖', hint: '正面、側面、背面全身，服裝與配色以這張為準' },
  expressions: { title: '表情', hint: '常用表情，臉型與五官要和三視圖一致' },
  poses: { title: '動作', hint: '常見動作與姿勢，看身形比例與動態' },
};

type Sheet = BindingDesigns['sheets'][number];
type Version = Sheet['versions'][number];

const isFinished = (v: Version) => ['ready', 'approved', 'stale', 'rejected'].includes(v.status);

/** One sheet (turnaround, expressions or poses) of one character: its versions, reviews and actions. */
function SheetPanel({
  projectRef,
  castId,
  personaName,
  sheet,
  tasks,
}: {
  projectRef: string;
  castId: string;
  personaName: string;
  sheet: Sheet;
  tasks: AgentTask[];
}) {
  const text = KIND_TEXT[sheet.kind];
  const [selectedId, setSelectedId] = useState<string | undefined>(sheet.latest?.id);
  const [comment, setComment] = useState('');
  // A new version (from here, the CLI or Codex) becomes the one on show.
  const latestId = sheet.latest?.id;
  const seen = useRef(latestId);
  useEffect(() => {
    if (seen.current !== latestId) {
      seen.current = latestId;
      setSelectedId(latestId);
    }
  }, [latestId]);
  const v = sheet.versions.find((x) => x.id === selectedId) ?? sheet.latest ?? undefined;
  const base = `/api/projects/${encodeURIComponent(projectRef)}/designs`;
  const generate = useAction(
    (body: { fromDesignId?: string; extra?: string }) =>
      api.post(base, { castId, kind: sheet.kind, ...body }),
    { success: `已排入生成：${personaName}・${text.title}`, invalidate: [qk.designs(projectRef)] },
  );
  const review = useAction(
    (r: { verdict: 'approve' | 'changes' | 'regenerate'; comment?: string }) =>
      api.post('/api/reviews', { targetId: v?.id, ...r }),
    {
      success: (_d, r) =>
        r.verdict === 'changes'
          ? '意見已交給 Codex'
          : r.verdict === 'regenerate'
            ? '已排入重新生成'
            : '已通過',
      invalidate: [qk.designs(projectRef), ['project']],
      onSuccess: (_d, r) => {
        if (r.verdict === 'changes') setComment('');
      },
    },
  );
  const gallery = sheet.versions
    .filter((x) => x.path && isFinished(x))
    .map((x) => ({
      src: fileUrl(x.path, x.createdAt) ?? '',
      alt: `${personaName}・${text.title} v${x.version}`,
    }));
  const working = tasks.filter(
    (t) =>
      (t.payload as { targetId?: string }).targetId === v?.id &&
      t.status !== 'done' &&
      t.status !== 'cancelled',
  );
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background/40 p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-sm">{text.title}</span>
        {sheet.approved ? (
          <Tag tone="success">
            <CheckIcon />
            已通過 v{sheet.approved.version}
          </Tag>
        ) : null}
        <span className="ml-auto flex flex-wrap gap-1">
          {sheet.versions.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => setSelectedId(x.id)}
              aria-pressed={x.id === v?.id}
              className={cn(
                'rounded border px-1.5 font-mono text-[11px]',
                x.id === v?.id
                  ? 'border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground',
                x.status === 'approved' && 'border-emerald-500/60',
              )}
            >
              v{x.version}
            </button>
          ))}
        </span>
      </div>
      <span className="text-[11px] text-muted-foreground">{text.hint}</span>
      {v?.path && isFinished(v) ? (
        <Thumb
          src={fileUrl(v.path, v.createdAt)}
          alt={`${personaName}・${text.title} v${v.version}`}
          fit="contain"
          className="aspect-video w-full rounded-md"
          zoom
          gallery={gallery}
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-md bg-muted text-muted-foreground text-xs">
          {!v ? '還沒有設計' : v.status === 'failed' ? '生成失敗' : '生成中…'}
        </div>
      )}
      {v ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <VersionBadge status={v.status} />
          <span>
            <ActorLink actor={v.createdBy} /> · {v.model} · {formatUsd(v.costUsd)} · {formatAgo(v.createdAt)}
          </span>
        </div>
      ) : null}
      {v?.error ? <div className="text-red-300 text-xs">失敗原因：{v.error}</div> : null}
      {v?.reviews.map((r) => (
        <div key={r.id} className="flex items-start gap-1.5 text-xs">
          <Tag tone={VERDICT_TONE[r.verdict]}>{VERDICT_LABEL[r.verdict]}</Tag>
          <span className="flex-1 whitespace-pre-wrap">{r.comment}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            <ActorLink actor={r.createdBy} /> · {formatAgo(r.createdAt)}
          </span>
        </div>
      ))}
      {working.map((t) => (
        <div key={t.id} className="text-[11px] text-sky-200">
          Codex {t.status === 'needs_user' ? `需要你回覆：${t.question ?? ''}` : '正在依意見修改…'}
        </div>
      ))}
      {!v ? (
        <Button size="sm" disabled={generate.isPending} onClick={() => generate.mutate({})}>
          <SparklesIcon />
          生成{text.title}
        </Button>
      ) : isFinished(v) ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1.5">
            {v.status !== 'approved' && v.status !== 'rejected' ? (
              <Button
                size="sm"
                disabled={review.isPending}
                onClick={() => review.mutate({ verdict: 'approve' })}
              >
                <CheckIcon />
                通過
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={review.isPending}
              title="同樣的輸入再畫一次"
              onClick={() => review.mutate({ verdict: 'regenerate' })}
            >
              <RefreshCwIcon />
              重新生成
            </Button>
            <DiscussInCodex
              projectRef={projectRef}
              targetType="design"
              targetId={v.id}
              what={`${personaName} 的${text.title} v${v.version}`}
              label="Codex 討論"
              variant="ghost"
            />
          </div>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="要改什麼？例如：肩膀遮住、裙子長一點、髮色再淺一點…"
            className="min-h-14 text-xs"
            aria-label={`${personaName}・${text.title}的修改意見`}
          />
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={!comment.trim() || generate.isPending}
              title="不經過 Codex，把這段話直接加進提示詞重畫"
              onClick={() => {
                generate.mutate({ fromDesignId: v.id, extra: comment.trim() });
                setComment('');
              }}
            >
              <WandIcon />
              照這段話重畫
            </Button>
            <Button
              size="sm"
              disabled={!comment.trim() || review.isPending}
              title="交給 Codex：它會看圖、改提示詞、重畫並檢查"
              onClick={() => review.mutate({ verdict: 'changes', comment: comment.trim() })}
            >
              <SendIcon />
              要求修改（Codex）
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** How this project adapts the character; every sheet of it uses the note. */
function NoteEditor({
  projectRef,
  personaId,
  note,
}: {
  projectRef: string;
  personaId: string;
  note: string;
}) {
  const [text, setText] = useState(note);
  useEffect(() => setText(note), [note]);
  const save = useAction(
    () =>
      api.post(`/api/projects/${encodeURIComponent(projectRef)}/designs/note`, {
        personaId,
        note: text.trim(),
      }),
    { success: '已儲存改編說明', invalidate: [qk.designs(projectRef)] },
  );
  return (
    <div className="flex items-end gap-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="這個項目的改編說明（每張設計都會用）：例如「肩膀遮住、版型寬鬆，避免過於貼身」"
        className="min-h-12 flex-1 text-xs"
        aria-label="改編說明"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={text.trim() === note.trim() || save.isPending}
        onClick={() => save.mutate(undefined)}
      >
        <SaveIcon />
        儲存
      </Button>
    </div>
  );
}

const NONE = '__none__';

/** Binding: which library character replaces this original character (changing it here = the cast step). */
function BindingSelect({
  castId,
  personaId,
  label,
}: {
  castId: string;
  personaId: string | null;
  label: string;
}) {
  const personas = usePersonas(false, 'character');
  const map = useAction(
    (id: string | null) => api.post(`/api/cast/${encodeURIComponent(castId)}/map`, { personaId: id }),
    { success: (_r, id) => (id ? '已綁定' : '已取消綁定'), invalidate: [['project'], ['shot']] },
  );
  return (
    <Select value={personaId ?? NONE} onValueChange={(v) => map.mutate(v === NONE ? null : v)}>
      <SelectTrigger size="sm" className="w-44" aria-label={`「${label}」換成哪個物料庫角色`}>
        <SelectValue placeholder="綁定物料庫角色…" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>不換（保留原角色）</SelectItem>
        {(personas.data ?? []).map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ItemChips({
  title,
  items,
  analysis,
  pick,
  kind,
  onToggle,
  pending,
}: {
  title: string;
  items: AnalysisItem[];
  analysis: NonNullable<CastAnalysis['data']>;
  pick: 'head' | 'body';
  kind: string;
  onToggle: (index: number) => void;
  pending: boolean;
}) {
  if (!items.length) return <span className="text-muted-foreground text-xs">{title}：分析沒有找到。</span>;
  const used = items.filter((i) => i.use).length;
  const src = (it: AnalysisItem) => {
    const a = analysis.appearances[it.appearance];
    return fileUrl(pick === 'head' ? (a?.head ?? a?.body) : (a?.body ?? a?.head));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">
        {title}（用 {used} / {items.length}，取消勾選的不畫進{kind}）
      </span>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
        {items.map((it, i) => {
          const a = analysis.appearances[it.appearance];
          return (
            <div
              key={`${it.label}-${it.appearance}`}
              className={cn(
                'flex flex-col gap-1 rounded-md border p-1.5 text-xs',
                it.use ? 'border-primary/60 bg-primary/5' : 'opacity-60',
              )}
              title={it.description}
            >
              <Thumb
                src={src(it)}
                alt={`${it.label}（分鏡 #${a?.shotNo ?? '?'}）`}
                fit="contain"
                className="aspect-square w-full rounded"
                zoom
              />
              <span className="flex items-start gap-1">
                <Checkbox
                  id={`${kind}-${i}`}
                  checked={it.use}
                  disabled={pending}
                  onCheckedChange={() => onToggle(i)}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={`${kind}-${i}`}
                  className="flex min-w-0 cursor-pointer flex-col items-start gap-0 font-normal"
                >
                  <span className="font-medium text-xs">{it.label}</span>
                  <span className="text-[10px] text-muted-foreground">分鏡 #{a?.shotNo ?? '?'}</span>
                </Label>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Step ①: what the original looks like and does in this opening; the sheets are drawn from it. */
function AnalysisPanel({ projectRef, entry }: { projectRef: string; entry: BindingDesigns }) {
  const { cast, analysis } = entry;
  const analyze = useAction(
    (generate: boolean) =>
      api.post(`/api/projects/${encodeURIComponent(projectRef)}/designs/analyze`, {
        castId: cast.id,
        generate,
      }),
    {
      success: (_r, generate) => (generate ? '已排入分析，完成後會接著重新設計三張' : '已排入原片分析'),
      invalidate: [qk.designs(projectRef)],
    },
  );
  const picks = useAction(
    (p: { expressions?: number[]; poses?: number[] }) =>
      api.post(`/api/cast/${encodeURIComponent(cast.id)}/analysis/picks`, p),
    { invalidate: [qk.designs(projectRef)] },
  );
  const toggle = (list: 'expressions' | 'poses', index: number) => {
    const items = analysis?.data?.[list] ?? [];
    const next = items.flatMap((it, i) => ((i === index ? !it.use : it.use) ? [i] : []));
    picks.mutate({ [list]: next });
  };
  const running = analysis?.status === 'queued' || analysis?.status === 'analyzing';
  const buttons = (
    <span className="flex flex-wrap gap-1.5">
      <Button
        size="sm"
        variant={analysis?.data ? 'outline' : 'default'}
        disabled={running || analyze.isPending}
        onClick={() => analyze.mutate(false)}
        title="約 USD 0.01"
      >
        <ScanSearchIcon />
        {analysis?.data ? '重新分析' : '分析原片'}
      </Button>
      {!analysis?.data ? (
        <Button
          size="sm"
          variant="outline"
          disabled={running || analyze.isPending}
          onClick={() => analyze.mutate(true)}
        >
          <SparklesIcon />
          分析後直接重新設計
        </Button>
      ) : null}
    </span>
  );
  if (!analysis?.data)
    return (
      <div className="flex flex-col gap-2 text-xs">
        <span className="text-muted-foreground">
          {running
            ? '分析中…'
            : analysis?.status === 'failed'
              ? `分析失敗：${analysis.error ?? ''}`
              : `還沒分析。會看「${cast.label}」在每個分鏡最清楚的頭部和全身裁切，整理這部動畫怎麼畫她、她的身形和服裝，以及她在 OP 裡的表情和動作。`}
        </span>
        {buttons}
      </div>
    );
  const d = analysis.data;
  return (
    <div className="flex flex-col gap-3 text-xs">
      {analysis.stale ? (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
          「{cast.label}」的出場在角色步驟改過了，建議重新分析。
        </div>
      ) : null}
      <div className="grid gap-1.5 md:grid-cols-3">
        <div>
          <span className="text-muted-foreground">畫風：</span>
          {d.style || '—'}
        </div>
        <div>
          <span className="text-muted-foreground">身形：</span>
          {d.body || '—'}
        </div>
        <div>
          <span className="text-muted-foreground">服裝：</span>
          {d.outfit || '—'}
        </div>
      </div>
      <ItemChips
        title="原片表情"
        items={d.expressions}
        analysis={d}
        pick="head"
        kind="表情表"
        onToggle={(i) => toggle('expressions', i)}
        pending={picks.isPending}
      />
      <ItemChips
        title="原片動作"
        items={d.poses}
        analysis={d}
        pick="body"
        kind="動作表"
        onToggle={(i) => toggle('poses', i)}
        pending={picks.isPending}
      />
      <span className="flex items-center gap-2 text-muted-foreground">
        {analysis.model} · {formatUsd(analysis.costUsd)} · {formatAgo(analysis.updatedAt)}
        {buttons}
      </span>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 font-medium text-sm">
        <span className="flex size-5 items-center justify-center rounded-full border border-sky-400 font-mono text-[11px] text-sky-300">
          {n}
        </span>
        {title}
      </h3>
      <div className="pl-7">{children}</div>
    </section>
  );
}

function BindingCard({
  projectRef,
  entry,
  tasks,
}: {
  projectRef: string;
  entry: BindingDesigns;
  tasks: AgentTask[];
}) {
  const { persona, cast } = entry;
  const ref = persona.images.find((i) => i.isPrimary) ?? persona.images[0];
  const approved = entry.sheets.filter((s) => s.approved).length;
  const generateAll = useAction(
    () => api.post(`/api/projects/${encodeURIComponent(projectRef)}/designs`, { castId: cast.id }),
    { success: `已排入「${cast.label}」→ ${persona.name} 的三張設計`, invalidate: [qk.designs(projectRef)] },
  );
  return (
    <Card>
      <CardHeader className="flex-wrap gap-3">
        <span className="flex items-center gap-2">
          <Thumb
            src={fileUrl(cast.thumbPath)}
            alt={`原片角色「${cast.label}」`}
            fit="contain"
            className="size-14 rounded-md"
            zoom
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">原片角色</span>
            <span className="font-medium">「{cast.label}」</span>
            <span className="text-[11px] text-muted-foreground">
              {cast.shotCount} 個分鏡 · 服裝
              {cast.lookPolicy === 'follow_source' ? '跟原片走' : '用物料庫角色的'}
            </span>
          </span>
        </span>
        <ArrowRightIcon className="size-4 text-muted-foreground" />
        <span className="flex items-center gap-2">
          <Thumb
            src={fileUrl(ref?.path)}
            alt={`${persona.name}（物料庫）`}
            fit="contain"
            className="size-14 rounded-md"
            zoom
            gallery={persona.images.map((i) => ({
              src: fileUrl(i.path) ?? '',
              alt: `${persona.name} · ${i.label || i.view}`,
            }))}
          />
          <span className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">換成物料庫角色</span>
            <BindingSelect castId={cast.id} personaId={persona.id} label={cast.label} />
          </span>
        </span>
        <span className="ml-auto flex flex-col items-end gap-1.5">
          <span className="flex gap-1.5">
            <Button asChild size="sm" variant="ghost">
              <Link to="/library/$personaId" params={{ personaId: persona.id }}>
                物料庫
              </Link>
            </Button>
            <DiscussInCodex
              projectRef={projectRef}
              targetType="cast"
              targetId={cast.id}
              what={`「${cast.label}」→ ${persona.name} 的角色設計`}
            />
            <Button size="sm" disabled={generateAll.isPending} onClick={() => generateAll.mutate(undefined)}>
              <SparklesIcon />
              重新設計三張
            </Button>
          </span>
          <span className="text-[11px] text-muted-foreground">
            通過 {approved} / 3
            {entry.sheets[0]?.approved
              ? '・分鏡圖與分鏡視頻改用這套設計'
              : '・三視圖通過前，生成仍用物料庫原圖'}
          </span>
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Step n={1} title="原片分析：她在這支 OP 裡怎麼被畫、有哪些表情和動作">
          <AnalysisPanel projectRef={projectRef} entry={entry} />
        </Step>
        <Step n={2} title="改編說明（這個項目對物料庫角色的調整，每張設計都會用）">
          <NoteEditor projectRef={projectRef} personaId={persona.id} note={entry.note} />
        </Step>
        <Step n={3} title="重新設計：用原片的畫風、身形、表情和動作重畫物料庫角色">
          <div className="grid gap-3 lg:grid-cols-3">
            {entry.sheets.map((sheet) => (
              <SheetPanel
                key={sheet.kind}
                projectRef={projectRef}
                castId={cast.id}
                personaName={persona.name}
                sheet={sheet}
                tasks={tasks}
              />
            ))}
          </div>
        </Step>
      </CardContent>
    </Card>
  );
}

function UnboundCard({ list }: { list: UnboundCast[] }) {
  if (!list.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>還沒綁定的原片角色</CardTitle>
        <span className="ml-auto text-muted-foreground text-xs">
          綁定後就會出現在上面，可以分析和重新設計
        </span>
      </CardHeader>
      <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {list.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-md border bg-background/40 p-2">
            <Thumb src={fileUrl(c.thumbPath)} alt={c.label} fit="contain" className="size-12 rounded" zoom />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">「{c.label}」</span>
              <span className="text-[11px] text-muted-foreground">{c.shotCount} 個分鏡</span>
            </span>
            <BindingSelect castId={c.id} personaId={null} label={c.label} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Step 5: bind original characters to library characters, analyse the originals, then redesign. */
export function DesignPage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const designs = useDesigns(ref);
  const tasks = useProjectTasks(ref);
  const analyzeAll = useAction(
    () => api.post(`/api/projects/${encodeURIComponent(ref)}/designs/analyze`, { generate: true }),
    { success: '已排入全部分析，完成後會接著重新設計', invalidate: [qk.designs(ref)] },
  );
  if (designs.isPending) return <Loading />;
  if (designs.isError) return <ErrorState error={designs.error} />;
  const { bindings, unbound } = designs.data;
  return (
    <div className="flex flex-col">
      <PageHeader
        title="角色設計"
        description="把原片角色綁定到物料庫角色，先分析原片怎麼畫她、她有哪些表情和動作，再用這部動畫的畫風、她的身形和這些表情動作，把物料庫角色重新設計成三視圖、表情、動作。三視圖通過後，分鏡圖和分鏡視頻改用這套設計。"
        actions={
          bindings.length ? (
            <Button
              size="sm"
              variant="outline"
              disabled={analyzeAll.isPending}
              onClick={() => analyzeAll.mutate(undefined)}
            >
              <ScanSearchIcon />
              全部分析並重新設計
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-4 p-5">
        {bindings.map((entry) => (
          <BindingCard key={entry.cast.id} projectRef={ref} entry={entry} tasks={tasks.data ?? []} />
        ))}
        {!bindings.length ? (
          <EmptyState>
            <PaletteIcon className="size-5" />
            還沒有綁定。在下面把原片角色綁定到物料庫角色，或到
            <Link to="/projects/$ref/cast" params={{ ref }} className="text-primary hover:underline">
              角色
            </Link>
            步驟處理。
          </EmptyState>
        ) : null}
        <UnboundCard list={unbound} />
      </div>
    </div>
  );
}
