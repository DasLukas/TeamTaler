import { lazy, Suspense } from 'react';
import { PlanningPermissionRoute } from '@/app/PermissionRoutes';
import { StatePanel } from '@/components/ui/StatePanel';

const PlanningPage = lazy(() => import('./PlanningPage').then((module) => ({ default: module.PlanningPage })));
const PlanningEventDetailPage = lazy(() => import('./PlanningEventDetailPage').then((module) => ({ default: module.PlanningEventDetailPage })));
const PlanningEventFormPage = lazy(() => import('./PlanningEventFormPage').then((module) => ({ default: module.PlanningEventFormPage })));

/** Lazy route boundary for the planning calendar. */
export function PlanningIndexScreen() {
  return <PlanningPermissionRoute><Suspense fallback={<StatePanel kind="loading" />}><PlanningPage /></Suspense></PlanningPermissionRoute>;
}

/** Lazy route boundary for a planning-event detail. */
export function PlanningDetailScreen() {
  return <PlanningPermissionRoute><Suspense fallback={<StatePanel kind="loading" />}><PlanningEventDetailPage /></Suspense></PlanningPermissionRoute>;
}

/** Lazy route boundary for creating an event. */
export function PlanningCreateScreen() {
  return <PlanningPermissionRoute><Suspense fallback={<StatePanel kind="loading" />}><PlanningEventFormPage mode="create" /></Suspense></PlanningPermissionRoute>;
}

/** Lazy route boundary for editing an event. */
export function PlanningEditScreen() {
  return <PlanningPermissionRoute><Suspense fallback={<StatePanel kind="loading" />}><PlanningEventFormPage mode="edit" /></Suspense></PlanningPermissionRoute>;
}
