import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FolderOpenIcon, FolderPlusIcon, Loader2Icon, SearchCheckIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { ConfirmDialog, ErrorState, Field, Loading, PageHeader, Tag } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatAgo, formatTime, formatUsd } from '@/lib/format';
import { useAction, useHealth, useProjects, useWorkspace } from '@/lib/queries';
import type { Health, InspectResult } from '@/lib/types';

const RESTART_TIMEOUT_MS = 45_000;

/** Full-screen state while the daemon exits and launchd brings it back on the new workspace. */
function Restarting({ target, previousPid }: { target: string; previousPid: number | undefined }) {
  const qc = useQueryClient();
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const started = Date.now();
    let stop = false;
    const poll = async () => {
      // The daemon exits ~300 ms after answering the switch; do not mistake it for the new one.
      await new Promise((r) => setTimeout(r, 1000));
      while (!stop) {
        setElapsed(Date.now() - started);
        try {
          const h = await api.get<Health>('/api/health');
          // A new pid means the daemon came back; without a known pid fall back to the workspace root.
          const back = previousPid !== undefined ? h.pid !== previousPid : h.workspace.root === target;
          if (back) {
            setDone(true);
            await qc.resetQueries();
            window.location.assign('/');
            return;
          }
        } catch {
          // Expected while the daemon is down.
        }
        if (Date.now() - started > RESTART_TIMEOUT_MS) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [qc, target, previousPid]);
  const timedOut = elapsed > RESTART_TIMEOUT_MS;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90">
      <Card className="w-[34rem]">
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2 font-semibold">
            {timedOut ? null : <Loader2Icon className="size-4 animate-spin" />}
            {done ? '已切換，重新載入…' : timedOut ? 'AniRecast 服務沒有回來' : 'AniRecast 服務正在重新啟動…'}
          </div>
          <div className="break-all text-muted-foreground text-xs">新的 Workspace：{target}</div>
          {timedOut ? (
            <div className="flex flex-col gap-2 text-xs">
              <span>
                服務在 {Math.round(RESTART_TIMEOUT_MS / 1000)} 秒內沒有重新啟動。正式安裝時由 launchd
                自動重啟；開發模式下請手動啟動：
              </span>
              <code className="rounded bg-background/60 p-2 font-mono">anirecast serve</code>
              <Button variant="outline" onClick={() => window.location.reload()}>
                重新整理
              </Button>
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">已等待 {Math.round(elapsed / 1000)} 秒</span>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all">{children}</span>
    </div>
  );
}

export function WorkspacePage() {
  const workspace = useWorkspace();
  const health = useHealth();
  const projects = useProjects();
  const [openPath, setOpenPath] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newName, setNewName] = useState('');
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [pending, setPending] = useState<{ path: string; create?: boolean; name?: string } | null>(null);
  const [restarting, setRestarting] = useState<{ target: string; pid: number | undefined } | null>(null);

  const check = useAction((p: string) => api.post<InspectResult>('/api/workspace/inspect', { path: p }), {
    invalidate: [],
    onSuccess: setInspect,
  });
  const switchTo = useAction(
    (v: { path: string; create?: boolean; name?: string }) =>
      api.post<{ root: string; restarting: boolean }>('/api/workspace/switch', v),
    {
      invalidate: [],
      onSuccess: (r) => {
        setPending(null);
        setRestarting({ target: r.root, pid: health.data?.pid });
      },
    },
  );

  if (workspace.isPending) return <Loading />;
  if (workspace.isError) return <ErrorState error={workspace.error} />;
  const w = workspace.data;
  const recent = w.config.recentWorkspaces.filter((p) => p !== w.root);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Workspace"
        description="一個 Workspace 是一整包可以搬到別台電腦的資料夾：物料庫、下載合集、項目與資料庫。"
      />
      <div className="grid gap-4 p-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>目前的 Workspace</CardTitle>
            <Tag tone="success" className="ml-auto">
              使用中
            </Tag>
          </CardHeader>
          <CardContent>
            <Row label="名稱">{w.manifest.name}</Row>
            <Row label="路徑">
              <span className="font-mono">{w.root}</span>
            </Row>
            <Row label="ID">
              <span className="font-mono">{w.manifest.workspaceId}</span>
            </Row>
            <Row label="格式版本">
              v{w.manifest.formatVersion}（建立於 {w.manifest.createdAt.slice(0, 10)}）
            </Row>
            <Row label="鎖檔">
              {w.lock ? `${w.lock.host} · pid ${w.lock.pid} · ${formatAgo(w.lock.refreshedAt)}更新` : '—'}
            </Row>
            <Row label="服務">
              {health.data
                ? `v${health.data.version} · pid ${health.data.pid} · 啟動於 ${formatTime(health.data.startedAt)} · ${health.data.activeJobs.length} 個任務執行中`
                : '—'}
            </Row>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>模型、預算與 Codex（本機設定）</CardTitle>
          </CardHeader>
          <CardContent>
            <Row label="供應器">
              <Tag tone={w.config.provider === 'fake' ? 'warning' : 'success'}>{w.config.provider}</Tag>
              {w.config.provider === 'fake' ? (
                <span className="ml-2 text-muted-foreground">離線假供應器，不花錢</span>
              ) : null}
            </Row>
            <Row label="分鏡圖模型">{w.config.models.image}</Row>
            <Row label="分鏡視頻模型">{w.config.models.video}</Row>
            <Row label="視覺分析模型">{w.config.models.vision}</Row>
            <Row label="已花費">{formatUsd(w.spend.totalUsd)}</Row>
            <Row label="花費上限">
              {w.config.budget.capUsd === null ? '未設定' : formatUsd(w.config.budget.capUsd)}
            </Row>
            <Row label="Codex 自動派發">{w.config.codex.autoDispatch ? '開啟' : '暫停'}</Row>
            <p className="mt-2 text-[11px] text-muted-foreground">
              這些設定存在本機 ~/.config/anirecast/config.json，不在 Workspace 裡；API key 永遠不寫進
              Workspace。
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>項目</CardTitle>
            <Link to="/sources" className="ml-auto text-primary text-xs hover:underline">
              從下載合集建立
            </Link>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {(projects.data ?? []).map((p) => (
              <Link
                key={p.id}
                to="/projects/$ref"
                params={{ ref: p.slug }}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
              >
                <span className="font-medium">{p.name}</span>
                <span className="font-mono text-muted-foreground">{p.slug}</span>
                <span className="ml-auto text-muted-foreground">{formatTime(p.updatedAt)}</span>
              </Link>
            ))}
            {projects.data && !projects.data.length ? (
              <span className="text-muted-foreground text-xs">還沒有項目。</span>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>切換 Workspace</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <span className="text-muted-foreground text-xs">
              切換時 AniRecast 服務會重新啟動並打開新的 Workspace。同一個 Workspace 一次只能被一台電腦打開。
            </span>
            {recent.length ? (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">最近使用</span>
                {recent.map((p) => (
                  <div key={p} className="flex items-center gap-2 rounded border bg-background/40 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={p}>
                      {p}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setPending({ path: p })}>
                      打開
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (openPath.trim()) check.mutate(openPath.trim());
              }}
            >
              <Field label="打開既有資料夾">
                <div className="flex gap-1.5">
                  <Input
                    value={openPath}
                    onChange={(e) => {
                      setOpenPath(e.target.value);
                      setInspect(null);
                    }}
                    placeholder="/Users/…/mediaHub"
                    aria-label="既有 Workspace 路徑"
                    className="font-mono"
                  />
                  <Button type="submit" variant="outline" disabled={!openPath.trim() || check.isPending}>
                    <SearchCheckIcon />
                    檢查
                  </Button>
                  <Button
                    disabled={!inspect?.valid}
                    onClick={() => inspect && setPending({ path: inspect.root })}
                  >
                    <FolderOpenIcon />
                    打開
                  </Button>
                </div>
              </Field>
              {inspect ? (
                inspect.valid ? (
                  <span className="text-emerald-300 text-xs">
                    可以打開：{inspect.manifest?.name}（schema v{inspect.schemaVersion}/
                    {inspect.latestSchemaVersion}）
                  </span>
                ) : (
                  <span className="text-red-300 text-xs">不能打開：{inspect.problems.join('；')}</span>
                )
              ) : null}
            </form>
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (newPath.trim())
                  setPending({
                    path: newPath.trim(),
                    create: true,
                    ...(newName.trim() ? { name: newName.trim() } : {}),
                  });
              }}
            >
              <Field label="新建（選一個空資料夾）">
                <div className="flex gap-1.5">
                  <Input
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    placeholder="/Users/…/新的 Workspace"
                    aria-label="新 Workspace 路徑"
                    className="flex-[2] font-mono"
                  />
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="名稱（可留空）"
                    aria-label="新 Workspace 名稱"
                    className="flex-1"
                  />
                  <Button type="submit" variant="outline" disabled={!newPath.trim()}>
                    <FolderPlusIcon />
                    新建
                  </Button>
                </div>
              </Field>
            </form>
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.create ? '新建並切換 Workspace？' : '切換 Workspace？'}
        description={`AniRecast 服務會重新啟動並打開 ${pending?.path ?? ''}。進行中的背景任務會在重新打開這個 Workspace 時繼續。`}
        confirmLabel={pending?.create ? '新建並切換' : '切換'}
        pending={switchTo.isPending}
        onConfirm={() => pending && switchTo.mutate(pending)}
      />
      {restarting ? <Restarting target={restarting.target} previousPid={restarting.pid} /> : null}
    </div>
  );
}
