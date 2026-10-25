import { Link, Outlet, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import {
  ActivityIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BoxesIcon,
  CheckIcon,
  ClapperboardIcon,
  DownloadIcon,
  FolderKanbanIcon,
  GaugeIcon,
  type LucideIcon,
  SettingsIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/common';
import { LightboxProvider } from '@/components/lightbox';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Toaster } from '@/components/ui/sonner';
import { useConnection, useDaemonEvents } from '@/lib/events';
import { useHealth, useOverview, useProjectSummaries, useWorkspace } from '@/lib/queries';
import { STEPS, stepOfPath, stepState } from '@/lib/steps';
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

function ProjectSwitcher({ current }: { current: string }) {
  const projects = useProjectSummaries();
  const navigate = useNavigate();
  const list = projects.data ?? [];
  const value = list.find((p) => p.slug === current || p.id === current)?.slug;
  return (
    <Select
      value={value ?? ''}
      onValueChange={(slug) => void navigate({ to: '/projects/$ref', params: { ref: slug } })}
    >
      <SelectTrigger size="sm" className="w-full" aria-label="切換項目">
        <SelectValue placeholder="選擇項目…" />
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

/** The open project: overview, the numbered steps of the flow with their state, and its task centre. */
function ProjectNav({ projectRef }: { projectRef: string }) {
  const projects = useProjectSummaries();
  const summary = projects.data?.find((p) => p.slug === projectRef || p.id === projectRef);
  const params = { ref: projectRef };
  return (
    <div className="mt-1 flex flex-col gap-1 rounded-md border border-border/60 bg-background/30 p-1.5">
      <ProjectSwitcher current={projectRef} />
      <nav className="flex flex-col gap-0.5">
        <NavItem to="/projects/$ref" params={params} icon={GaugeIcon} exact>
          總覽
        </NavItem>
        {STEPS.map((step, i) => {
          const state = stepState(step.id, summary?.step);
          return (
            <Link
              key={step.id}
              to={step.to}
              params={params}
              title={step.hint}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              activeProps={{ className: 'bg-accent !text-foreground' }}
            >
              <span
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]',
                  state === 'done' && 'border-emerald-500/60 bg-emerald-500/20 text-emerald-300',
                  state === 'current' && 'border-sky-400 text-sky-300',
                  state === 'todo' && 'border-border',
                )}
              >
                {state === 'done' ? <CheckIcon className="size-3" /> : i + 1}
              </span>
              <span className="flex-1 truncate">{step.label}</span>
            </Link>
          );
        })}
        <NavItem
          to="/projects/$ref/tasks"
          params={params}
          icon={ActivityIcon}
          badge={
            <span className="flex gap-1">
              <CountBadge n={summary?.openTasks ?? 0} />
              <CountBadge n={(summary?.needsUser ?? 0) + (summary?.discussions ?? 0)} tone="warning" />
            </span>
          }
        >
          任務中心
        </NavItem>
      </nav>
    </div>
  );
}

function Sidebar() {
  const params = useParams({ strict: false }) as { ref?: string };
  const ref = params.ref;
  const health = useHealth();
  const workspace = useWorkspace();
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
        <NavItem to="/" icon={FolderKanbanIcon} exact>
          項目
        </NavItem>
        {ref ? <ProjectNav projectRef={ref} /> : null}
        <NavItem to="/library" icon={BoxesIcon}>
          物料庫
        </NavItem>
        <NavItem to="/sources" icon={DownloadIcon}>
          下載合集
        </NavItem>
      </nav>
      <div className="mt-auto flex flex-col gap-1 border-t px-2 py-2">
        <NavItem to="/settings" icon={SettingsIcon}>
          設定
        </NavItem>
        <div className="flex flex-col gap-0.5 px-1 pt-1">
          <ConnectionDot />
          <span className="truncate text-[11px] text-muted-foreground" title={workspace.data?.root}>
            {workspace.data?.manifest.name ?? health.data?.workspace.name ?? '—'}
          </span>
        </div>
      </div>
    </aside>
  );
}

export function AppShell() {
  useDaemonEvents();
  return (
    <LightboxProvider>
      <div className="flex h-full overflow-hidden">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
        <Toaster />
      </div>
    </LightboxProvider>
  );
}

/** Previous / next step at the bottom of a step page (not on detail pages such as one shot or one character). */
function StepFooter({ projectRef }: { projectRef: string }) {
  const { pathname } = useLocation();
  const step = stepOfPath(pathname);
  const isDetail = /^\/projects\/[^/]+\/(review|cast)\/[^/]+/.test(pathname);
  if (!step || isDetail) return null;
  const i = STEPS.findIndex((s) => s.id === step);
  const prev = STEPS[i - 1];
  const next = STEPS[i + 1];
  const params = { ref: projectRef };
  return (
    <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
      {prev ? (
        <Button asChild variant="outline" size="sm">
          <Link to={prev.to} params={params}>
            <ArrowLeftIcon />
            上一步：{prev.label}
          </Link>
        </Button>
      ) : (
        <span />
      )}
      <span className="text-muted-foreground text-xs">
        第 {i + 1} / {STEPS.length} 步 · {STEPS[i]?.hint}
      </span>
      {next ? (
        <Button asChild size="sm">
          <Link to={next.to} params={params}>
            下一步：{next.label}
            <ArrowRightIcon />
          </Link>
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** Loads the project once so every project page can assume it exists, and adds step navigation. */
export function ProjectLayout() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const overview = useOverview(ref);
  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <Outlet />
      </div>
      <StepFooter projectRef={ref} />
    </div>
  );
}

export function NotFound() {
  return (
    <div className="p-6">
      <EmptyState>
        找不到這個頁面。
        <Link to="/" className="text-primary hover:underline">
          回到項目
        </Link>
      </EmptyState>
    </div>
  );
}
