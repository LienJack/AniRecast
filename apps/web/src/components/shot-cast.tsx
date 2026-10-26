import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { Thumb } from '@/components/common';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, fileUrl } from '@/lib/api';
import { qk, useAction, useCast, usePersonas } from '@/lib/queries';
import type { Persona, ShotCastEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

const NOT_CHARACTER = '__not_character__';
const PROJECT_DEFAULT = '__default__';
const KEEP = '__keep__';

const primaryImage = (p: Persona | null | undefined) =>
  p ? fileUrl((p.images.find((i) => i.isPrimary) ?? p.images[0])?.path) : undefined;

/**
 * 替換角色 of one shot: everyone detected in it, who they are in the original (assigning one locks it as the
 * user's decision) and whom this shot puts in their place — the character's mapping from the cast step, another
 * library character for this shot only, or the original kept. Several characters can be replaced at once.
 */
export function ShotCastEditor({
  shotId,
  projectRef,
  entries,
  className,
}: {
  shotId: string;
  projectRef: string;
  entries: ShotCastEntry[];
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
  // Who ends up replaced, once per original character.
  const swaps = [
    ...new Map(entries.filter((e) => e.cast && e.personaId).map((e) => [e.cast!.id, e] as const)).values(),
  ];
  const busy = assign.isPending || override.isPending;

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
      {!entries.length ? (
        <span className="text-muted-foreground">
          這一鏡沒有偵測到人物。到「角色」步驟重新辨識，或把處理方式改成沿用原片。
        </span>
      ) : !swaps.length ? (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
          指定畫面中的人物是誰，再選要換成的物料庫角色；可以同時換好幾個。
        </span>
      ) : null}
      {entries.map((e, i) => {
        const t = e.tracklet;
        const crop = t.bodyCropPath ?? t.headCropPath;
        const castId = e.cast?.id;
        const mapped = personaOf(e.cast?.personaId);
        const choice = !e.override
          ? PROJECT_DEFAULT
          : e.override.keep
            ? KEEP
            : (e.override.personaId ?? PROJECT_DEFAULT);
        const now = personaOf(e.personaId);
        return (
          <div key={t.id} className="flex items-start gap-2 rounded-md border bg-background/40 p-2">
            <Thumb
              src={fileUrl(crop)}
              alt={`人物 ${i + 1}`}
              fit="contain"
              className="size-14 shrink-0 rounded"
              zoom
              gallery={[t.bodyCropPath, t.headCropPath]
                .filter((p): p is string => Boolean(p))
                .map((p) => ({ src: fileUrl(p) ?? '', alt: `人物 ${i + 1}` }))}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="w-12 shrink-0 text-muted-foreground">原片是</span>
                <Select
                  value={castId ?? NOT_CHARACTER}
                  disabled={busy}
                  onValueChange={(v) => assign.mutate({ trackletId: t.id, castId: v })}
                >
                  <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={`人物 ${i + 1} 在原片是誰`}>
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
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-12 shrink-0 text-muted-foreground">換成</span>
                <Select
                  value={castId ? choice : PROJECT_DEFAULT}
                  disabled={!castId || busy}
                  onValueChange={(v) => castId && override.mutate({ castId, choice: v })}
                >
                  <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={`人物 ${i + 1} 換成誰`}>
                    <SelectValue placeholder="先指定原片是誰" />
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
              </div>
              {castId ? (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {e.cast!.label}
                  <ArrowRightIcon className="size-3" />
                  {now ? <span className="text-violet-200">{now.name}</span> : <span>保留原角色</span>}
                  {e.override ? <span className="text-sky-300">（只有這一鏡）</span> : null}
                  <Link
                    to="/projects/$ref/cast/$castId"
                    params={{ ref: projectRef, castId }}
                    className="ml-auto text-primary hover:underline"
                  >
                    角色頁
                  </Link>
                </span>
              ) : null}
            </div>
            {now ? (
              <Thumb
                src={primaryImage(now)}
                alt={now.name}
                fit="contain"
                className="size-14 shrink-0 rounded"
                zoom
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
