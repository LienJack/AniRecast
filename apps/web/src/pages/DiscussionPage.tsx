import { Link, useParams } from '@tanstack/react-router';
import {
  CheckIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileJsonIcon,
  MessagesSquareIcon,
  XCircleIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DiscussionBadge } from '@/components/codex';
import { ConfirmDialog, EmptyState, ErrorState, Loading, PageHeader, Tag } from '@/components/common';
import { ActorLink, codexThreadUrl } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api';
import { formatAgo, formatTime } from '@/lib/format';
import { useAction, useDiscussion } from '@/lib/queries';
import type { DiscussionView, Handoff } from '@/lib/types';
import { cn } from '@/lib/utils';

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => toast.success(`已複製${label}`),
          () => toast.error('無法複製，請手動選取'),
        )
      }
    >
      <ClipboardCopyIcon />
      複製{label}
    </Button>
  );
}

/** Where the discussed thing lives in the app. */
function TargetLink({ v, projectRef }: { v: DiscussionView; projectRef: string }) {
  const h = v.handoff;
  const cls = 'text-primary hover:underline';
  if (v.targetShotId)
    return (
      <Link
        to="/projects/$ref/review/$shotId"
        params={{ ref: projectRef, shotId: v.targetShotId }}
        className={cls}
      >
        {h.targetLabel}
      </Link>
    );
  if (h.targetType === 'design' || h.targetType === 'persona')
    return (
      <Link to="/projects/$ref/design" params={{ ref: projectRef }} className={cls}>
        {h.targetLabel}
      </Link>
    );
  if (h.targetType === 'cast' && h.targetId)
    return (
      <Link to="/projects/$ref/cast/$castId" params={{ ref: projectRef, castId: h.targetId }} className={cls}>
        {h.targetLabel}
      </Link>
    );
  return <span>{h.targetLabel}</span>;
}

function VersionLink({
  version,
  projectRef,
}: {
  version: NonNullable<Handoff['result']>['versions'][number];
  projectRef: string;
}) {
  const body = (
    <>
      {version.label}
      {version.note ? <span className="text-muted-foreground">：{version.note}</span> : null}
    </>
  );
  return version.shotId ? (
    <Link
      to="/projects/$ref/review/$shotId"
      params={{ ref: projectRef, shotId: version.shotId }}
      className="text-primary text-sm hover:underline"
    >
      {body}
    </Link>
  ) : (
    <Link
      to="/projects/$ref/design"
      params={{ ref: projectRef }}
      className="text-primary text-sm hover:underline"
    >
      {body}
    </Link>
  );
}

