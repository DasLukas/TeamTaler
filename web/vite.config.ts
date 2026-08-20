import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const developmentDemoEnabled = process.env.VITE_DEMO_MODE === 'true';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Lazy feature chunks import individual Lucide icon modules. Pre-bundle
    // their complete dependency frontier once so first use cannot invalidate
    // an in-flight scanner import or reload a document that is being edited.
    include: ['@opencvjs/web', 'pdf-lib', 'lucide-react/dist/esm/icons/**'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: developmentDemoEnabled ? undefined : {
      '/api': 'http://127.0.0.1:8080',
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    testTimeout: 10_000,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
