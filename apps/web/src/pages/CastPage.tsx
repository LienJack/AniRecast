import { Link, useParams } from '@tanstack/react-router';
import {
  BanIcon,
  CheckIcon,
  CombineIcon,
  PencilIcon,
  ScanFaceIcon,
  SplitIcon,
  UserRoundIcon,
  UsersRoundIcon,
  XIcon,
} from 'lucide-react';
import { type DragEvent, useState } from 'react';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Thumb,
} from '@/components/common';
import { AssignedByBadge, TaskCard } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, fileUrl } from '@/lib/api';
import { LOOK_POLICY_LABEL } from '@/lib/labels';
import { qk, useAction, useCast, useOverview, usePersonas } from '@/lib/queries';
import type { CastMember, Look, LookPolicy, OverviewShot, Persona, Tracklet } from '@/lib/types';
import { cn } from '@/lib/utils';

const NONE = '__none__';
const DRAG_TYPE = 'application/x-anirecast-tracklet';

/**
 * Crop of an appearance. Detection crops come from the identity analysis (built in parallel); until the
 * API exposes them, fall back to the shot's middle keyframe.
 */
function trackletImage(t: Tracklet, shot: OverviewShot | undefined): string | undefined {
  const rec = t as unknown as Record<string, unknown>;
  for (const key of ['headCropPath', 'headCrop', 'bodyCropPath', 'bodyCrop', 'cropPath', 'thumbPath']) {
    const v = rec[key];
    if (typeof v === 'string' && v) return fileUrl(v);
  }
  return fileUrl(shot?.thumb);
}

