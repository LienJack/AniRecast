import { Link, useParams } from '@tanstack/react-router';
import {
  CheckIcon,
  PaletteIcon,
  RefreshCwIcon,
  SaveIcon,
  SendIcon,
  SparklesIcon,
  WandIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DiscussInCodex } from '@/components/codex';
import { EmptyState, ErrorState, Loading, PageHeader, Tag, Thumb } from '@/components/common';
import { ActorLink, VersionBadge } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { api, fileUrl } from '@/lib/api';
import { formatAgo, formatUsd } from '@/lib/format';
import { VERDICT_LABEL, VERDICT_TONE } from '@/lib/labels';
import { qk, useAction, useDesigns, useProjectTasks } from '@/lib/queries';
import type { AgentTask, DesignKind, PersonaDesigns } from '@/lib/types';
import { cn } from '@/lib/utils';

const KIND_TEXT: Record<DesignKind, { title: string; hint: string }> = {
  turnaround: { title: '三視圖', hint: '正面、側面、背面全身，服裝與配色以這張為準' },
  expressions: { title: '表情', hint: '常用表情，臉型與五官要和三視圖一致' },
  poses: { title: '動作', hint: '常見動作與姿勢，看身形比例與動態' },
};

type Sheet = PersonaDesigns['sheets'][number];
type Version = Sheet['versions'][number];

const isFinished = (v: Version) => ['ready', 'approved', 'stale', 'rejected'].includes(v.status);

/** One sheet (turnaround, expressions or poses) of one character: its versions, reviews and actions. */
function SheetPanel({
  projectRef,
  personaId,
  personaName,
  sheet,
  tasks,
}: {
  projectRef: string;
  personaId: string;
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
      api.post(base, { personaId, kind: sheet.kind, ...body }),
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

function PersonaCard({
  projectRef,
  entry,
  tasks,
}: {
  projectRef: string;
  entry: PersonaDesigns;
  tasks: AgentTask[];
}) {
  const { persona } = entry;
  const ref = persona.images.find((i) => i.view === 'full') ?? persona.images[0];
  const approved = entry.sheets.filter((s) => s.approved).length;
  const missing = entry.sheets.filter((s) => !s.latest).length;
  const generateAll = useAction(
    () => api.post(`/api/projects/${encodeURIComponent(projectRef)}/designs`, { personaId: persona.id }),
    { success: `已排入 ${persona.name} 的三張設計`, invalidate: [qk.designs(projectRef)] },
  );
  return (
    <Card>
      <CardHeader className="flex-wrap gap-3">
        <Thumb
          src={fileUrl(ref?.path)}
          alt={`${persona.name}（物料庫原圖）`}
          fit="contain"
          className="size-14 rounded-md"
          zoom
          gallery={persona.images.map((i) => ({
            src: fileUrl(i.path) ?? '',
            alt: `${persona.name}・${i.view}`,
          }))}
        />
        <div className="flex flex-col gap-0.5">
          <CardTitle>{persona.name}</CardTitle>
          <span className="text-muted-foreground text-xs">
            三張設計通過 {approved} / 3
            {entry.sheets[0]?.approved
              ? '・分鏡圖與分鏡視頻改用這套設計'
              : '・三視圖通過前，生成仍用物料庫原圖'}
          </span>
        </div>
        <span className="ml-auto flex gap-1.5">
          <Button asChild size="sm" variant="ghost">
            <Link to="/library/$personaId" params={{ personaId: persona.id }}>
              物料庫原圖
            </Link>
          </Button>
          <DiscussInCodex
            projectRef={projectRef}
            targetType="persona"
            targetId={persona.id}
            what={`${persona.name} 的角色設計`}
          />
          {missing ? (
            <Button size="sm" disabled={generateAll.isPending} onClick={() => generateAll.mutate(undefined)}>
              <SparklesIcon />
              生成全部（{missing} 張）
            </Button>
          ) : null}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <NoteEditor projectRef={projectRef} personaId={persona.id} note={entry.note} />
        <div className="grid gap-3 lg:grid-cols-3">
          {entry.sheets.map((sheet) => (
            <SheetPanel
              key={sheet.kind}
              projectRef={projectRef}
              personaId={persona.id}
              personaName={persona.name}
              sheet={sheet}
              tasks={tasks}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Step 5: every swapped-in character redrawn in this animation's style, reviewed sheet by sheet. */
export function DesignPage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const designs = useDesigns(ref);
  const tasks = useProjectTasks(ref);
  if (designs.isPending) return <Loading />;
  if (designs.isError) return <ErrorState error={designs.error} />;
  return (
    <div className="flex flex-col">
      <PageHeader
        title="角色設計"
        description="用這部動畫的畫風，把物料庫的人設重畫一套：三視圖、表情、動作。三視圖通過後，分鏡圖與分鏡視頻改用這套設計。"
      />
      <div className="flex flex-col gap-4 p-5">
        {designs.data.length ? (
          designs.data.map((entry) => (
            <PersonaCard key={entry.persona.id} projectRef={ref} entry={entry} tasks={tasks.data ?? []} />
          ))
        ) : (
          <EmptyState>
            <PaletteIcon className="size-5" />
            還沒有角色對應到人設。先到
            <Link to="/projects/$ref/cast" params={{ ref }} className="text-primary hover:underline">
              角色
            </Link>
            步驟指定要換成誰。
          </EmptyState>
        )}
      </div>
    </div>
  );
}
