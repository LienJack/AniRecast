import { Thumb } from '@/components/common';
import { fileUrl } from '@/lib/api';

interface DirectorParams {
  notes?: string;
  analysis?: Record<string, string>;
  references?: Array<{ id: string; label: string; path: string }>;
  model?: string;
  costUsd?: number;
  fallback?: boolean;
  error?: string;
}

const ANALYSIS_LABEL: Record<string, string> = {
  scene: '場景',
  action: '動作',
  composition: '構圖',
  motion: '動作',
  camera: '鏡頭',
  timing: '節奏',
  lighting: '光影',
  style: '畫風',
};

/** What the director saw and decided for a version: its note, its reading of the frame, the references, the prompt. */
export function DirectorNote({
  params,
  prompt,
  refLabel,
  open,
}: {
  /** A version's params (its `director`), or a preview's `{ director }`. */
  params: Record<string, unknown>;
  prompt: string;
  /** How the generator names the i-th reference (Image 2…, <IMAGE_REF_0>…). */
  refLabel: (i: number) => string;
  open?: boolean;
}) {
  const d = params.director as DirectorParams | undefined;
  if (!d) return null;
  if (d.fallback)
    return (
      <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
        AI 導演這次沒成功（{d.error ?? '原因不明'}），用了範本提示詞。
      </div>
    );
  return (
    <details open={open} className="group rounded border bg-background/40 p-2 text-[11px]">
      <summary className="cursor-pointer text-muted-foreground">
        <span className="text-sky-200">AI 導演</span>：{d.notes || '已分析原畫面並撰寫提示詞'}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {d.analysis ? (
          <dl className="grid grid-cols-[3rem_1fr] gap-x-2 gap-y-1">
            {Object.entries(d.analysis).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{ANALYSIS_LABEL[k] ?? k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {d.references?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {d.references.map((r, i) => (
              <span key={r.id} className="flex w-20 flex-col gap-0.5" title={r.label}>
                <Thumb src={fileUrl(r.path)} alt={r.label} fit="contain" className="size-20 rounded" zoom />
                <span className="truncate text-muted-foreground">{refLabel(i)}</span>
              </span>
            ))}
          </div>
        ) : null}
        <pre className="whitespace-pre-wrap rounded bg-muted/50 p-2 font-sans text-[11px] leading-relaxed">
          {prompt}
        </pre>
        <span className="text-muted-foreground">
          {d.model} · USD {(d.costUsd ?? 0).toFixed(3)}
        </span>
      </div>
    </details>
  );
}
