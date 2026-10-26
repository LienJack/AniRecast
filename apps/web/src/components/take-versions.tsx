import { useEffect } from 'react';
import { VersionBadge } from '@/components/domain';
import { useModels } from '@/lib/queries';
import type { Take } from '@/lib/types';
import { cn } from '@/lib/utils';
import { isTypingTarget } from '@/lib/video';

/** Versions worth switching between; a failed or cancelled one only while it is on show. */
const SHOWN: readonly string[] = ['queued', 'generating', 'ready', 'approved', 'rejected', 'stale'];

/**
 * The shot's video versions above the player, each with the model that made it: click one, or press [ and ], to
 * switch — e.g. to compare a Seedance and a Wan take of the same shot.
 */
export function TakeVersions({
  takes,
  current,
  onSelect,
}: {
  takes: Take[];
  current: Take | undefined;
  onSelect: (id: string) => void;
}) {
  const catalogue = useModels().data;
  const label = (id: string) =>
    id === 'still' ? '定格' : (catalogue?.video.find((m) => m.id === id)?.label ?? id.replace(/^fal:/, ''));
  const list = takes.filter((t) => SHOWN.includes(t.status) || t.id === current?.id);
  const at = list.findIndex((t) => t.id === current?.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const step = e.key === '[' ? -1 : e.key === ']' ? 1 : 0;
      const to = list[at + step];
      if (!step || !to) return;
      e.preventDefault();
      onSelect(to.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list, at, onSelect]);

  if (list.length < 2) return null;
  return (
    <div role="tablist" aria-label="分鏡視頻版本（[ ] 切換）" className="mb-2 flex flex-wrap gap-1.5">
      {list.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === current?.id}
          title={`v${t.version} · ${label(t.model)}（[ ] 切換）`}
          onClick={() => onSelect(t.id)}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
            t.id === current?.id
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          <span className="font-medium">v{t.version}</span>
          <span>{label(t.model)}</span>
          <VersionBadge status={t.status} />
        </button>
      ))}
    </div>
  );
}
