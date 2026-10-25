import { Link, useParams } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  ClapperboardIcon,
  CombineIcon,
  FrameIcon,
  ScanSearchIcon,
  ScissorsIcon,
  TypeIcon,
  UsersRoundIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
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
import { FramePlayer } from '@/components/FramePlayer';
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
import { formatTimecode } from '@/lib/format';
import { MODE_LABEL, OMNI_MAX_SECONDS, OVERLAY_CATEGORIES, OVERLAY_LABEL, SHOT_MODES } from '@/lib/labels';
import { qk, useAction, useOverview, useShot } from '@/lib/queries';
import type { Clip, OverlayCategory, OverviewShot, ShotMode } from '@/lib/types';

type FrameDialog = { kind: 'split' | 'rep'; shot: OverviewShot } | null;

function ShotFrameDialog({
  state,
  clip,
  projectRef,
  onClose,
}: {
  state: NonNullable<FrameDialog>;
  clip: Clip;
  projectRef: string;
  onClose: () => void;
}) {
  const { kind, shot } = state;
  const fps = { num: clip.fpsNum, den: clip.fpsDen };
  const initial = kind === 'rep' ? shot.repFrame : Math.floor((shot.startFrame + shot.endFrame + 1) / 2);
  const [frame, setFrame] = useState(initial);
  const split = useAction((at: number) => api.post(`/api/shots/${shot.id}/split`, { at }), {
    success: '已拆分，正在重建兩個分鏡的關鍵幀',
    invalidate: [qk.overview(projectRef), ['shot']],
    onSuccess: onClose,
  });
  const rep = useAction((repFrame: number) => api.patch(`/api/shots/${shot.id}`, { repFrame }), {
    success: '已更新代表幀',
    onSuccess: onClose,
  });
  const splitValid = frame > shot.startFrame && frame <= shot.endFrame;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {kind === 'split' ? '拆分' : '改選代表幀'} · 分鏡 #{shot.orderIndex + 1}
          </DialogTitle>
          <DialogDescription>
            {kind === 'split'
              ? '移到新分鏡的第一幀後按「在這一幀切開」。這一幀會成為後半段的開頭。'
              : '代表幀用來生成分鏡圖。移到想要的那一幀後確認。'}
            範圍 f {shot.startFrame}–{shot.endFrame}。
          </DialogDescription>
        </DialogHeader>
        {clip.proxyPath ? (
          <FramePlayer
            src={fileUrl(clip.proxyPath) ?? ''}
            fps={fps}
            totalFrames={clip.frameCount}
            range={[shot.startFrame, shot.endFrame]}
            initialFrame={initial}
            onFrame={setFrame}
          />
        ) : (
          <ErrorState error={new Error('節選的代理檔還沒產生')} className="m-0" />
        )}
        <DialogFooter className="items-center">
          <span className="mr-auto font-mono text-muted-foreground text-xs">
            目前 f {frame}（{formatTimecode(frame, fps)}）
          </span>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          {kind === 'split' ? (
            <Button disabled={!splitValid || split.isPending} onClick={() => split.mutate(frame)}>
              <ScissorsIcon />
              在這一幀切開
            </Button>
          ) : (
            <Button disabled={rep.isPending} onClick={() => rep.mutate(frame)}>
              <FrameIcon />
              設為代表幀
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OverlayPanel({ shotId }: { shotId: string }) {
  const detail = useShot(shotId);
  const update = useAction(
    (v: { id: string; remove?: boolean; category?: OverlayCategory }) =>
      api.patch(`/api/overlays/${v.id}`, { remove: v.remove, category: v.category }),
    { success: '已更新字幕設定' },
  );
  if (detail.isPending) return <Loading className="p-2" />;
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

function ShotCard({
  shot,
  next,
  projectRef,
  onFrameDialog,
  onMerge,
}: {
  shot: OverviewShot;
  next: OverviewShot | undefined;
  projectRef: string;
  onFrameDialog: (kind: 'split' | 'rep') => void;
  onMerge: () => void;
}) {
  const [showOverlays, setShowOverlays] = useState(false);
  const switchId = useId();
  const setMode = useAction((mode: ShotMode) => api.patch(`/api/shots/${shot.id}`, { mode }), {
    success: (_r, mode) => `分鏡 #${shot.orderIndex + 1} 改為${MODE_LABEL[mode]}`,
  });
  const setOther = useAction(
    (removeOtherOverlays: boolean) => api.patch(`/api/shots/${shot.id}`, { removeOtherOverlays }),
    { success: '已更新' },
  );
  const long = (shot.seconds ?? 0) > OMNI_MAX_SECONDS;
  return (
    <Card className={shot.mode === 'exclude' ? 'opacity-60' : undefined}>
      <div className="relative">
        <Thumb
          src={fileUrl(shot.thumb)}
          alt={`分鏡 ${shot.orderIndex + 1}`}
          className="aspect-video w-full rounded-t-lg"
        />
        <span className="absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 font-mono text-xs">
          #{shot.orderIndex + 1}
        </span>
        <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 font-mono text-[11px]">
          {shot.seconds?.toFixed(2)} 秒
        </span>
        {long ? (
          <span
            className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded bg-amber-500/90 px-1.5 text-[11px] text-black"
            title="超過 Omni 的 10 秒上限，生成時會拆成多段"
          >
            <AlertTriangleIcon className="size-3" />
            &gt;10 秒
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <ModeBadge mode={shot.mode} />
          {shot.modeSource === 'user' ? <Tag tone="muted">手動</Tag> : null}
          <StageBadge stage={shot.stage} />
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
        <div className="flex items-center gap-2">
          <Select value={shot.mode} onValueChange={(v) => setMode.mutate(v as ShotMode)}>
            <SelectTrigger size="sm" className="flex-1" aria-label="處理方式">
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
          <Button asChild size="sm" variant="outline">
            <Link to="/projects/$ref/review/$shotId" params={{ ref: projectRef, shotId: shot.id }}>
              <ClapperboardIcon />
              評審
            </Link>
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={shot.removeOtherOverlays}
            onCheckedChange={(v) => setOther.mutate(v)}
          />
          <Label htmlFor={switchId} className="text-[11px]">
            連片名與其他疊字一起去掉
          </Label>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => onFrameDialog('split')}>
            <ScissorsIcon />
            拆分
          </Button>
          <Button size="sm" variant="ghost" disabled={!next} onClick={onMerge}>
            <CombineIcon />
            與下一鏡合併
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onFrameDialog('rep')}>
            <FrameIcon />
            代表幀 f {shot.repFrame}
          </Button>
          <Button
            size="sm"
            variant={showOverlays ? 'secondary' : 'ghost'}
            aria-expanded={showOverlays}
            onClick={() => setShowOverlays((v) => !v)}
          >
            <TypeIcon />
            字幕
          </Button>
        </div>
        {showOverlays ? <OverlayPanel shotId={shot.id} /> : null}
      </div>
    </Card>
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
  const [frameDialog, setFrameDialog] = useState<FrameDialog>(null);
  const [merge, setMerge] = useState<[OverviewShot, OverviewShot] | null>(null);
  const [detectOpen, setDetectOpen] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const analyze = useAction(() => api.post(`/api/projects/${encodeURIComponent(ref)}/shots/analyze`), {
    success: '已排入分鏡分析',
    invalidate: [qk.jobs],
    onSuccess: () => setAnalyzeOpen(false),
  });
  const mergeAction = useAction(
    (pair: [OverviewShot, OverviewShot]) =>
      api.post('/api/shots/merge', { first: pair[0].id, second: pair[1].id }),
    { success: '已合併', onSuccess: () => setMerge(null) },
  );
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
          {shots.map((s, i) => (
            <ShotCard
              key={s.id}
              shot={s}
              next={shots[i + 1]}
              projectRef={ref}
              onFrameDialog={(kind) => setFrameDialog({ kind, shot: s })}
              onMerge={() => {
                const n = shots[i + 1];
                if (n) setMerge([s, n]);
              }}
            />
          ))}
        </div>
      )}
      {frameDialog && clip ? (
        <ShotFrameDialog
          key={`${frameDialog.kind}-${frameDialog.shot.id}`}
          state={frameDialog}
          clip={clip}
          projectRef={ref}
          onClose={() => setFrameDialog(null)}
        />
      ) : null}
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
      <ConfirmDialog
        open={Boolean(merge)}
        onOpenChange={(o) => !o && setMerge(null)}
        title={merge ? `合併分鏡 #${merge[0].orderIndex + 1} 和 #${merge[1].orderIndex + 1}？` : ''}
        description="兩個相鄰分鏡會合成一個，關鍵幀會重新產生。已經有生成結果的分鏡不能合併。"
        confirmLabel="合併"
        pending={mergeAction.isPending}
        onConfirm={() => merge && mergeAction.mutate(merge)}
      />
    </div>
  );
}
