import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
} from '@tanstack/react-router';
import { AppShell, NotFound, ProjectLayout } from '@/components/AppShell';
import { Loading } from '@/components/common';

// Pages load on demand so the first paint only needs the shell.
const page = {
  workspace: lazyRouteComponent(() => import('@/pages/WorkspacePage'), 'WorkspacePage'),
  sources: lazyRouteComponent(() => import('@/pages/SourcesPage'), 'SourcesPage'),
  personas: lazyRouteComponent(() => import('@/pages/PersonasPage'), 'PersonasPage'),
  tasks: lazyRouteComponent(() => import('@/pages/TasksPage'), 'TasksPage'),
  overview: lazyRouteComponent(() => import('@/pages/OverviewPage'), 'OverviewPage'),
  clip: lazyRouteComponent(() => import('@/pages/ClipPage'), 'ClipPage'),
  shots: lazyRouteComponent(() => import('@/pages/ShotsPage'), 'ShotsPage'),
  cast: lazyRouteComponent(() => import('@/pages/CastPage'), 'CastPage'),
  castDetail: lazyRouteComponent(() => import('@/pages/CastPage'), 'CastDetailPage'),
  reviewIndex: lazyRouteComponent(() => import('@/pages/ReviewPage'), 'ReviewIndexPage'),
  review: lazyRouteComponent(() => import('@/pages/ReviewPage'), 'ReviewPage'),
  renders: lazyRouteComponent(() => import('@/pages/RendersPage'), 'RendersPage'),
};

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });

const workspaceRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: page.workspace });
const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sources',
  component: page.sources,
});
const personasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'personas',
  component: page.personas,
});
const tasksRoute = createRoute({ getParentRoute: () => rootRoute, path: 'tasks', component: page.tasks });

const projectsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'projects',
  component: () => <Navigate to="/sources" />,
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'projects/$ref',
  component: ProjectLayout,
});
const overviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  component: page.overview,
});
const clipRoute = createRoute({ getParentRoute: () => projectRoute, path: 'clip', component: page.clip });
const shotsRoute = createRoute({ getParentRoute: () => projectRoute, path: 'shots', component: page.shots });
const castRoute = createRoute({ getParentRoute: () => projectRoute, path: 'cast', component: page.cast });
const castDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'cast/$castId',
  component: page.castDetail,
});
const reviewIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'review',
  component: page.reviewIndex,
});
const reviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'review/$shotId',
  component: page.review,
});
const rendersRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'renders',
  component: page.renders,
});

const routeTree = rootRoute.addChildren([
  workspaceRoute,
  sourcesRoute,
  personasRoute,
  tasksRoute,
  projectsIndexRoute,
  projectRoute.addChildren([
    overviewRoute,
    clipRoute,
    shotsRoute,
    castRoute,
    castDetailRoute,
    reviewIndexRoute,
    reviewRoute,
    rendersRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultPendingComponent: () => <Loading />,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
