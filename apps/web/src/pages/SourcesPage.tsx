import { Link, useNavigate } from '@tanstack/react-router';
import { DownloadIcon, FileVideoIcon, FolderInputIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { api, fileUrl } from '@/lib/api';
import { formatDuration, formatTime } from '@/lib/format';
import { SOURCE_STATUS_LABEL, SOURCE_STATUS_TONE } from '@/lib/labels';
import { qk, useAction, useJobs, useProjects, useSources } from '@/lib/queries';
import type { Job, Project, Source } from '@/lib/types';

function CreateProjectDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(source.title);
  const create = useAction(
    () => api.post<Project>('/api/projects', { sourceId: source.id, name: name.trim() }),
    {
      success: (p) => `已建立項目「${p.name}」`,
      invalidate: [qk.projects],
      onSuccess: (p) => {
        onClose();
        void navigate({ to: '/projects/$ref/clip', params: { ref: p.slug } });
      },
    },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>從這部影片建立項目</DialogTitle>
          <DialogDescription>{source.title}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate(undefined);
          }}
        >
          <Field label="項目名稱">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="項目名稱" />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              建立並前往節選
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SourceCard({
  source,
  job,
  projects,
  onCreate,
  onRemove,
}: {
  source: Source;
  job: Job | undefined;
  projects: Project[];
  onCreate: () => void;
  onRemove: () => void;
}) {
  const busy = job?.status === 'running' || job?.status === 'queued';
  const fps = source.fpsNum && source.fpsDen ? (source.fpsNum / source.fpsDen).toFixed(3) : null;
  return (
    <Card>
      <Thumb
        src={fileUrl(source.thumbPath, source.updatedAt)}
        alt={source.title}
        className="aspect-video w-full rounded-t-lg"
        zoom
      />
      <div className="flex flex-col gap-1.5 p-2.5">
        <div className="flex items-start gap-2">
          <span className="line-clamp-2 flex-1 font-medium" title={source.title}>
            {source.title}
          </span>
          <Tag tone={SOURCE_STATUS_TONE[source.status] ?? 'neutral'}>
            {SOURCE_STATUS_LABEL[source.status] ?? source.status}
          </Tag>
        </div>
        <div className="text-muted-foreground text-xs">
          {formatDuration(source.durationMs)}
          {source.width ? ` · ${source.width}×${source.height}` : ''}
          {fps ? ` · ${fps} fps` : ''}
          {source.uploader ? ` · ${source.uploader}` : ''}
        </div>
        {source.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="truncate text-primary text-xs hover:underline"
            title={source.url}
          >
            {source.site ? `${source.site} · ` : ''}
            {source.url}
          </a>
        ) : (
          <span className="text-muted-foreground text-xs">本機匯入 · {formatTime(source.createdAt)}</span>
        )}
        {job && (job.status === 'running' || job.status === 'queued') ? (
          <div className="flex flex-col gap-1">
            <Progress value={Math.round(job.progress * 100)} />
            <span className="text-[11px] text-muted-foreground">
              {job.status === 'queued' ? '排隊中' : `${Math.round(job.progress * 100)}% ${job.message ?? ''}`}
            </span>
          </div>
        ) : null}
        {source.error ? <div className="text-red-300 text-xs">{source.error}</div> : null}
        {projects.length ? (
          <div className="flex flex-wrap gap-1 text-xs">
            {projects.map((p) => (
              <Link
                key={p.id}
                to="/projects/$ref"
                params={{ ref: p.slug }}
                className="rounded bg-secondary px-1.5 py-0.5 hover:bg-accent"
              >
                {p.name}
              </Link>
            ))}
          </div>
        ) : null}
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            disabled={source.status !== 'ready'}
            onClick={onCreate}
          >
            <PlusIcon />
            建立項目
          </Button>
          {projects.length === 0 && !busy ? (
            <Button
              size="sm"
              variant="ghost"
              title="移到 Workspace 的垃圾桶"
              aria-label="移到垃圾桶"
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function SourcesPage() {
  const sources = useSources();
  const projects = useProjects();
  const jobs = useJobs();
  const [url, setUrl] = useState('');
  const [file, setFile] = useState('');
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<Source | null>(null);
  const [duplicate, setDuplicate] = useState<Source | null>(null);

  const remove = useAction((id: string) => api.del(`/api/sources/${id}`), {
    success: '已移到垃圾桶',
    invalidate: [qk.sources],
  });
  const add = useAction((u: string) => api.post('/api/sources', { url: u }), {
    success: '已開始下載',
    invalidate: [qk.sources, qk.jobs],
    onSuccess: () => {
      setUrl('');
      setDuplicate(null);
    },
  });
  const importFile = useAction(
    () =>
      api.post('/api/sources/import', {
        file: file.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
      }),
    {
      success: '已開始匯入',
      invalidate: [qk.sources, qk.jobs],
      onSuccess: () => {
        setFile('');
        setTitle('');
      },
    },
  );

  const submitUrl = () => {
    const u = url.trim();
    if (!/^https?:\/\//.test(u)) return;
    const existing = sources.data?.find((s) => s.url === u && s.status !== 'trashed');
    if (existing) setDuplicate(existing);
    else add.mutate(u);
  };

  if (sources.isPending) return <Loading />;
  if (sources.isError) return <ErrorState error={sources.error} />;
  const jobFor = (id: string) =>
    jobs.data?.find(
      (j) => (j.payload as { sourceId?: string } | null)?.sourceId === id && j.type.startsWith('source.'),
    );
  const q = query.trim().toLowerCase();
  const list = sources.data
    .filter((s) => s.status !== 'trashed')
    .filter((s) => !q || s.title.toLowerCase().includes(q) || (s.url ?? '').toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="下載合集"
        description="貼連結下載（yt-dlp 支援的網站），或匯入本機影片檔。每部影片可以建立多個項目。"
      />
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <DownloadIcon className="size-4" />
            <CardTitle>貼連結下載</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitUrl();
              }}
            >
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
                aria-label="影片連結"
              />
              <Button type="submit" disabled={!/^https?:\/\//.test(url.trim()) || add.isPending}>
                下載
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <FolderInputIcon className="size-4" />
            <CardTitle>匯入本機檔案</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (file.trim()) importFile.mutate(undefined);
              }}
            >
              <Input
                value={file}
                onChange={(e) => setFile(e.target.value)}
                placeholder="/Users/…/op.mp4（完整路徑）"
                aria-label="本機檔案路徑"
                className="min-w-56 flex-[2]"
              />
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="標題（可留空）"
                aria-label="標題"
                className="min-w-32 flex-1"
              />
              <Button type="submit" disabled={!file.trim() || importFile.isPending}>
                匯入
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
      <div className="flex items-center gap-2 px-5">
        <div className="relative w-72">
          <SearchIcon className="absolute top-2 left-2 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋標題或網址"
            aria-label="搜尋"
            className="pl-8"
          />
        </div>
        <span className="text-muted-foreground text-xs">{list.length} 部影片</span>
      </div>
      <div className="p-5">
        {list.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {list.map((s) => (
              <SourceCard
                key={s.id}
                source={s}
                job={jobFor(s.id)}
                projects={(projects.data ?? []).filter((p) => p.sourceId === s.id)}
                onCreate={() => setCreating(s)}
                onRemove={() => {
                  if (
                    window.confirm(
                      `把「${s.title}」移到 Workspace 的垃圾桶？檔案會移到 trash/sources，可以手動搬回來。`,
                    )
                  )
                    remove.mutate(s.id);
                }}
              />
            ))}
          </div>
        ) : (
          <EmptyState>
            <FileVideoIcon className="size-6" />
            {q ? '沒有符合的影片。' : '下載合集是空的。貼一個連結開始。'}
          </EmptyState>
        )}
      </div>
      {creating ? <CreateProjectDialog source={creating} onClose={() => setCreating(null)} /> : null}
      <ConfirmDialog
        open={duplicate !== null}
        onOpenChange={(o) => !o && setDuplicate(null)}
        title="這個網址已經下載過了"
        description={`下載合集裡已有「${duplicate?.title ?? ''}」。要再下載一份嗎？`}
        confirmLabel="仍然下載"
        pending={add.isPending}
        onConfirm={() => add.mutate(url.trim())}
      />
    </div>
  );
}
