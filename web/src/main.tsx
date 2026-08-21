import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import { registerWebPushServiceWorker, supportsWebPush } from '@/features/push/webPush';
import '@/i18n';
import '@/styles/global.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found.');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (supportsWebPush()) void registerWebPushServiceWorker().catch(() => undefined);
