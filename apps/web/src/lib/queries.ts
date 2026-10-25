import { type QueryKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorText } from './api';
import type {
  AgentTask,
  AssetKind,
  CastMember,
  CostSummary,
  Health,
  Job,
  Persona,
  PersonaDesigns,
  Project,
  ProjectOverview,
  ProjectSummary,
  Render,
  SettingsInfo,
  ShotDetail,
  Source,
  WorkspaceInfo,
} from './types';

/**
 * Query keys. Everything scoped to one project sits under ['project', ref, …] and every shot detail
 * under ['shot', id], so SSE events can invalidate by prefix (see `events.ts`).
 */
export const qk = {
  health: ['health'] as const,
  workspace: ['workspace'] as const,
  sources: ['sources'] as const,
  projects: ['projects'] as const,
  projectSummaries: ['projects', 'summary'] as const,
  settings: ['settings'] as const,
  overview: (ref: string) => ['project', ref, 'overview'] as const,
  cast: (ref: string) => ['project', ref, 'cast'] as const,
  renders: (ref: string) => ['project', ref, 'renders'] as const,
  projectCost: (ref: string) => ['project', ref, 'cost'] as const,
  shot: (id: string) => ['shot', id] as const,
  personas: (archived: boolean, kind?: AssetKind) => ['personas', archived, kind ?? 'all'] as const,
  jobs: ['jobs'] as const,
  tasks: ['tasks'] as const,
  projectTasks: (ref: string) => ['project', ref, 'tasks'] as const,
  designs: (ref: string) => ['project', ref, 'designs'] as const,
  cost: ['cost'] as const,
};

export const useHealth = () =>
  useQuery({ queryKey: qk.health, queryFn: () => api.get<Health>('/api/health'), refetchInterval: 10_000 });
export const useWorkspace = () =>
  useQuery({ queryKey: qk.workspace, queryFn: () => api.get<WorkspaceInfo>('/api/workspace') });
export const useSources = () =>
  useQuery({ queryKey: qk.sources, queryFn: () => api.get<Source[]>('/api/sources') });
export const useProjects = () =>
  useQuery({ queryKey: qk.projects, queryFn: () => api.get<Project[]>('/api/projects') });
export const useOverview = (ref: string) =>
  useQuery({
    queryKey: qk.overview(ref),
    queryFn: () => api.get<ProjectOverview>(`/api/projects/${encodeURIComponent(ref)}`),
  });
export const useCast = (ref: string) =>
  useQuery({
    queryKey: qk.cast(ref),
    queryFn: () => api.get<CastMember[]>(`/api/projects/${encodeURIComponent(ref)}/cast`),
  });
export const useRenders = (ref: string) =>
  useQuery({
    queryKey: qk.renders(ref),
    queryFn: () => api.get<Render[]>(`/api/projects/${encodeURIComponent(ref)}/renders`),
  });
export const useProjectCost = (ref: string) =>
  useQuery({
    queryKey: qk.projectCost(ref),
    queryFn: () => api.get<CostSummary>(`/api/cost?project=${encodeURIComponent(ref)}`),
  });
export const useCost = () =>
  useQuery({ queryKey: qk.cost, queryFn: () => api.get<CostSummary>('/api/cost') });
export const useShot = (id: string | undefined) =>
  useQuery({
    queryKey: qk.shot(id ?? ''),
    queryFn: () => api.get<ShotDetail>(`/api/shots/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
  });
export const usePersonas = (archived = false, kind?: AssetKind) =>
  useQuery({
    queryKey: qk.personas(archived, kind),
    queryFn: () => {
      const q = new URLSearchParams({ ...(archived ? { archived: '1' } : {}), ...(kind ? { kind } : {}) });
      return api.get<Persona[]>(`/api/personas${q.size ? `?${q}` : ''}`);
    },
  });
export const useProjectSummaries = () =>
  useQuery({
    queryKey: qk.projectSummaries,
    queryFn: () => api.get<ProjectSummary[]>('/api/projects?summary=1'),
  });
export const useSettings = () =>
  useQuery({ queryKey: qk.settings, queryFn: () => api.get<SettingsInfo>('/api/settings') });
export const useProjectTasks = (ref: string) =>
  useQuery({
    queryKey: qk.projectTasks(ref),
    queryFn: () => api.get<AgentTask[]>(`/api/tasks?project=${encodeURIComponent(ref)}`),
  });
export const useDesigns = (ref: string) =>
  useQuery({
    queryKey: qk.designs(ref),
    queryFn: () => api.get<PersonaDesigns[]>(`/api/projects/${encodeURIComponent(ref)}/designs`),
  });
export const useJobs = () =>
  useQuery({ queryKey: qk.jobs, queryFn: () => api.get<Job[]>('/api/jobs?limit=200') });
export const useTasks = () =>
  useQuery({ queryKey: qk.tasks, queryFn: () => api.get<AgentTask[]>('/api/tasks') });

/**
 * Mutation with the app's defaults: error toast, optional success toast, and prefix invalidations
 * (SSE also invalidates, this just makes the acting tab update without waiting for the event).
 */
export function useAction<TVars, TData>(
  fn: (vars: TVars) => Promise<TData>,
  opts: {
    success?: string | ((data: TData, vars: TVars) => string | undefined);
    invalidate?: QueryKey[];
    onSuccess?: (data: TData, vars: TVars) => void;
    onError?: (error: unknown, vars: TVars) => boolean | undefined;
  } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      for (const key of opts.invalidate ?? [['project'], ['shot']])
        void qc.invalidateQueries({ queryKey: key });
      const msg = typeof opts.success === 'function' ? opts.success(data, vars) : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(data, vars);
    },
    onError: (error, vars) => {
      if (opts.onError?.(error, vars)) return;
      toast.error('操作失敗', { description: errorText(error) });
    },
  });
}
