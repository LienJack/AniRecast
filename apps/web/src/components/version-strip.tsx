import { useEffect } from 'react';
import { VersionBadge } from '@/components/domain';
import { useModels } from '@/lib/queries';
import type { VersionStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { isTypingTarget } from '@/lib/video';

/** Versions worth switching between; a failed or cancelled one only while it is on show. */
const SHOWN: readonly string[] = ['queued', 'generating', 'ready', 'approved', 'rejected', 'stale'];

interface Version {
  id: string;
  version: number;
  status: VersionStatus;
  model: string;
}

/**
 * A storyboard frame's or a video's versions above it, each with the model that made it: click one, or press [ and ]
 * (`keys`, for the one under review), to switch — e.g. to compare a Seedance and a Wan take of the same shot.
 */
export function VersionStrip({
  versions,
  current,
  onSelect,
  kind,
  keys = false,
}: {
  versions: Version[];
  current: Version | undefined;
  onSelect: (id: string) => void;
  kind: 'image' | 'video';
  keys?: boolean;
}) {
  const catalogue = useModels().data;
  const models = kind === 'image' ? catalogue?.image : catalogue?.video;
  const label = (id: string) =>
    id === 'still' ? '定格' : (models?.find((m) => m.id === id)?.label ?? id.replace(/^fal:/, ''));
  const list = versions.filter((v) => SHOWN.includes(v.status) || v.id === current?.id);
  const at = list.findIndex((v) => v.id === current?.id);

  useEffect(() => {
    if (!keys) return;
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
  }, [keys, list, at, onSelect]);

  if (list.length < 2) return null;
  return (
    <div
      role="tablist"
      aria-label={`${kind === 'image' ? '分鏡圖' : '分鏡視頻'}版本（[ ] 切換）`}
      className="mb-2 flex flex-wrap gap-1.5"
    >
      {list.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          aria-selected={v.id === current?.id}
          title={`v${v.version} · ${label(v.model)}（[ ] 切換）`}
          onClick={() => onSelect(v.id)}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
            v.id === current?.id
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          <span className="font-medium">v{v.version}</span>
          <span>{label(v.model)}</span>
          <VersionBadge status={v.status} />
        </button>
      ))}
    </div>
  );
}
