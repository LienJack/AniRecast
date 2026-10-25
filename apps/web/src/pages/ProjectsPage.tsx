import { Link, useNavigate } from '@tanstack/react-router';
import { FolderKanbanIcon, LayoutGridIcon, ListIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, Loading, PageHeader, Tag, Thumb } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { fileUrl } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { TIER_LABEL } from '@/lib/labels';
import { useProjectSummaries } from '@/lib/queries';
import { STEPS } from '@/lib/steps';
import type { ProjectSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

type View = 'cards' | 'list';
const VIEW_KEY = 'anirecast.projects.view';

/** "④ 角色" for the next step, or 完成. */
function StepTag({ p }: { p: ProjectSummary }) {
  if (p.step === 'done') return <Tag tone="success">完成</Tag>;
  const i = STEPS.findIndex((s) => s.id === p.step);
  return (
    <Tag tone="info">
      第 {i + 1} 步 · {STEPS[i]?.label}
    </Tag>
  );
}

function progressOf(p: ProjectSummary): number {
  return p.toGenerate ? Math.round((p.approved / p.toGenerate) * 100) : 0;
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  return (
    <Card className="overflow-hidden">
      <Link to="/projects/$ref" params={{ ref: p.slug }} className="flex flex-col">
        <Thumb src={fileUrl(p.source.thumbPath)} alt={p.name} className="aspect-video w-full" />
        <div className="flex flex-col gap-1.5 p-3">
          <div className="flex items-start gap-2">
            <span className="line-clamp-2 flex-1 font-medium">{p.name}</span>
            <StepTag p={p} />
          </div>
          <span className="truncate text-muted-foreground text-xs" title={p.source.title}>
            {p.source.title}
          </span>
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span>{p.clipSeconds ? `${p.clipSeconds} 秒` : '未節選'}</span>
            <span>· {p.shots} 個分鏡</span>
            <span>· {TIER_LABEL[p.generationTier]}</span>
          </div>
          <div className="flex items-center gap-2">
            <Progress value={progressOf(p)} className="h-1.5 flex-1" />
            <span className="font-mono text-[11px] text-muted-foreground">
              {p.approved}/{p.toGenerate}
            </span>
          </div>
          {p.openTasks ? (
            <span className={cn('text-xs', p.needsUser ? 'text-amber-300' : 'text-muted-foreground')}>
              {p.openTasks} 個進行中的任務{p.needsUser ? `，${p.needsUser} 個等你回覆` : ''}
            </span>
          ) : null}
        </div>
      </Link>
    </Card>
  );
}

function ProjectTable({ list }: { list: ProjectSummary[] }) {
  const navigate = useNavigate();
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-muted-foreground text-xs">
        <tr className="border-b">
          <th className="py-2 font-normal">項目</th>
          <th className="py-2 font-normal">片源</th>
          <th className="py-2 font-normal">進度</th>
          <th className="py-2 font-normal">已通過</th>
          <th className="py-2 font-normal">檔位</th>
          <th className="py-2 font-normal">任務</th>
          <th className="py-2 font-normal">建立</th>
        </tr>
      </thead>
      <tbody>
        {list.map((p) => (
          <tr
            key={p.id}
            className="cursor-pointer border-b border-border/50 hover:bg-accent/40"
            onClick={() => void navigate({ to: '/projects/$ref', params: { ref: p.slug } })}
          >
            <td className="py-2">
              <div className="flex items-center gap-2">
                <Thumb src={fileUrl(p.source.thumbPath)} alt="" className="h-9 w-16 shrink-0 rounded" />
                <span className="font-medium">{p.name}</span>
              </div>
            </td>
            <td className="max-w-56 truncate py-2 text-muted-foreground text-xs">{p.source.title}</td>
            <td className="py-2">
              <StepTag p={p} />
            </td>
            <td className="py-2 font-mono text-xs">
              {p.approved}/{p.toGenerate}
            </td>
            <td className="py-2 text-xs">{TIER_LABEL[p.generationTier]}</td>
            <td className={cn('py-2 text-xs', p.needsUser ? 'text-amber-300' : 'text-muted-foreground')}>
              {p.openTasks || '—'}
            </td>
            <td className="py-2 text-muted-foreground text-xs">{formatTime(p.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Home: every project as cards or a list, and the way into a new one. */
export function ProjectsPage() {
  const projects = useProjectSummaries();
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) as View | null) ?? 'cards');
  const [query, setQuery] = useState('');
  const choose = (v: View) => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };
  if (projects.isPending) return <Loading />;
  if (projects.isError) return <ErrorState error={projects.error} />;
  const q = query.trim().toLowerCase();
  const list = projects.data.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.source.title.toLowerCase().includes(q),
  );
  return (
    <div className="flex flex-col">
      <PageHeader
        title="項目"
        description="每個項目是一部影片的一次重製：選片源 → 節選 → 分鏡 → 角色 → 生成與評審 → 成片。"
        actions={
          <Button asChild size="sm">
            <Link to="/projects/new">
              <PlusIcon />
              新建項目
            </Link>
          </Button>
        }
      />
      <div className="flex items-center gap-2 border-b px-5 py-2">
        <div className="relative w-64">
          <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋項目或片源"
            aria-label="搜尋"
            className="pl-7"
          />
        </div>
        <span className="text-muted-foreground text-xs">{list.length} 個項目</span>
        <div className="ml-auto flex gap-1">
          <Button
            size="icon-sm"
            variant={view === 'cards' ? 'secondary' : 'ghost'}
            aria-label="卡片"
            aria-pressed={view === 'cards'}
            onClick={() => choose('cards')}
          >
            <LayoutGridIcon />
          </Button>
          <Button
            size="icon-sm"
            variant={view === 'list' ? 'secondary' : 'ghost'}
            aria-label="清單"
            aria-pressed={view === 'list'}
            onClick={() => choose('list')}
          >
            <ListIcon />
          </Button>
        </div>
      </div>
      <div className="p-5">
        {!projects.data.length ? (
          <EmptyState>
            <FolderKanbanIcon className="size-6" />
            還沒有項目。
            <Button asChild size="sm">
              <Link to="/projects/new">
                <PlusIcon />
                新建第一個項目
              </Link>
            </Button>
          </EmptyState>
        ) : view === 'cards' ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {list.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <ProjectTable list={list} />
        )}
      </div>
    </div>
  );
}