function Appearance({
  t,
  shot,
  projectRef,
  selected,
  onToggle,
}: {
  t: Tracklet;
  shot: OverviewShot | undefined;
  projectRef: string;
  selected: boolean;
  onToggle: () => void;
}) {
  const label = `分鏡 ${shot ? shot.orderIndex + 1 : '?'} 的出場`;
  return (
    <div
      className={cn(
        'flex w-32 flex-col overflow-hidden rounded-md border bg-background/40',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, t.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={onToggle}
        aria-pressed={selected}
        aria-label={`${label}（點一下選取，拖到另一個角色即可改歸屬）`}
        title="點一下選取；拖到另一個角色即可改歸屬"
        className="relative cursor-grab active:cursor-grabbing"
      >
        <Thumb src={trackletImage(t, shot)} alt={label} className="aspect-square w-full" />
        <span
          className={cn(
            'absolute top-1 left-1 flex size-4 items-center justify-center rounded-[4px] border border-white/60 bg-black/60',
            selected && 'border-primary bg-primary text-primary-foreground',
          )}
        >
          {selected ? <CheckIcon className="size-3" /> : null}
        </span>
      </button>
      <div className="flex flex-col gap-1 p-1.5">
        <div className="flex items-center justify-between gap-1">
          {shot ? (
            <Link
              to="/projects/$ref/review/$shotId"
              params={{ ref: projectRef, shotId: t.shotId }}
              className="font-mono text-[11px] text-primary hover:underline"
            >
              分鏡 #{shot.orderIndex + 1}
            </Link>
          ) : (
            <span className="text-[11px] text-muted-foreground">分鏡 ?</span>
          )}
          {t.confidence !== null ? (
            <span className="font-mono text-[10px] text-muted-foreground" title="歸屬信心">
              {Math.round(t.confidence * 100)}%
            </span>
          ) : null}
        </div>
        <AssignedByBadge by={t.assignedBy} />
      </div>
    </div>
  );
}

function LookPolicySelect({ look }: { look: Look }) {
  const set = useAction((policy: LookPolicy) => api.post(`/api/looks/${look.id}/policy`, { policy }), {
    success: '已更新造型設定',
  });
  return (
    <Select value={look.lookPolicy} onValueChange={(v) => set.mutate(v as LookPolicy)}>
      <SelectTrigger size="sm" aria-label={`造型「${look.label}」的處理方式`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(['persona', 'follow_source'] as const).map((p) => (
          <SelectItem key={p} value={p}>
            {LOOK_POLICY_LABEL[p]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CastCard({
  cast,
  others,
  personas,
  shots,
  projectRef,
}: {
  cast: CastMember;
  others: CastMember[];
  personas: Persona[];
  shots: Map<string, OverviewShot>;
  projectRef: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(cast.label);
  const [splitLabel, setSplitLabel] = useState('');
  const [splitOpen, setSplitOpen] = useState(false);
  const [mergeInto, setMergeInto] = useState<CastMember | null>(null);
  const [dropping, setDropping] = useState(false);

  const map = useAction((personaId: string | null) => api.post(`/api/cast/${cast.id}/map`, { personaId }), {
    success: (_r, id) => (id ? '已對應人設，受影響分鏡的處理方式已更新' : '已設為不替換'),
  });
  const rename = useAction((l: string) => api.post(`/api/cast/${cast.id}/rename`, { label: l }), {
    success: '已重新命名',
    onSuccess: () => setEditing(false),
  });
  const merge = useAction(
    (target: CastMember) => api.post(`/api/cast/${target.id}/merge`, { drop: cast.id }),
    {
      success: (_r, target) => `已併入「${target.label}」`,
      onSuccess: () => setMergeInto(null),
    },
  );
  const split = useAction(
    (v: { ids: string[]; label: string }) =>
      api.post(`/api/cast/${cast.id}/split`, { trackletIds: v.ids, label: v.label }),
    {
      success: (_r, v) => `已拆成新角色「${v.label}」`,
      onSuccess: () => {
        setSelected(new Set());
        setSplitOpen(false);
        setSplitLabel('');
      },
    },
  );
  const assign = useAction(
    async (v: { ids: string[]; castId: string }) => {
      for (const id of v.ids) await api.post(`/api/tracklets/${id}/assign`, { castId: v.castId });
    },
    { success: '已改歸屬（你的修正會鎖定）', onSuccess: () => setSelected(new Set()) },
  );
  const dismiss = useAction(
    async (ids: string[]) => {
      for (const id of ids) await api.post(`/api/tracklets/${id}/not-character`);
    },
    { success: '已標記為不是角色', onSuccess: () => setSelected(new Set()) },
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const ids = [...selected];
  const persona = personas.find((p) => p.id === cast.personaId);
  const thumb =
    fileUrl(cast.thumbPath) ??
    (cast.tracklets[0] ? trackletImage(cast.tracklets[0], shots.get(cast.tracklets[0].shotId)) : undefined);
  const groups: Array<{ look: Look | null; tracklets: Tracklet[] }> = [
    ...cast.looks.map((look) => ({ look, tracklets: cast.tracklets.filter((t) => t.lookId === look.id) })),
    {
      look: null,
      tracklets: cast.tracklets.filter((t) => !t.lookId || !cast.looks.some((l) => l.id === t.lookId)),
    },
  ].filter((g) => g.look || g.tracklets.length);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (id && !cast.tracklets.some((t) => t.id === id)) assign.mutate({ ids: [id], castId: cast.id });
  };

  return (
    <Card
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      className={cn(dropping && 'border-primary bg-primary/5')}
    >
      <CardHeader className="flex-wrap gap-3">
        <Thumb src={thumb} alt={cast.label} className="size-12 rounded-md" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {editing ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (label.trim()) rename.mutate(label.trim());
              }}
            >
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="h-7 w-48"
                aria-label="角色名稱"
              />
              <Button type="submit" size="icon-sm" variant="ghost" aria-label="儲存名稱">
                <CheckIcon />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="取消" onClick={() => setEditing(false)}>
                <XIcon />
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold">{cast.label}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="重新命名"
                onClick={() => {
                  setLabel(cast.label);
                  setEditing(true);
                }}
              >
                <PencilIcon />
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
            <span>
              {cast.shotIds.length} 個分鏡 · {cast.tracklets.length} 次出場 · {cast.looks.length} 個造型
            </span>
            {cast.description ? <span className="truncate">· {cast.description}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Field label="換成人設">
            <div className="flex items-center gap-1.5">
              {persona ? (
                <Thumb
                  src={fileUrl(persona.images.find((i) => i.isPrimary)?.path ?? persona.images[0]?.path)}
                  alt={persona.name}
                  className="size-7 rounded"
                />
              ) : null}
              <Select value={cast.personaId ?? NONE} onValueChange={(v) => map.mutate(v === NONE ? null : v)}>
                <SelectTrigger size="sm" className="w-40" aria-label="對應人設">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不替換</SelectItem>
                  {personas.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Field>
          <Field label="合併進另一個角色">
            <Select
              value=""
              onValueChange={(id) => setMergeInto(others.find((o) => o.id === id) ?? null)}
              disabled={!others.length}
            >
              <SelectTrigger size="sm" className="w-36" aria-label="合併進另一個角色">
                <SelectValue placeholder="選擇角色…" />
              </SelectTrigger>
              <SelectContent>
                {others.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {ids.length ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-2 text-xs">
            <span>已選 {ids.length} 個出場片段：</span>
            {splitOpen ? (
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (splitLabel.trim()) split.mutate({ ids, label: splitLabel.trim() });
                }}
              >
                <Input
                  value={splitLabel}
                  onChange={(e) => setSplitLabel(e.target.value)}
                  placeholder="新角色名稱"
                  aria-label="新角色名稱"
                  className="h-7 w-36"
                />
                <Button type="submit" size="sm" disabled={!splitLabel.trim() || split.isPending}>
                  建立
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSplitOpen(false)}>
                  取消
                </Button>
              </form>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setSplitOpen(true)}>
                <SplitIcon />
                拆成新角色
              </Button>
            )}
            <Select
              value=""
              onValueChange={(castId) => assign.mutate({ ids, castId })}
              disabled={!others.length}
            >
              <SelectTrigger size="sm" className="w-36" aria-label="改歸屬到">
                <SelectValue placeholder="改歸屬到…" />
              </SelectTrigger>
              <SelectContent>
                {others.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(ids)}
            >
              <BanIcon />
              不是角色
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              取消選取
            </Button>
          </div>
        ) : null}
        {groups.map((g) => (
          <div key={g.look?.id ?? 'none'} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-xs">{g.look ? `造型：${g.look.label}` : '未分造型'}</span>
              {g.look?.description ? (
                <span className="text-muted-foreground text-xs">{g.look.description}</span>
              ) : null}
              {g.look ? <LookPolicySelect look={g.look} /> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {g.tracklets.map((t) => (
                <Appearance
                  key={t.id}
                  t={t}
                  shot={shots.get(t.shotId)}
                  projectRef={projectRef}
                  selected={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                />
              ))}
              {!g.tracklets.length ? (
                <span className="text-muted-foreground text-xs">（沒有出場片段）</span>
              ) : null}
            </div>
          </div>
        ))}
      </CardContent>
      <ConfirmDialog
        open={Boolean(mergeInto)}
        onOpenChange={(o) => !o && setMergeInto(null)}
        title={`把「${cast.label}」併入「${mergeInto?.label ?? ''}」？`}
        description="兩個角色會變成同一人，所有出場片段歸到後者。這是你的人工決定，之後重跑分群也不會被推翻。"
        confirmLabel="合併"
        pending={merge.isPending}
        onConfirm={() => mergeInto && merge.mutate(mergeInto)}
      />
    </Card>
  );
}

export function CastPage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const cast = useCast(ref);
  const overview = useOverview(ref);
  const personas = usePersonas();
  const [identifyOpen, setIdentifyOpen] = useState(false);
  const [redetect, setRedetect] = useState(false);
  const identify = useAction(
    () => api.post(`/api/projects/${encodeURIComponent(ref)}/cast/identify`, { redetect }),
    { success: '已排入同一人識別', invalidate: [qk.jobs], onSuccess: () => setIdentifyOpen(false) },
  );
  if (cast.isPending || overview.isPending) return <Loading />;
  if (cast.isError) return <ErrorState error={cast.error} />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  const shots = new Map(overview.data.shots.map((s) => [s.id, s]));
  const castTasks = overview.data.openTasks.filter((t) => t.kind === 'cast_review');
  const mapped = cast.data.filter((c) => c.personaId).length;
  return (
    <div className="flex flex-col">
      <PageHeader
        title="角色表"
        description={
          <span>
            {cast.data.length} 個片中角色，{mapped}{' '}
            個已對應人設。把出場片段拖到另一個角色即可改歸屬；你做的修正會鎖定（
            <UserRoundIcon className="inline size-3" />
            你），之後重跑分群或 Codex 判斷都不會推翻。
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setIdentifyOpen(true)}>
              <ScanFaceIcon />
              重新識別角色
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/personas">
                <UsersRoundIcon />
                素材庫
              </Link>
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-3 p-5">
        {castTasks.length ? (
          <div className="flex flex-col gap-2">
            <span className="font-medium text-xs">Codex 同一人識別判斷</span>
            {castTasks.map((t) => (
              <TaskCard key={t.id} task={t} />
            ))}
          </div>
        ) : null}
        {!cast.data.length ? (
          <EmptyState>
            還沒有片中角色。分鏡偵測後，同一人識別完成就會出現在這裡。
            <span className="text-xs">（識別結果的裁切圖尚未提供時，以分鏡中間幀代替。）</span>
          </EmptyState>
        ) : null}
        {cast.data.map((c) => (
          <CastCard
            key={c.id}
            cast={c}
            others={cast.data.filter((o) => o.id !== c.id)}
            personas={personas.data ?? []}
            shots={shots}
            projectRef={ref}
          />
        ))}
        {cast.data.length ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <CombineIcon className="size-3.5" />
            合併：在角色卡右上角選「合併進另一個角色」；拆開：勾選出場片段後按「拆成新角色」。
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={identifyOpen}
        onOpenChange={setIdentifyOpen}
        title="重新跑同一人識別？"
        description="程式重新分群出場片段，信心不足的交給 Codex 判斷。你鎖定過的修正（合併、拆開、改歸屬、不是角色）會當成約束，不會被推翻。"
        confirmLabel="開始識別"
        pending={identify.isPending}
        onConfirm={() => identify.mutate(undefined)}
      >
        <Label className="text-xs">
          <Checkbox checked={redetect} onCheckedChange={(v) => setRedetect(v === true)} />
          重新偵測角色（較慢；預設只重新分群）
        </Label>
      </ConfirmDialog>
    </div>
  );
}
