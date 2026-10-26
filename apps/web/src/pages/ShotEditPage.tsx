import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClapperboardIcon,
  CombineIcon,
  FrameIcon,
  ScissorsIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { DiscussInCodex } from '@/components/codex';
import { ConfirmDialog, ErrorState, Kbd, Loading, PageHeader, Tag } from '@/components/common';
import { ModeBadge, StageBadge } from '@/components/domain';
import { FramePlayer, type FramePlayerHandle } from '@/components/FramePlayer';
import { ShotCastEditor } from '@/components/shot-cast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, fileUrl } from '@/lib/api';
import { formatTimecode } from '@/lib/format';
import { MODE_LABEL, OMNI_MAX_SECONDS, SHOT_MODES } from '@/lib/labels';
import { qk, useAction, useOverview, useShot } from '@/lib/queries';
import type { OverviewShot, Shot, ShotMode } from '@/lib/types';
import { isTypingTarget } from '@/lib/video';
import { OverlayPanel } from './ShotsPage';

/** One shot of the list: play it, cut it, merge it with a neighbour, choose how it is handled, clean up versions. */
export function ShotEditPage() {
  const { ref, shotId } = useParams({ from: '/projects/$ref/shots/$shotId' });
  const navigate = useNavigate();
  const overview = useOverview(ref);
  const detail = useShot(shotId);
  const player = useRef<FramePlayerHandle>(null);
  const [frame, setFrame] = useState<number | null>(null);
  const [merge, setMerge] = useState<'prev' | 'next' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const switchId = useId();

  const shots = overview.data?.shots ?? [];
  const index = shots.findIndex((s) => s.id === shotId);
  const shot = shots[index];
  const prev = index > 0 ? shots[index - 1] : undefined;
  const next = index >= 0 ? shots[index + 1] : undefined;
  const go = (s: Pick<Shot, 'id'> | undefined) =>
    s && void navigate({ to: '/projects/$ref/shots/$shotId', params: { ref, shotId: s.id } });

  const invalidate = [qk.overview(ref), ['shot'], ['project']];
  const deleteVersions = async (list: OverviewShot[]) => {
    for (const s of list) if (s.versions > 0) await api.post(`/api/shots/${s.id}/discard-versions`);
  };
  const split = useAction(
    async (at: number) => {
      if (shot) await deleteVersions([shot]);
      return api.post<[Shot, Shot]>(`/api/shots/${shotId}/split`, { at });
    },
    { success: '已切開，正在重建兩個分鏡的關鍵幀', invalidate },
  );
  const setRep = useAction((repFrame: number) => api.patch(`/api/shots/${shotId}`, { repFrame }), {
    success: '已更新代表幀',
    invalidate,
  });
  const setMode = useAction((mode: ShotMode) => api.patch(`/api/shots/${shotId}`, { mode }), {
    success: (_r, mode) => `改為${MODE_LABEL[mode]}`,
    invalidate,
  });
  const setOther = useAction(
    (removeOtherOverlays: boolean) => api.patch(`/api/shots/${shotId}`, { removeOtherOverlays }),
    { success: '已更新', invalidate },
  );
  const mergeAction = useAction(
    async (side: 'prev' | 'next') => {
      const pair = side === 'prev' ? [prev, shot] : [shot, next];
      if (!pair[0] || !pair[1]) throw new Error('沒有相鄰的分鏡');
      await deleteVersions(pair as OverviewShot[]);
      return api.post<Shot>('/api/shots/merge', { first: pair[0].id, second: pair[1].id });
    },
    {
      success: '已合併',
      invalidate,
      onSuccess: (merged) => {
        setMerge(null);
        if (merged.id !== shotId) go(merged);
      },
    },
  );
  const discard = useAction(
    () =>
      api.post<{ boards: number; takes: number; trash: string | null }>(
        `/api/shots/${shotId}/discard-versions`,
      ),
    {
      success: (r) =>
        `已刪除分鏡圖 ${r.boards} 張、分鏡視頻 ${r.takes} 個（檔案移到 ${r.trash ?? 'trash/'}）`,
      invalidate,
      onSuccess: () => setConfirmDiscard(false),
    },
  );

  // ←/→ frame by frame (Shift: 10), space play, [ / ] previous / next shot.
  const keys = useRef({ prev, next, go });
  keys.current = { prev, next, go };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const p = player.current;
      if (!p) return;
      if (e.key === 'ArrowLeft') p.step(e.shiftKey ? -10 : -1);
      else if (e.key === 'ArrowRight') p.step(e.shiftKey ? 10 : 1);
      else if (e.key === ' ') p.togglePlay();
      else if (e.key === '[') keys.current.go(keys.current.prev);
      else if (e.key === ']') keys.current.go(keys.current.next);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (overview.isPending || detail.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  if (detail.isError) return <ErrorState error={detail.error} />;
  const clip = overview.data.clip;
  if (!shot || !clip)
    return (
      <div className="p-5">
        <ErrorState error={new Error('找不到這個分鏡（可能已被合併或拆開）')} />
        <Button asChild variant="outline" size="sm" className="mt-3">
          <Link to="/projects/$ref/shots" params={{ ref }}>
            <ArrowLeftIcon />
            分鏡列表
          </Link>
        </Button>
      </div>
    );
  const d = detail.data;
  const fps = { num: clip.fpsNum, den: clip.fpsDen };
  const current = frame ?? shot.repFrame;
  const canSplit = current > shot.startFrame && current <= shot.endFrame;
  const long = (shot.seconds ?? 0) > OMNI_MAX_SECONDS;
  const cast = [...new Map(d.cast.filter((e) => e.cast).map((e) => [e.cast!.id, e])).values()];
  const mergeWith = merge === 'prev' ? prev : merge === 'next' ? next : undefined;
  const mergeVersions = mergeWith ? mergeWith.versions + shot.versions : 0;

  return (
    <div className="flex flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            分鏡 #{shot.orderIndex + 1}
            <ModeBadge mode={shot.mode} />
            <StageBadge stage={shot.stage} />
            {long ? <Tag tone="warning">超過 {OMNI_MAX_SECONDS} 秒</Tag> : null}
          </span>
        }
        description={`f ${shot.startFrame}–${shot.endFrame}（${shot.frameCount} 幀，${shot.seconds?.toFixed(2)} 秒）· ${formatTimecode(shot.startFrame, fps)}`}
        actions={
          <>
            <Button asChild size="sm" variant="ghost">
              <Link to="/projects/$ref/shots" params={{ ref }}>
                <ArrowLeftIcon />
                分鏡列表
              </Link>
            </Button>
            <Button size="sm" variant="outline" disabled={!prev} onClick={() => go(prev)}>
              <ChevronLeftIcon />
              上一鏡
            </Button>
            <Button size="sm" variant="outline" disabled={!next} onClick={() => go(next)}>
              下一鏡
              <ChevronRightIcon />
            </Button>
            <Button asChild size="sm">
              <Link to="/projects/$ref/review/$shotId" params={{ ref, shotId }}>
                <ClapperboardIcon />
                評審
              </Link>
            </Button>
          </>
        }
      />
      <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardContent className="flex flex-col gap-3">
            {clip.proxyPath ? (
              <FramePlayer
                key={shot.id}
                ref={player}
                src={fileUrl(clip.proxyPath) ?? ''}
                fps={fps}
                totalFrames={clip.frameCount}
                range={[shot.startFrame, shot.endFrame]}
                initialFrame={shot.repFrame}
                marks={{ in: shot.repFrame, out: shot.repFrame + 1 }}
                onFrame={setFrame}
              />
            ) : (
              <ErrorState error={new Error('節選的代理檔還沒產生')} className="m-0" />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={shot.versions > 0 ? 'destructive' : 'default'}
                disabled={!canSplit || split.isPending}
                title={canSplit ? '這一幀成為後半段的第一幀' : '停到分鏡中間的某一幀（不能是第一幀）才能切開'}
                onClick={() => split.mutate(current)}
              >
                <ScissorsIcon />
                {shot.versions > 0 ? `刪除 ${shot.versions} 個舊版本並在這一幀切開` : '在這一幀切開'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={current === shot.repFrame || setRep.isPending}
                title="代表幀用來生成分鏡圖"
                onClick={() => setRep.mutate(current)}
              >
                <FrameIcon />
                設為代表幀
              </Button>
              <span className="ml-auto font-mono text-muted-foreground text-xs">
                目前 f {current}（{formatTimecode(current, fps)}）· 代表幀 f {shot.repFrame}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <Kbd>←</Kbd>
              <Kbd>→</Kbd> 逐幀（<Kbd>Shift</Kbd> 一次 10 幀）<Kbd>空白</Kbd> 播放 <Kbd>[</Kbd>
              <Kbd>]</Kbd> 上／下一鏡
            </div>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>處理方式</CardTitle>
              {shot.modeSource === 'user' ? <Tag tone="muted">手動</Tag> : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Select value={shot.mode} onValueChange={(v) => setMode.mutate(v as ShotMode)}>
                <SelectTrigger size="sm" aria-label="處理方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHOT_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {MODE_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Switch
                  id={switchId}
                  checked={shot.removeOtherOverlays}
                  onCheckedChange={(v) => setOther.mutate(v)}
                />
                <Label htmlFor={switchId} className="text-xs">
                  連片名與其他疊字一起去掉
                </Label>
              </div>
              <div className="text-xs">
                <span className="text-muted-foreground">光影：</span>
                {shot.lighting ?? '還沒分析（總覽的「畫風與光影」可以分析，生成時會照這段打光）'}
              </div>
              {shot.mode === 'replace' ? (
                <ShotCastEditor
                  shotId={shot.id}
                  projectRef={ref}
                  entries={d.cast}
                  className="border-t pt-2"
                />
              ) : cast.length ? (
                <div className="flex flex-wrap gap-1 text-xs">
                  <span className="text-muted-foreground">出場：</span>
                  {cast.map((e) => (
                    <Tag key={e.cast!.id} tone={e.personaId ? 'accent' : 'muted'}>
                      {e.cast!.label}
                      {e.persona ? ` → ${e.persona.name}` : ''}
                    </Tag>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground text-xs">沒有偵測到角色。</span>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>剪輯</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-xs">
              <span className="text-muted-foreground">
                拆開：在左邊停到後半段的第一幀，按「在這一幀切開」。合併：和相鄰的分鏡合成一個連續時刻。
              </span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={!prev} onClick={() => setMerge('prev')}>
                  <CombineIcon />
                  與上一鏡合併
                </Button>
                <Button size="sm" variant="outline" disabled={!next} onClick={() => setMerge('next')}>
                  <CombineIcon />
                  與下一鏡合併
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>生成版本</CardTitle>
              <span className="ml-auto text-muted-foreground text-xs">{shot.versions} 個</span>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to="/projects/$ref/review/$shotId" params={{ ref, shotId }}>
                  <ClapperboardIcon />
                  到評審台
                </Link>
              </Button>
              <DiscussInCodex
                projectRef={ref}
                targetType="shot"
                targetId={shot.id}
                what={`分鏡 #${shot.orderIndex + 1}`}
              />
              {shot.versions > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-300 hover:text-red-200"
                  title="刪除這個分鏡的所有分鏡圖和分鏡視頻，之後就能自由拆分、合併"
                  onClick={() => setConfirmDiscard(true)}
                >
                  <Trash2Icon />
                  刪除舊版本（{shot.versions}）
                </Button>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>字幕</CardTitle>
              <span className="ml-auto text-muted-foreground text-xs">{shot.overlays} 個</span>
            </CardHeader>
            <CardContent>
              <OverlayPanel shotId={shot.id} />
            </CardContent>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={Boolean(mergeWith)}
        onOpenChange={(o) => !o && setMerge(null)}
        title={
          mergeWith
            ? `合併分鏡 #${Math.min(mergeWith.orderIndex, shot.orderIndex) + 1} 和 #${Math.max(mergeWith.orderIndex, shot.orderIndex) + 1}？`
            : ''
        }
        description={
          mergeVersions > 0
            ? `兩個分鏡會合成一個，關鍵幀會重新產生。它們共有 ${mergeVersions} 個生成版本，合併前會先刪除（檔案移到 trash/versions/，可找回），之後要重新生成。`
            : '兩個分鏡會合成一個，關鍵幀會重新產生。'
        }
        confirmLabel={mergeVersions > 0 ? `刪除 ${mergeVersions} 個舊版本並合併` : '合併'}
        destructive={mergeVersions > 0}
        pending={mergeAction.isPending}
        onConfirm={() => merge && mergeAction.mutate(merge)}
      />
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={`刪除分鏡 #${shot.orderIndex + 1} 的 ${shot.versions} 個生成版本？`}
        description="這個分鏡的所有分鏡圖和分鏡視頻（包括已通過的）都會刪除，評審紀錄一起刪掉，相關的 Codex 任務會取消。檔案和紀錄會移到 Workspace 的 trash/versions/ 資料夾，需要時可以找回。刪除後這個分鏡就能自由拆分、合併，之後要重新生成。"
        confirmLabel="刪除舊版本"
        destructive
        pending={discard.isPending}
        onConfirm={() => discard.mutate(undefined)}
      />
    </div>
  );
}
