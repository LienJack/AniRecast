import { useParams } from '@tanstack/react-router';
import { DownloadIcon, FilmIcon, PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CompareSlider, type CompareSliderHandle } from '@/components/CompareSlider';
import { EmptyState, ErrorState, Kbd, Loading, PageHeader, Tag } from '@/components/common';
import { Generating } from '@/components/generating';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, fileUrl } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { RENDER_STATUS_LABEL, RENDER_STATUS_TONE, TIER_LABEL } from '@/lib/labels';
import { qk, useAction, useJobs, useOverview, useRenders } from '@/lib/queries';
import type { Job, Render } from '@/lib/types';
import { cn } from '@/lib/utils';
import { isTypingTarget } from '@/lib/video';

export function RendersPage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const overview = useOverview(ref);
  const renders = useRenders(ref);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sliderRef = useRef<CompareSliderHandle>(null);

  const create = useAction(
    (draft: boolean) =>
      api.post<{ render: Render; job: Job }>(`/api/projects/${encodeURIComponent(ref)}/renders`, {
        draft,
        tier: overview.data?.project.generationTier,
      }),
    {
      success: (_r, draft) => (draft ? '已排入草稿合成' : '已排入正式合成'),
      invalidate: [qk.renders(ref), qk.jobs],
      onSuccess: (r) => setSelectedId(r.render.id),
    },
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === ' ') sliderRef.current?.togglePlay();
      else if (e.key === 'ArrowLeft' || e.key === ',') sliderRef.current?.step(-1);
      else if (e.key === 'ArrowRight' || e.key === '.') sliderRef.current?.step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const jobs = useJobs();
  if (renders.isPending || overview.isPending) return <Loading />;
  if (renders.isError) return <ErrorState error={renders.error} />;
  if (overview.isError) return <ErrorState error={overview.error} />;

  const list = [...renders.data].sort((a, b) => b.version - a.version);
  const selected = list.find((r) => r.id === selectedId) ?? list.find((r) => r.status === 'ready') ?? list[0];
  const renderJob = jobs.data?.find(
    (j) =>
      (j.status === 'queued' || j.status === 'running') &&
      (j.payload as { renderId?: string } | null)?.renderId === selected?.id,
  );
  const clip = overview.data.clip;
  const fps = clip ? { num: clip.fpsNum, den: clip.fpsDen } : { num: 24, den: 1 };
  const shotIndex = new Map(overview.data.shots.map((s) => [s.id, s.orderIndex + 1]));
  const effectiveTier = overview.data.project.generationTier;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="成片"
        description={
          <span>
            草稿合成隨時可做（未通過的分鏡用最新版本或原片）；正式合成要求所有換角與去字分鏡都已通過。播放器：
            <Kbd>空白</Kbd> 播放 <Kbd>←</Kbd>
            <Kbd>→</Kbd> 逐幀，拖動畫面上的分隔線比對原片與成片。
          </span>
        }
        actions={
          <>
            <span className="text-muted-foreground text-xs">輸出 {TIER_LABEL[effectiveTier]}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={!clip || create.isPending}
              onClick={() => create.mutate(true)}
            >
              <PlusIcon />
              草稿合成
            </Button>
            <Button size="sm" disabled={!clip || create.isPending} onClick={() => create.mutate(false)}>
              <FilmIcon />
              正式合成
            </Button>
          </>
        }
      />
      {!list.length ? (
        <div className="p-5">
          <EmptyState>還沒有成片。按右上角「草稿合成」先看一次整體效果。</EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-3">
            {selected ? (
              <Card>
                <CardHeader>
                  <CardTitle>
                    r{String(selected.version).padStart(3, '0')} ·{' '}
                    {selected.kind === 'draft' ? '草稿' : '正式'} · {TIER_LABEL[selected.tier]}
                  </CardTitle>
                  <Tag tone={RENDER_STATUS_TONE[selected.status] ?? 'neutral'}>
                    {RENDER_STATUS_LABEL[selected.status] ?? selected.status}
                  </Tag>
                  <div className="ml-auto flex gap-2">
                    {selected.path && selected.status === 'ready' ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={fileUrl(selected.path)} download>
                          <DownloadIcon />
                          下載成片
                        </a>
                      </Button>
                    ) : null}
                    {selected.comparePath && selected.status === 'ready' ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={fileUrl(selected.comparePath)} download>
                          <DownloadIcon />
                          下載左右對比影片
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent>
                  {selected.tier !== effectiveTier ? (
                    <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200 text-xs">
                      這一版是以 {TIER_LABEL[selected.tier]} 合成的，專案現在輸出 {TIER_LABEL[effectiveTier]}
                      ，重新合成才會是這個解析度。
                    </div>
                  ) : null}
                  {selected.status === 'ready' && selected.compareProxyPath ? (
                    <CompareSlider
                      key={selected.id}
                      ref={sliderRef}
                      src={fileUrl(selected.compareProxyPath) ?? ''}
                      fps={fps}
                      frameCount={clip?.frameCount}
                      leftLabel="原片"
                      rightLabel="成片"
                      loop={false}
                      audio
                    />
                  ) : selected.status === 'failed' ? (
                    <ErrorState error={new Error(selected.error ?? '合成失敗')} className="m-0" />
                  ) : (
                    <Generating
                      queued={selected.status === 'queued'}
                      label={selected.status === 'queued' ? '排隊中' : '合成中'}
                      since={selected.createdAt}
                      progress={renderJob?.progress}
                      message={renderJob?.message}
                      backdrop={fileUrl(overview.data?.shots[0]?.thumb)}
                      className="aspect-video w-full"
                    />
                  )}
                </CardContent>
              </Card>
            ) : null}
            {selected ? (
              <Card>
                <CardHeader>
                  <CardTitle>這一版用到的分鏡</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-1.5">
                  {selected.shots.map((s) => (
                    <Tag key={s.shotId} tone={s.source === 'take' ? 'success' : 'muted'}>
                      #{shotIndex.get(s.shotId) ?? '?'} {s.source === 'take' ? '分鏡視頻' : '原片'}
                    </Tag>
                  ))}
                  {!selected.shots.length ? <span className="text-muted-foreground text-xs">—</span> : null}
                </CardContent>
              </Card>
            ) : null}
          </div>
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>版本</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5">
              {list.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-2.5 py-2 text-left hover:bg-accent',
                    r.id === selected?.id ? 'border-primary bg-primary/5' : 'bg-background/40',
                  )}
                >
                  <span className="font-mono text-xs">r{String(r.version).padStart(3, '0')}</span>
                  <Tag tone={r.kind === 'final' ? 'accent' : 'neutral'}>
                    {r.kind === 'draft' ? '草稿' : '正式'}
                  </Tag>
                  <Tag tone="muted">{TIER_LABEL[r.tier]}</Tag>
                  <Tag tone={RENDER_STATUS_TONE[r.status] ?? 'neutral'}>
                    {RENDER_STATUS_LABEL[r.status] ?? r.status}
                  </Tag>
                  <span className="ml-auto text-[11px] text-muted-foreground">{formatTime(r.createdAt)}</span>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