function ResultCard({ v, projectRef }: { v: DiscussionView; projectRef: string }) {
  const h = v.handoff;
  const result = h.result;
  const appliedOk = useMemo(() => new Set(h.applied.filter((a) => a.ok).map((a) => a.index)), [h.applied]);
  const outcome = (i: number) => h.applied.find((a) => a.index === i);
  // Everything not yet imported is ticked, except approvals: those stay the human's explicit choice.
  const defaults = () =>
    new Set(
      (result?.items ?? []).flatMap((item, i) =>
        appliedOk.has(i) || item.action.type === 'approve' ? [] : [i],
      ),
    );
  const [picked, setPicked] = useState<Set<number>>(defaults);
  const stamp = `${result?.submittedAt}|${h.applied.length}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the ticks when a new result or import arrives
  useEffect(() => setPicked(defaults()), [stamp]);
  const base = `/api/codex/${encodeURIComponent(h.id)}`;
  const reload = useAction(() => api.post<DiscussionView>(`${base}/reload`), {
    success: '已讀取 result.json',
    invalidate: [['codex'], ['project']],
  });
  const apply = useAction((indices: number[]) => api.post<DiscussionView>(`${base}/import`, { indices }), {
    success: (r, indices) => {
      const failed = r.handoff.applied.filter((a) => indices.includes(a.index) && !a.ok).length;
      return failed ? `導入完成，${failed} 項失敗` : `已導入 ${indices.length} 項`;
    },
    invalidate: [['codex'], ['project'], ['shot'], ['personas']],
  });
  const toggle = (i: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  if (!result)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Codex 的結論</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <EmptyState className="m-0">
            還沒有結論。討論出共識後，Codex 會寫好 result.json 並執行 anirecast codex
            submit，結論就會出現在這裡。
          </EmptyState>
          {v.resultFileExists ? (
            <Button
              size="sm"
              className="self-start"
              disabled={reload.isPending}
              onClick={() => reload.mutate(undefined)}
            >
              <FileJsonIcon />
              讀取資料夾裡的 result.json
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  const pickedList = [...picked].sort((a, b) => a - b);
  const paid = pickedList.filter((i) => result.items[i]?.paid).length;
  return (
    <Card>
      <CardHeader className="flex-wrap">
        <CardTitle>Codex 的結論</CardTitle>
        <span className="text-muted-foreground text-xs">
          <ActorLink actor={result.submittedBy} /> · {formatTime(result.submittedAt)}
        </span>
        {v.resultFileExists ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={reload.isPending}
            title="Codex 改了 result.json 但沒有重新送出時用"
            onClick={() => reload.mutate(undefined)}
          >
            <FileJsonIcon />
            重新讀取 result.json
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="whitespace-pre-wrap rounded-md border bg-background/40 p-3 text-sm">
          {result.summary}
        </div>
        {result.items.length ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">
              要導入的動作（依序執行；付費的會照常檢查預算、每日配額和安全擋下上限）
            </span>
            {result.items.map((item, i) => {
              const o = outcome(i);
              const done = appliedOk.has(i);
              const id = `item-${i}`;
              return (
                <div
                  key={id}
                  className={cn(
                    'flex items-start gap-2 rounded-md border p-2',
                    done ? 'border-emerald-500/30 bg-emerald-500/5' : 'bg-background/40',
                  )}
                >
                  <Checkbox
                    id={id}
                    checked={done || picked.has(i)}
                    disabled={done}
                    onCheckedChange={() => toggle(i)}
                    className="mt-0.5"
                  />
                  <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                      {item.label}
                      {item.paid ? <Tag tone="warning">付費</Tag> : null}
                      {item.action.type === 'approve' ? <Tag tone="accent">通過要你決定</Tag> : null}
                    </span>
                    {item.action.why ? (
                      <span className="text-muted-foreground text-xs">理由：{item.action.why}</span>
                    ) : null}
                    {o ? (
                      o.ok ? (
                        <span className="text-emerald-300 text-xs">
                          已導入 · {formatAgo(o.at)}
                          {o.refs.length ? ` · ${o.refs.join('、')}` : ''}
                        </span>
                      ) : (
                        <span className="text-red-300 text-xs">失敗：{o.error}</span>
                      )
                    ) : null}
                  </label>
                </div>
              );
            })}
            <div className="flex items-center justify-end gap-2 pt-1">
              {paid ? <span className="text-amber-300 text-xs">其中 {paid} 項會送出模型請求</span> : null}
              <Button
                disabled={!pickedList.length || apply.isPending || h.status === 'closed'}
                onClick={() => apply.mutate(pickedList)}
              >
                <DownloadIcon />
                導入選取的 {pickedList.length} 項
              </Button>
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">這次結論沒有要導入的動作。</span>
        )}
        {result.versions.length ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">
              討論中生成的版本（到評審頁看、決定要不要通過）
            </span>
            {result.versions.map((ver) => (
              <VersionLink key={ver.id} version={ver} projectRef={projectRef} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One Codex discussion: the question, how to reach the thread, and the conclusion to import. */
export function DiscussionPage() {
  const { ref, discussionId } = useParams({ from: '/projects/$ref/codex/$discussionId' });
  const q = useDiscussion(discussionId);
  const [confirmClose, setConfirmClose] = useState(false);
  const base = `/api/codex/${encodeURIComponent(discussionId)}`;
  const openThread = useAction(() => api.post<DiscussionView>(`${base}/open`), {
    success: (r) => (r.threadId ? '已在 Codex 開好對話' : undefined),
    invalidate: [['codex'], ['project']],
    onSuccess: (r) => {
      if (r.openError) toast.error('無法在 Codex 開對話', { description: r.openError });
    },
  });
  const close = useAction(() => api.post<DiscussionView>(`${base}/close`), {
    success: '已結束這個討論',
    invalidate: [['codex'], ['project']],
    onSuccess: () => setConfirmClose(false),
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  const v = q.data;
  const h = v.handoff;
  return (
    <div className="flex flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Codex 討論 · {h.targetLabel}
            <DiscussionBadge status={h.status} />
          </span>
        }
        description={`${h.id} · ${formatTime(h.createdAt)} 建立 · 最後更新 ${formatAgo(h.updatedAt)}`}
        actions={
          <>
            {h.threadId ? (
              <Button asChild size="sm">
                <a href={codexThreadUrl(h.threadId)} title={`thread ${h.threadId}`}>
                  <ExternalLinkIcon />在 Codex 打開對話
                </a>
              </Button>
            ) : (
              <Button size="sm" disabled={openThread.isPending} onClick={() => openThread.mutate(undefined)}>
                <MessagesSquareIcon />在 Codex App 開對話
              </Button>
            )}
            {h.status !== 'closed' ? (
              <Button size="sm" variant="ghost" onClick={() => setConfirmClose(true)}>
                <XCircleIcon />
                結束討論
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <ResultCard v={v} projectRef={ref} />
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>討論的問題</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="text-muted-foreground text-xs">
                對象：
                <TargetLink v={v} projectRef={ref} /> · 由 <ActorLink actor={h.createdBy} /> 發起
              </div>
              <div className="whitespace-pre-wrap">{h.topic}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>在別的 Codex 對話繼續</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-xs">
              <span className="text-muted-foreground">
                也可以把這段提示詞貼到任何一個 Codex 對話（App 或
                CLI）；說明、圖片清單和結論格式都在討論資料夾裡。
              </span>
              <div className="whitespace-pre-wrap rounded border bg-background/40 p-2 font-mono text-[11px]">
                {v.prompt}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <CopyButton text={v.prompt} label="提示詞" />
                <CopyButton text={v.folder} label="資料夾路徑" />
              </div>
              <span className="break-all text-muted-foreground">{v.folder}</span>
              {h.threadId ? (
                <span className="text-muted-foreground">
                  打不開時，在終端機執行 <code>codex resume {h.threadId}</code>
                </span>
              ) : null}
            </CardContent>
          </Card>
          {h.status === 'imported' ? (
            <div className="flex items-center gap-1.5 text-emerald-300 text-xs">
              <CheckIcon className="size-3.5" />
              結論已導入；Codex 再送一次結論會換成新的待導入清單。
            </div>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="結束這個討論？"
        description="結束後不能再導入結論；Codex 對話本身不受影響。"
        confirmLabel="結束討論"
        pending={close.isPending}
        onConfirm={() => close.mutate(undefined)}
      />
    </div>
  );
}
