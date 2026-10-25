import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import {
  ActivityIcon,
  ClapperboardIcon,
  DownloadIcon,
  FilmIcon,
  FolderOpenIcon,
  GaugeIcon,
  type LucideIcon,
  ScissorsIcon,
  SquareStackIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/common';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Toaster } from '@/components/ui/sonner';
import { useConnection, useDaemonEvents } from '@/lib/events';
import { useHealth, useOverview, useProjects, useTasks, useWorkspace } from '@/lib/queries';
import { cn } from '@/lib/utils';

function NavItem({
  to,
  params,
  icon: Icon,
  children,
  badge,
  exact,
}: {
  to: string;
  params?: Record<string, string>;
  icon: LucideIcon;
  children: ReactNode;
  badge?: ReactNode;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      params={params}
      activeOptions={{ exact: Boolean(exact) }}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      activeProps={{ className: 'bg-accent !text-foreground' }}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{children}</span>
      {badge}
    </Link>
  );
}

function CountBadge({ n, tone = 'info' }: { n: number; tone?: 'info' | 'warning' }) {
  if (!n) return null;
  return (
    <span
      className={cn(
        'rounded px-1.5 font-mono text-[10px] leading-4',
        tone === 'warning' ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300',
      )}
    >
      {n}
    </span>
  );
}

function ConnectionDot() {
  const state = useConnection();
  const label = { open: '即時更新已連線', connecting: '連線中…', closed: '即時更新中斷，重試中' }[state];
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground text-xs" title={label}>
      <span
        className={cn(
          'size-2 rounded-full',
          state === 'open' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-amber-400' : 'bg-red-500',
        )}
      />
      {label}
    </span>
  );
}

function ProjectSwitcher({ current }: { current: string | undefined }) {
  const projects = useProjects();
  const navigate = useNavigate();
  const list = projects.data ?? [];
  const value = list.find((p) => p.slug === current || p.id === current)?.slug;
  return (
    <Select
      value={value ?? ''}
      onValueChange={(slug) => void navigate({ to: '/projects/$ref', params: { ref: slug } })}
    >
      <SelectTrigger size="sm" className="w-full" aria-label="切換項目">
        <SelectValue placeholder={list.length ? '選擇項目…' : '還沒有項目'} />
      </SelectTrigger>
      <SelectContent>
        {list.map((p) => (
          <SelectItem key={p.id} value={p.slug}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Sidebar() {
  const params = useParams({ strict: false });
  const ref = params.ref;
  const health = useHealth();
  const workspace = useWorkspace();
  const tasks = useTasks();
  const needsUser = (tasks.data ?? []).filter((t) => t.status === 'needs_user').length;
  const activeJobs = health.data?.activeJobs.length ?? 0;
  const provider = workspace.data?.config.provider;
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar">
      <div className="flex items-center gap-2 px-3 py-3">
        <ClapperboardIcon className="size-5 text-primary" />
        <span className="font-semibold tracking-tight">AniRecast</span>
        {provider ? (
          <span
            className={cn(
              'ml-auto rounded px-1.5 font-mono text-[10px] leading-4',
              provider === 'fake' ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300',
            )}
            title="模型供應器"
          >
            {provider}
          </span>
        ) : null}
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        <NavItem to="/" icon={FolderOpenIcon} exact>
          Workspace
        </NavItem>
        <NavItem to="/sources" icon={DownloadIcon}>
          下載合集
        </NavItem>
        <NavItem to="/personas" icon={UserRoundIcon}>
          素材庫
        </NavItem>
        <NavItem
          to="/tasks"
          icon={ActivityIcon}
          badge={
            <span className="flex gap-1">
              <CountBadge n={activeJobs} />
              <CountBadge n={needsUser} tone="warning" />
            </span>
          }
        >
          任務中心
        </NavItem>
      </nav>
      <div className="mt-4 flex flex-col gap-1.5 px-2">
        <div className="px-1 text-[11px] text-muted-foreground uppercase tracking-wider">項目</div>
        <ProjectSwitcher current={ref} />
      </div>
      {ref ? (
        <nav className="mt-1 flex flex-col gap-0.5 px-2">
          <NavItem to="/projects/$ref" params={{ ref }} icon={GaugeIcon} exact>
            項目總覽
          </NavItem>
          <NavItem to="/projects/$ref/clip" params={{ ref }} icon={ScissorsIcon}>
            原片與節選
          </NavItem>
          <NavItem to="/projects/$ref/shots" params={{ ref }} icon={SquareStackIcon}>
            分鏡
          </NavItem>
          <NavItem to="/projects/$ref/cast" params={{ ref }} icon={UsersRoundIcon}>
            角色表
          </NavItem>
          <NavItem to="/projects/$ref/review" params={{ ref }} icon={ClapperboardIcon}>
            評審台
          </NavItem>
          <NavItem to="/projects/$ref/renders" params={{ ref }} icon={FilmIcon}>
            成片
          </NavItem>
        </nav>
      ) : null}
      <div className="mt-auto flex flex-col gap-1 border-t px-3 py-2">
        <ConnectionDot />
        <span className="truncate text-[11px] text-muted-foreground" title={workspace.data?.root}>
          {workspace.data?.manifest.name ?? health.data?.workspace.name ?? '—'}
        </span>
      </div>
    </aside>
  );
}

export function AppShell() {
  useDaemonEvents();
  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}

/** Loads the project once so every project page can assume it exists. */
export function ProjectLayout() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const overview = useOverview(ref);
  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  return <Outlet />;
}

export function NotFound() {
  return (
    <div className="p-6">
      <EmptyState>
        找不到這個頁面。
        <Link to="/" className="text-primary hover:underline">
          回到 Workspace
        </Link>
      </EmptyState>
    </div>
  );
}
