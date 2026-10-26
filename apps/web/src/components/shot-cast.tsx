import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, CheckCheckIcon, CheckIcon, ScanSearchIcon } from 'lucide-react';
import { useState } from 'react';
import { Tag, Thumb } from '@/components/common';
import { formatClock, ShimmerText, useActiveJob, useElapsed } from '@/components/generating';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, fileUrl } from '@/lib/api';
import { qk, useAction, useCast, usePersonas } from '@/lib/queries';
import type { Job, Persona, ShotCastEntry, ShotDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

const NOT_CHARACTER = '__not_character__';
const PROJECT_DEFAULT = '__default__';
const KEEP = '__keep__';

type Verdict = NonNullable<NonNullable<ShotDetail['castCheck']>['result']>['people'][number];

const findStep = (job: Job) =>
  job.status === 'queued'
    ? '排隊中'
    : job.message?.startsWith('detecting')
      ? '偵測畫面中的人物…'
      : job.message?.startsWith('assigning')
        ? '套用辨識結果…'
        : '和角色表逐一比對…';

const primaryImage = (p: Persona | null | undefined) =>
  p ? fileUrl((p.images.find((i) => i.isPrimary) ?? p.images[0])?.path) : undefined;

/**
 * 替換角色 of one shot: everyone detected in it, who they are in the original (assigning one locks it as the
 * user's decision) and whom this shot puts in their place — the character's mapping from the cast step, another
 * library character for this shot only, or the original kept. Several characters can be replaced at once.
 * 「找出這一鏡的角色」 lets the vision model do the first pass; its picks wait for 確認 (which locks them).
 */
export function ShotCastEditor({
  shotId,
  projectRef,
  entries,
  check,
  className,
}: {
  shotId: string;
  projectRef: string;
  entries: ShotCastEntry[];
  /** The latest 找出這一鏡的角色 run (shot detail's castCheck). */
  check?: ShotDetail['castCheck'];
  className?: string;
}) {
  const castList = (useCast(projectRef).data ?? []).filter((c) => c.status === 'active');
  const personas = usePersonas(false, 'character').data ?? [];
  const personaOf = (id: string | null | undefined) => personas.find((p) => p.id === id);
  const invalidate = [['shot'], ['project'], qk.cast(projectRef)];
  const assign = useAction(
    (v: { trackletId: string; castId: string }) =>
      v.castId === NOT_CHARACTER
        ? api.post(`/api/tracklets/${encodeURIComponent(v.trackletId)}/not-character`)
        : api.post(`/api/tracklets/${encodeURIComponent(v.trackletId)}/assign`, { castId: v.castId }),
    { success: '已更新畫面中的人物', invalidate },
  );
  const override = useAction(
    (v: { castId: string; choice: string }) =>
      api.post(
        `/api/shots/${encodeURIComponent(shotId)}/cast-override`,
        v.choice === PROJECT_DEFAULT
          ? { castId: v.castId, clear: true }
          : v.choice === KEEP
            ? { castId: v.castId, keep: true }
            : { castId: v.castId, personaId: v.choice },
      ),
    { success: '已更新這一鏡的替換', invalidate },
  );
  const finding = useActiveJob('shotId', shotId, 'shot.cast');
  const findingFor = useElapsed(finding ? (finding.startedAt ?? finding.createdAt) : null);
  const find = useAction(() => api.post(`/api/shots/${encodeURIComponent(shotId)}/cast/find`), {
    success: '已排入：找出這一鏡的角色（偵測人物 → 和角色表比對）',
    invalidate: [qk.jobs],
  });
  const verdictOf = (trackletId: string): Verdict | undefined =>
    check?.result?.people.find((p) => p.trackletId === trackletId);
  // AI picks (or undecided ones the model has an opinion on) that the human has not confirmed yet.
  const unconfirmed = entries.filter(
    (e) => e.tracklet.assignedBy !== 'user' && (e.cast || verdictOf(e.tracklet.id)?.kind === 'none'),
  );
  const confirmAll = useAction(
    async (list: ShotCastEntry[]) => {
      for (const e of list)
        await (e.cast
          ? api.post(`/api/tracklets/${encodeURIComponent(e.tracklet.id)}/assign`, { castId: e.cast.id })
          : api.post(`/api/tracklets/${encodeURIComponent(e.tracklet.id)}/not-character`));
    },
    { success: '已確認', invalidate },
  );
  // Who ends up replaced, once per original character.
  const swaps = [
    ...new Map(entries.filter((e) => e.cast && e.personaId).map((e) => [e.cast!.id, e] as const)).values(),
  ];
  const busy = assign.isPending || override.isPending || confirmAll.isPending;
  const disagrees = (e: ShotCastEntry) => {
    const v = verdictOf(e.tracklet.id);
    if (!v?.locked) return false;
    return (v.kind === 'none' ? null : v.castId) !== (e.cast?.id ?? null);
  };
  // One group per original character (most detections first), then the people who are nobody yet.
  const groups = [
    ...entries
      .reduce((map, e) => {
        const key = e.cast?.id ?? NOT_CHARACTER;
        const g = map.get(key) ?? {
          key,
          cast: e.cast,
          label: e.cast?.label ?? '不是角色／未指定',
          entries: [] as ShotCastEntry[],
        };
        g.entries.push(e);
        return map.set(key, g);
      }, new Map<
        string,
        { key: string; cast: ShotCastEntry['cast']; label: string; entries: ShotCastEntry[] }
      >())
      .values(),
  ].sort((a, b) => Number(!a.cast) - Number(!b.cast) || b.entries.length - a.entries.length);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const missed = check?.result?.missed ?? [];

  return (
    <div className={cn('flex flex-col gap-2 text-xs', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-sm">替換角色</span>
        <span className="text-muted-foreground">
          {swaps.length
            ? swaps.map((e) => `${e.cast!.label} → ${personaOf(e.personaId)?.name ?? '…'}`).join('、')
            : '還沒有要替換的角色'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={swaps.length ? 'outline' : 'default'}
          disabled={Boolean(finding) || find.isPending}
          title="偵測畫面中的人物（還沒偵測過時），再用視覺模型和角色表逐一比對，結果等你確認（約 USD 0.01）"
          onClick={() => find.mutate(undefined)}
        >
          <ScanSearchIcon />
          {finding ? <ShimmerText>{findStep(finding)}</ShimmerText> : '找出這一鏡的角色'}
        </Button>
        {finding && findingFor !== null ? (
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {formatClock(findingFor)}
          </span>
        ) : null}
        {unconfirmed.length && !finding ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="把 AI 的判斷都當成你的決定（之後 Codex 不會再改）"
            onClick={() => confirmAll.mutate(unconfirmed)}
          >
            <CheckCheckIcon />
            全部確認（{unconfirmed.length}）
          </Button>
        ) : null}
        {check?.status === 'failed' ? (
          <span className="text-red-300">上次辨識失敗：{check.error ?? ''}</span>
        ) : null}
      </div>
      {finding && !entries.length ? (
        <div role="status" className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="flex gap-2 rounded-md border p-2">
              <div className="skeleton size-14 shrink-0" />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="skeleton h-6 w-full" />
                <div className="skeleton h-6 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {missed.length ? (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
          AI 還看到：{missed.map((m) => `${m.label}（${m.reason}）`).join('、')}
          。偵測沒有框到，暫時無法替換；可以到「角色」步驟重新偵測。
        </span>
      ) : null}
      {!entries.length && !finding ? (
        <span className="text-muted-foreground">
          這一鏡還沒有偵測到人物。按「找出這一鏡的角色」，或把處理方式改成沿用原片。
        </span>
      ) : !swaps.length ? (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
          按「找出這一鏡的角色」讓 AI
          先認人，或自己指定畫面中的人物是誰，再選要換成的物料庫角色；可以同時換好幾個。
        </span>
      ) : null}
      {groups.map((g) => {
        const castId = g.cast?.id;
        const first = g.entries[0]!;
        const mapped = personaOf(g.cast?.personaId);
        const choice = !first.override
          ? PROJECT_DEFAULT
          : first.override.keep
            ? KEEP
            : (first.override.personaId ?? PROJECT_DEFAULT);
        const now = personaOf(first.personaId);
        const pending = g.entries.filter((e) => unconfirmed.includes(e));
        const doubts = g.entries.filter((e) => disagrees(e)).length;
        const open = expanded[g.key] ?? (g.entries.length <= 2 || doubts > 0);
        return (
          <div key={g.key} className="flex flex-col gap-1.5 rounded-md border bg-background/40 p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{g.cast ? `「${g.label}」` : g.label}</span>
              <span className="text-muted-foreground">{g.entries.length} 個偵測</span>
              {pending.length ? (
                <Tag tone="info">AI 判斷・待確認 {pending.length}</Tag>
              ) : g.entries.every((e) => e.tracklet.assignedBy === 'user') ? (
                <Tag tone="success">
                  <CheckIcon />
                  你已確認
                </Tag>
              ) : null}
              {doubts ? <Tag tone="warning">AI 有 {doubts} 個看法不同</Tag> : null}
              {pending.length ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-[11px]"
                  disabled={busy}
                  title="這一組都當成你的決定（之後 Codex 不會再改）"
                  onClick={() => confirmAll.mutate(pending)}
                >
                  <CheckIcon />
                  確認
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex shrink-0 -space-x-4">
                {g.entries.slice(0, 4).map((e, i) => (
                  <Thumb
                    key={e.tracklet.id}
                    src={fileUrl(e.tracklet.bodyCropPath ?? e.tracklet.headCropPath)}
                    alt={`${g.label} ${i + 1}`}
                    fit="contain"
                    className="size-12 rounded bg-background ring-2 ring-background"
                    zoom
                    gallery={g.entries.map((x, k) => ({
                      src: fileUrl(x.tracklet.bodyCropPath ?? x.tracklet.headCropPath) ?? '',
                      alt: `${g.label} ${k + 1}`,
                    }))}
                  />
                ))}
              </div>
              {castId ? (
                <>
                  <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  {now ? (
                    <Thumb
                      src={primaryImage(now)}
                      alt={now.name}
                      fit="contain"
                      className="size-12 shrink-0 rounded"
                      zoom
                    />
                  ) : null}
                  <span className="min-w-0 text-[11px]">
                    {now ? <span className="text-violet-200">{now.name}</span> : '保留原角色'}
                    {first.override ? <span className="text-sky-300">（只有這一鏡）</span> : null}
                    {!mapped && !first.override ? (
                      <span className="block text-amber-200">還沒綁定物料庫角色</span>
                    ) : null}
                  </span>
                </>
              ) : null}
            </div>
            {castId ? (
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 text-muted-foreground">換成</span>
                <Select
                  value={choice}
                  disabled={busy}
                  onValueChange={(v) => override.mutate({ castId, choice: v })}
                >
                  <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={`${g.label} 換成誰`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PROJECT_DEFAULT}>
                      照角色設定（{mapped ? `換成 ${mapped.name}` : '不換'}）
                    </SelectItem>
                    <SelectItem value={KEEP}>這一鏡保留原角色</SelectItem>
                    {personas.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        換成 {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Link
                  to="/projects/$ref/cast/$castId"
                  params={{ ref: projectRef, castId }}
                  className="shrink-0 text-[11px] text-primary hover:underline"
                >
                  角色頁
                </Link>
              </div>
            ) : null}
            <button
              type="button"
              className="self-start text-[11px] text-muted-foreground hover:text-foreground"
              aria-expanded={open}
              onClick={() => setExpanded((x) => ({ ...x, [g.key]: !open }))}
            >
              {open ? '▾' : '▸'} 逐一檢查 {g.entries.length} 個偵測
            </button>
            {open
              ? g.entries.map((e, i) => {
                  const t = e.tracklet;
                  const v = verdictOf(t.id);
                  const confirmable = unconfirmed.includes(e);
                  return (
                    <div key={t.id} className="flex items-start gap-2 border-t pt-1.5">
                      <Thumb
                        src={fileUrl(t.bodyCropPath ?? t.headCropPath)}
                        alt={`${g.label} ${i + 1}`}
                        fit="contain"
                        className="size-11 shrink-0 rounded"
                        zoom
                        gallery={[t.bodyCropPath, t.headCropPath]
                          .filter((p): p is string => Boolean(p))
                          .map((p) => ({ src: fileUrl(p) ?? '', alt: `${g.label} ${i + 1}` }))}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <Select
                          value={e.cast?.id ?? NOT_CHARACTER}
                          disabled={busy}
                          onValueChange={(c) => assign.mutate({ trackletId: t.id, castId: c })}
                        >
                          <SelectTrigger size="sm" className="min-w-0" aria-label={`這個偵測在原片是誰`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {castList.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.label}
                              </SelectItem>
                            ))}
                            <SelectItem value={NOT_CHARACTER}>不是角色／未指定</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          {v ? (
                            <span
                              className={cn(
                                'min-w-0',
                                disagrees(e) ? 'text-amber-200' : 'text-muted-foreground',
                              )}
                            >
                              AI：
                              {v.kind === 'none'
                                ? '不是角色'
                                : v.kind === 'new'
                                  ? `新角色「${v.label ?? '?'}」`
                                  : v.label}
                              {` · ${Math.round(v.confidence * 100)}%`}
                              {v.reason ? `・${v.reason}` : ''}
                              {disagrees(e)
                                ? `（你指定的是${e.cast ? `「${e.cast.label}」` : '不是角色'}）`
                                : ''}
                              {!v.applied && !v.locked && v.confidence < 0.5
                                ? '（不確定，沒有自動指定）'
                                : ''}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {t.assignedBy === 'user'
                                ? '你指定的'
                                : t.assignedBy === 'codex'
                                  ? 'AI 指定的'
                                  : '自動分群的'}
                            </span>
                          )}
                          {confirmable ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="ml-auto h-6 px-2 text-[11px]"
                              disabled={busy}
                              title="當成你的決定（之後 Codex 不會再改）"
                              onClick={() => confirmAll.mutate([e])}
                            >
                              <CheckIcon />
                              確認
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
    </div>
  );
}
