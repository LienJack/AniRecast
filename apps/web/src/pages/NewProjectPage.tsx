import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  DownloadIcon,
  FolderInputIcon,
  LinkIcon,
} from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, Field, Loading, PageHeader, Tag, Thumb } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, fileUrl } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { SOURCE_STATUS_LABEL, SOURCE_STATUS_TONE } from '@/lib/labels';
import { qk, useAction, useOverview, useSources } from '@/lib/queries';
import { STEPS } from '@/lib/steps';
import type { Project, Source } from '@/lib/types';
import { cn } from '@/lib/utils';

/** The flow at a glance, with the current step highlighted. */
function StepStrip({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-1.5">
          <span
            className={cn(
              'flex items-center gap-1 rounded-full border px-2 py-0.5',
              i === current ? 'border-sky-400 text-sky-300' : 'border-border text-muted-foreground',
            )}
          >
            <span className="font-mono">{i + 1}</span>
            {s.label}
          </span>
          {i < STEPS.length - 1 ? <span className="text-muted-foreground">→</span> : null}
        </li>
      ))}
    </ol>
  );
}

function SourceChoice({
  source,
  chosen,
  onChoose,
}: {
  source: Source;
  chosen: boolean;
  onChoose: () => void;
}) {
  const ready = source.status === 'ready';
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={onChoose}
      aria-pressed={chosen}
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border text-left transition-colors',
        chosen ? 'border-primary ring-1 ring-primary' : 'hover:border-foreground/30',
        !ready && 'opacity-50',
      )}
    >
      <div className="relative">
        <Thumb
          src={fileUrl(source.thumbPath, source.updatedAt)}
          alt={source.title}
          className="aspect-video w-full"
        />
        {chosen ? (
          <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-3.5" />
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 p-2">
        <span className="line-clamp-2 text-sm">{source.title}</span>
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          {formatDuration(source.durationMs)}
          {source.width ? ` · ${source.width}×${source.height}` : ''}
          {!ready ? (
            <Tag tone={SOURCE_STATUS_TONE[source.status] ?? 'neutral'}>
              {SOURCE_STATUS_LABEL[source.status]}
            </Tag>
          ) : null}
        </span>
      </div>
    </button>
  );
}

/** Step 1 of a new project: choose (or add) the source, name it, then go on to the clip. */
export function NewProjectPage() {
  const sources = useSources();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<Source | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState('');
  const create = useAction(
    () => api.post<Project>('/api/projects', { sourceId: chosen?.id, name: name.trim() || chosen?.title }),
    {
      success: (p) => `已建立項目「${p.name}」`,
      invalidate: [qk.projects],
      onSuccess: (p) => void navigate({ to: '/projects/$ref/clip', params: { ref: p.slug } }),
    },
  );
  const download = useAction((u: string) => api.post('/api/sources', { url: u }), {
    success: '已開始下載；完成後就能選它',
    invalidate: [qk.sources, qk.jobs],
    onSuccess: () => setUrl(''),
  });
  const importFile = useAction((f: string) => api.post('/api/sources/import', { file: f }), {
    success: '已開始匯入；完成後就能選它',
    invalidate: [qk.sources, qk.jobs],
    onSuccess: () => setFile(''),
  });
  if (sources.isPending) return <Loading />;
  if (sources.isError) return <ErrorState error={sources.error} />;
  return (
    <div className="flex flex-col">
      <PageHeader
        title="新建項目"
        description={<StepStrip current={0} />}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/">
              <ArrowLeftIcon />
              回到項目
            </Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-4 p-5">
        <Card>
          <CardHeader>
            <CardTitle>第 1 步 · 選擇片源</CardTitle>
            <span className="ml-auto text-muted-foreground text-xs">
              從下載合集選一部影片，或先加一部進來
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {sources.data.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
                {sources.data.map((s) => (
                  <SourceChoice
                    key={s.id}
                    source={s}
                    chosen={chosen?.id === s.id}
                    onChoose={() => {
                      setChosen(s);
                      if (!name.trim()) setName(s.title);
                    }}
                  />
                ))}
              </div>
            ) : (
              <EmptyState className="m-0">下載合集是空的，先在下面加一部影片。</EmptyState>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (/^https?:\/\//.test(url.trim())) download.mutate(url.trim());
                }}
              >
                <Field label="用連結下載（YouTube、Bilibili…）" className="flex-1">
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
                </Field>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!/^https?:\/\//.test(url.trim()) || download.isPending}
                >
                  <LinkIcon />
                  下載
                </Button>
              </form>
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (file.trim()) importFile.mutate(file.trim());
                }}
              >
                <Field label="匯入本機檔案（完整路徑）" className="flex-1">
                  <Input
                    value={file}
                    onChange={(e) => setFile(e.target.value)}
                    placeholder="/Users/…/op.mp4"
                  />
                </Field>
                <Button type="submit" variant="outline" disabled={!file.trim() || importFile.isPending}>
                  <FolderInputIcon />
                  匯入
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="項目名稱" className="w-80">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={chosen?.title ?? '先選片源'}
              aria-label="項目名稱"
            />
          </Field>
          <Button disabled={!chosen || create.isPending} onClick={() => create.mutate(undefined)}>
            建立並前往第 2 步：節選
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Step 1 inside a project: the source it was made from. */
export function ProjectSourcePage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const overview = useOverview(ref);
  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  const { source, project } = overview.data;
  return (
    <div className="flex flex-col">
      <PageHeader
        title="片源"
        description={`項目「${project.name}」用的影片。一個項目對應一部影片；換影片請新建項目。`}
      />
      <div className="flex flex-wrap gap-5 p-5">
        <Thumb
          src={fileUrl(source.thumbPath, source.updatedAt)}
          alt={source.title}
          className="aspect-video w-[480px] rounded-lg"
        />
        <div className="flex min-w-64 flex-col gap-2 text-sm">
          <span className="font-medium text-base">{source.title}</span>
          <span className="text-muted-foreground">
            {formatDuration(source.durationMs)}
            {source.width ? ` · ${source.width}×${source.height}` : ''}
            {source.fpsNum && source.fpsDen ? ` · ${(source.fpsNum / source.fpsDen).toFixed(3)} fps` : ''}
          </span>
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="truncate text-primary text-xs hover:underline"
            >
              {source.url}
            </a>
          ) : (
            <span className="text-muted-foreground text-xs">本機匯入</span>
          )}
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link to="/sources">
              <DownloadIcon />
              下載合集
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
