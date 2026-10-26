import { Link, useParams } from '@tanstack/react-router';
import { AlertTriangleIcon, ScanSearchIcon, TypeIcon, UsersRoundIcon } from 'lucide-react';
import { useState } from 'react';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Tag,
  Thumb,
} from '@/components/common';
import { FrameWithOverlays, ModeBadge, StageBadge } from '@/components/domain';
import { GeneratingOverlay } from '@/components/generating';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, fileUrl } from '@/lib/api';
import { MODE_LABEL, OMNI_MAX_SECONDS, OVERLAY_CATEGORIES, OVERLAY_LABEL, SHOT_MODES } from '@/lib/labels';
import { qk, useAction, useOverview, useShot } from '@/lib/queries';
import type { OverlayCategory, OverviewShot } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Subtitles of one shot: what each overlaid text is and whether it is removed (used on the shot edit page). */
export function OverlayPanel({ shotId }: { shotId: string }) {
  const detail = useShot(shotId);
  const update = useAction(
    (v: { id: string; remove?: boolean; category?: OverlayCategory }) =>
      api.patch(`/api/overlays/${v.id}`, { remove: v.remove, category: v.category }),
    { success: '已更新字幕設定' },
  );
  if (detail.isPending) return <Loading inline className="p-2" />;
  if (detail.isError) return <ErrorState error={detail.error} className="m-0" />;
  const { overlays, keyframes } = detail.data;
  const mid = keyframes.find((k) => k.role === 'mid') ?? keyframes[0];
  if (!overlays.length)
    return (
      <div className="text-muted-foreground text-xs">沒有偵測到疊加字幕（分鏡分析完成後才會出現）。</div>
    );
  return (
    <div className="flex flex-col gap-2">
      <FrameWithOverlays src={fileUrl(mid?.path)} alt="字幕位置" overlays={overlays} />
      {overlays.map((o) => (
        <div key={o.id} className="flex flex-col gap-1 rounded border bg-background/40 p-1.5">
          <div className="truncate text-xs" title={o.text ?? ''}>
            「{o.text ?? '（無文字）'}」
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={o.category}
              onValueChange={(v) => update.mutate({ id: o.id, category: v as OverlayCategory })}
            >
              <SelectTrigger size="sm" className="flex-1" aria-label="字幕類別">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OVERLAY_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {OVERLAY_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label className="text-[11px]">
              <Switch
                checked={o.remove}
                disabled={o.category === 'in_scene'}
                onCheckedChange={(remove) => update.mutate({ id: o.id, remove })}
              />
              去掉
            </Label>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A shot in the list: picture and facts only; opening it leads to the shot edit page with every action. */
function ShotCard({ shot, projectRef }: { shot: OverviewShot; projectRef: string }) {
  const long = (shot.seconds ?? 0) > OMNI_MAX_SECONDS;
  return (
    <Link
      to="/projects/$ref/shots/$shotId"
      params={{ ref: projectRef, shotId: shot.id }}
      className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      title="打開分鏡：播放、拆開、合併、處理方式、字幕"
    >
      <Card
        className={cn(
          'overflow-hidden transition-colors group-hover:border-foreground/40',
          shot.mode === 'exclude' && 'opacity-60',
        )}
      >
        <div className="relative">
          <Thumb
            src={fileUrl(shot.thumb)}
            alt={`分鏡 ${shot.orderIndex + 1}`}
            className="aspect-video w-full"
          />
          {shot.stage.endsWith('_generating') && shot.mode !== 'keep' && shot.mode !== 'exclude' ? (
            <GeneratingOverlay
              label={shot.stage === 'board_generating' ? '分鏡圖生成中' : '分鏡視頻生成中'}
            />
          ) : null}
          <span className="absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 font-mono text-xs">
            #{shot.orderIndex + 1}
          </span>
          <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 font-mono text-[11px]">
            {shot.seconds?.toFixed(2)} 秒
          </span>
          {long ? (
            <span
              className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded bg-amber-500/90 px-1.5 text-[11px] text-black"
              title="超過 10 秒，生成前要拆開"
            >
              <AlertTriangleIcon className="size-3" />
              &gt;10 秒
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <ModeBadge mode={shot.mode} />
            {shot.mode === 'keep' || shot.mode === 'exclude' ? null : <StageBadge stage={shot.stage} />}
            {shot.versions > 0 ? <Tag tone="muted">{shot.versions} 個版本</Tag> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
            <span className="font-mono">
              f {shot.startFrame}–{shot.endFrame}（{shot.frameCount}）
            </span>
            <span className="flex items-center gap-1" title="出場角色數">
              <UsersRoundIcon className="size-3" />
              {shot.castCount}
            </span>
            <span className="flex items-center gap-1" title="疊加字幕數">
              <TypeIcon className="size-3" />
              {shot.overlays}
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function DetectDialog({ projectRef, onClose }: { projectRef: string; onClose: () => void }) {
  const [threshold, setThreshold] = useState('');
  const [minLen, setMinLen] = useState('');
  const detect = useAction(
    () =>
      api.post(`/api/projects/${encodeURIComponent(projectRef)}/shots/detect`, {
        ...(threshold ? { threshold: Number(threshold) } : {}),
        ...(minLen ? { minSceneLen: Number(minLen) } : {}),
      }),
    { success: '已排入分鏡偵測', invalidate: [qk.jobs], onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重新偵測分鏡</DialogTitle>
          <DialogDescription>
            依目前節選重新偵測剪接點。已經有生成結果的分鏡會被擋下；手動拆分／合併會被新結果取代。
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="靈敏度門檻（留空用預設，數字越小切得越細）">
            <Input
              inputMode="decimal"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="預設"
            />
          </Field>
          <Field label="最短分鏡（幀）">
            <Input
              inputMode="numeric"
              value={minLen}
              onChange={(e) => setMinLen(e.target.value.replace(/\D/g, ''))}
              placeholder="預設"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={detect.isPending} onClick={() => detect.mutate(undefined)}>
            <ScanSearchIcon />
            開始偵測
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShotsPage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const overview = useOverview(ref);
  const [detectOpen, setDetectOpen] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const analyze = useAction(() => api.post(`/api/projects/${encodeURIComponent(ref)}/shots/analyze`), {
    success: '已排入分鏡分析',
    invalidate: [qk.jobs],
    onSuccess: () => setAnalyzeOpen(false),
  });
  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  const { shots, clip } = overview.data;
  const byMode = SHOT_MODES.map((m) => [m, shots.filter((s) => s.mode === m).length] as const);
  const longCount = shots.filter((s) => (s.seconds ?? 0) > OMNI_MAX_SECONDS).length;
  return (
    <div className="flex flex-col">
      <PageHeader
        title="分鏡"
        description={
          clip ? (
            <span className="flex flex-wrap gap-x-3">
              <span>
                {shots.length} 個分鏡 · 節選 {clip.frameCount} 幀
              </span>
              {byMode.map(([m, n]) => (n ? <span key={m}>{`${MODE_LABEL[m]} ${n}`}</span> : null))}
              {longCount ? <span className="text-amber-300">{longCount} 個超過 10 秒</span> : null}
            </span>
          ) : (
            '還沒有節選'
          )
        }
        actions={
          <>
            <Button size="sm" variant="outline" disabled={!shots.length} onClick={() => setAnalyzeOpen(true)}>
              <TypeIcon />
              分析字幕與畫面
            </Button>
            <Button size="sm" variant="outline" disabled={!clip} onClick={() => setDetectOpen(true)}>
              <ScanSearchIcon />
              重新偵測
            </Button>
          </>
        }
      />
      {!clip ? (
        <div className="p-5">
          <EmptyState>
            先確認節選才會進入分鏡模式。
            <Link to="/projects/$ref/clip" params={{ ref }} className="text-primary hover:underline">
              前往原片與節選
            </Link>
          </EmptyState>
        </div>
      ) : !shots.length ? (
        <div className="p-5">
          <EmptyState>
            {clip.status === 'ready' ? '還沒有分鏡，按「重新偵測」。' : '節選處理中，完成後會自動偵測分鏡…'}
          </EmptyState>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 p-5">
          {shots.map((s) => (
            <ShotCard key={s.id} shot={s} projectRef={ref} />
          ))}
        </div>
      )}
      {detectOpen ? <DetectDialog projectRef={ref} onClose={() => setDetectOpen(false)} /> : null}
      <ConfirmDialog
        open={analyzeOpen}
        onOpenChange={setAnalyzeOpen}
        title="重新分析所有分鏡？"
        description="用視覺模型重新辨識疊加字幕（工作人員字幕／片名與其他疊字／場景內文字）、人物外觀和分鏡描述，之後自動重算各分鏡的處理方式；你手動設過的處理方式不會被覆蓋。使用真實供應器時會產生少量費用。"
        confirmLabel="開始分析"
        pending={analyze.isPending}
        onConfirm={() => analyze.mutate(undefined)}
      />
    </div>
  );
}
