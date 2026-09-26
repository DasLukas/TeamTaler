import type { Page } from '@playwright/test';

declare global { interface Window {
  cameraDenied?: boolean;
  cameraState: () => { starts: number; active: boolean };
  paintScene: () => void;
  paintCode: (source: string, placement?: 'inside' | 'outside') => Promise<void>;
  clearCode: () => void;
} }

/** Installs a deterministic camera stream and an isolated real BookingPage harness. */
export async function installCameraFixture(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => route.abort());
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext('2d')!;
    let picture: HTMLImageElement | undefined;
    let outside = false;
    let stripes = false;
    let starts = 0;
    const streams: MediaStream[] = [];
    const paint = () => {
      context.fillStyle = '#888';
      context.fillRect(0, 0, 640, 480);
      if (stripes) for (let x = 0; x < 640; x += 80) {
        context.fillStyle = x % 160 ? '#eee' : '#111';
        context.fillRect(x, 0, 80, 480);
      }
      if (!picture) return;
      if (outside) { context.drawImage(picture, 0, 160, 120, 120); return; }
      const video = document.querySelector('video')?.getBoundingClientRect();
      const region = document.querySelector('[data-scan-region]')?.getBoundingClientRect();
      if (!video || !region) return;
      const scale = Math.max(video.width / 640, video.height / 480);
      const side = Math.min(region.width, region.height) / scale * .88;
      const x = (region.x + region.width / 2 - video.x + (640 * scale - video.width) / 2) / scale;
      const y = (region.y + region.height / 2 - video.y + (480 * scale - video.height) / 2) / scale;
      context.drawImage(picture, x - side / 2, y - side / 2, side, side);
    };
    window.setInterval(paint, 80);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      if (window.cameraDenied) throw new DOMException('Permission denied', 'NotAllowedError');
      starts += 1;
      const stream = canvas.captureStream(12);
      streams.push(stream);
      return stream;
    } });
    Object.assign(window, {
      cameraState: () => ({ starts, active: streams.some((stream) => stream.active) }),
      paintScene: () => { stripes = !stripes; paint(); },
      clearCode: () => { picture = undefined; paint(); },
      paintCode: async (source: string, placement = 'inside') => {
        const image = new Image();
        image.src = source;
        await image.decode();
        picture = image;
        outside = placement === 'outside';
        paint();
      },
    });
  });
  await page.route('**/__scan-harness*', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    await import('/scan-e2e/harness.tsx');
  </script></body></html>` }));
  await page.goto('/__scan-harness');
}
