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
  projects: lazyRouteComponent(() => import('@/pages/ProjectsPage'), 'ProjectsPage'),
  newProject: lazyRouteComponent(() => import('@/pages/NewProjectPage'), 'NewProjectPage'),
  projectSource: lazyRouteComponent(() => import('@/pages/NewProjectPage'), 'ProjectSourcePage'),
  library: lazyRouteComponent(() => import('@/pages/LibraryPage'), 'LibraryPage'),
  persona: lazyRouteComponent(() => import('@/pages/PersonasPage'), 'PersonaDetailPage'),
  settings: lazyRouteComponent(() => import('@/pages/SettingsPage'), 'SettingsPage'),
  sources: lazyRouteComponent(() => import('@/pages/SourcesPage'), 'SourcesPage'),
  projectTasks: lazyRouteComponent(() => import('@/pages/TasksPage'), 'ProjectTasksPage'),
  overview: lazyRouteComponent(() => import('@/pages/OverviewPage'), 'OverviewPage'),
  clip: lazyRouteComponent(() => import('@/pages/ClipPage'), 'ClipPage'),
  shots: lazyRouteComponent(() => import('@/pages/ShotsPage'), 'ShotsPage'),
  cast: lazyRouteComponent(() => import('@/pages/CastPage'), 'CastPage'),
  castDetail: lazyRouteComponent(() => import('@/pages/CastPage'), 'CastDetailPage'),
  design: lazyRouteComponent(() => import('@/pages/DesignPage'), 'DesignPage'),
  reviewIndex: lazyRouteComponent(() => import('@/pages/ReviewPage'), 'ReviewIndexPage'),
  review: lazyRouteComponent(() => import('@/pages/ReviewPage'), 'ReviewPage'),
  renders: lazyRouteComponent(() => import('@/pages/RendersPage'), 'RendersPage'),
};

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });

// Projects are the core; the library, the download collection and settings sit beside them.
const projectsHomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: page.projects,
});
const newProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'projects/new',
  component: page.newProject,
});
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'library',
  component: page.library,
});
const personaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'library/$personaId',
  component: page.persona,
});
const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sources',
  component: page.sources,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  component: page.settings,
});
// Old addresses from before the project-first layout.
const personasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'personas',
  component: () => <Navigate to="/library" />,
});
const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'tasks',
  component: () => <Navigate to="/" />,
});
const projectsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'projects',
  component: () => <Navigate to="/" />,
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
const sourceRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'source',
  component: page.projectSource,
});
const projectTasksRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'tasks',
  component: page.projectTasks,
});
const clipRoute = createRoute({ getParentRoute: () => projectRoute, path: 'clip', component: page.clip });
const shotsRoute = createRoute({ getParentRoute: () => projectRoute, path: 'shots', component: page.shots });
const castRoute = createRoute({ getParentRoute: () => projectRoute, path: 'cast', component: page.cast });
const castDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'cast/$castId',
  component: page.castDetail,
});
const designRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'design',
  component: page.design,
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
  projectsHomeRoute,
  newProjectRoute,
  libraryRoute,
  personaRoute,
  sourcesRoute,
  settingsRoute,
  personasRoute,
  tasksRoute,
  projectsIndexRoute,
  projectRoute.addChildren([
    overviewRoute,
    sourceRoute,
    clipRoute,
    shotsRoute,
    castRoute,
    castDetailRoute,
    designRoute,
    reviewIndexRoute,
    reviewRoute,
    rendersRoute,
    projectTasksRoute,
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
