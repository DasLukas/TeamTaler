import { lazy, Suspense } from 'react';
import { StatePanel } from '@/components/ui/StatePanel';

const ImprintPage = lazy(() => import('./LegalDocumentPage').then((module) => ({ default: module.ImprintPage })));
const PrivacyPolicyPage = lazy(() => import('./LegalDocumentPage').then((module) => ({ default: module.PrivacyPolicyPage })));

/** Renders the lazily loaded public imprint page. */
export function ImprintRoutePage() {
  return <Suspense fallback={<StatePanel kind="loading" />}><ImprintPage /></Suspense>;
}

/** Renders the lazily loaded public privacy-policy page. */
export function PrivacyPolicyRoutePage() {
  return <Suspense fallback={<StatePanel kind="loading" />}><PrivacyPolicyPage /></Suspense>;
}
