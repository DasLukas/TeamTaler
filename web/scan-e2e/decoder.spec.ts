import { readFile, readdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { barcodeKey } from '../src/features/bookings/kioskScan';
import type { ProductBarcodeFormat } from '../src/api/types';

// Exercise the actual built worker with the same policies returned by the Go server.
test('production worker reads six formats at 48 angles under isolated CSP', async ({ page }) => {
  test.setTimeout(60_000);
  const server = await readFile('../internal/httpapi/server.go', 'utf8');
  const workerPolicy = server.match(/const barcodeWorkerCSP = "([^"]+)"/)![1];
  const documentPolicy = server.match(/Set\("Content-Security-Policy", "([^"]+)"/)![1];
  const files = await readdir('dist/assets');
  const workerName = files.find((file) => /^barcodeScanner\.worker-.*\.js$/.test(file));
  expect(workerName, 'Run npm run build before test:scan').toBeTruthy();
  await page.route('**/assets/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    if (!files.includes(name)) return route.abort();
    return route.fulfill({
      body: await readFile(`dist/assets/${name}`),
      contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      headers: { 'Content-Security-Policy': name === workerName ? workerPolicy : documentPolicy },
    });
  });
  await page.route('**/__decoder', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Decoder verification</title>', headers: { 'Content-Security-Policy': documentPolicy } }));
  await page.goto('/__decoder');
  const results = await page.evaluate(async (workerName) => {
    const bwip = await import('/node_modules/' + '@bwip-js/browser/dist/bwip-js.mjs');
    const worker = new Worker(`/assets/${workerName}`, { type: 'module' });
    const exchange = (request: object) => new Promise<{ type: string; codes?: { value: string; format: string }[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker timed out')), 10_000);
      worker.onerror = () => { clearTimeout(timer); reject(new Error('Worker failed')); };
      worker.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
      worker.postMessage(request);
    });
    try {
      const ready = await exchange({ type: 'initialize' });
      if (ready.type !== 'ready') throw new Error('Decoder did not initialize under production CSP');
      const fixtures = [
        ['qrcode', 'https://teamtaler.test/book?group=group-one&product=water&scan=1', 'QR_CODE'],
        ['ean13', '4006381333931', 'EAN_13'], ['ean8', '96385074', 'EAN_8'],
        ['upca', '036000291452', 'UPC_A'], ['upce', '01234565', 'UPC_E'], ['code128', 'TEAMTALER-128', 'CODE_128'],
      ];
      const results = [];
      for (const [bcid, value, format] of fixtures) {
        const symbol = document.createElement('canvas');
        bwip.toCanvas(symbol, { bcid, text: value, scale: 2, ...(bcid === 'qrcode' ? {} : { height: 16 }), includetext: false, padding: 12, backgroundcolor: 'FFFFFF' });
        for (let angle = 0; angle < 360; angle += 7.5) {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 640;
          const context = canvas.getContext('2d')!;
          context.fillStyle = '#fff'; context.fillRect(0, 0, 640, 640);
          context.translate(320, 320); context.rotate(angle * Math.PI / 180);
          context.drawImage(symbol, -symbol.width / 2, -symbol.height / 2);
          const pixels = context.getImageData(0, 0, 640, 640).data.buffer;
          const response = await exchange({ type: 'decode', id: results.length, pixels, width: 640, height: 640, barcodeOnly: false });
          results.push({ format, value, angle, codes: response.codes, type: response.type });
        }
      }
      const blank = new Uint8ClampedArray(640 * 640 * 4).fill(255);
      const empty = await exchange({ type: 'decode', id: 999, pixels: blank.buffer, width: 640, height: 640, barcodeOnly: false });
      results.push({ format: 'BLANK', value: '', angle: 0, codes: empty.codes, type: empty.type });
      for (const barcodeOnly of [false, true]) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 640;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#fff'; context.fillRect(0, 0, 640, 640);
        const qr = document.createElement('canvas');
        bwip.toCanvas(qr, { bcid: 'qrcode', text: 'FIRST-CODE', scale: 3, padding: 12, backgroundcolor: 'FFFFFF' });
        context.drawImage(qr, 220, 30);
        if (!barcodeOnly) {
          const linear = document.createElement('canvas');
          bwip.toCanvas(linear, { bcid: 'code128', text: 'SECOND-CODE', scale: 2, height: 16, padding: 12, backgroundcolor: 'FFFFFF' });
          context.translate(320, 440); context.rotate(Math.PI / 6);
          context.drawImage(linear, -linear.width / 2, -linear.height / 2);
        }
        const response = await exchange({ type: 'decode', id: 1000, pixels: context.getImageData(0, 0, 640, 640).data.buffer, width: 640, height: 640, barcodeOnly });
        results.push({ format: barcodeOnly ? 'BLANK' : 'MULTI', value: '', angle: 0, codes: response.codes, type: response.type });
      }
      return results;
    } finally { worker.terminate(); }
  }, workerName!);
  const matrixPath = test.info().outputPath('orientation-matrix.json');
  await writeFile(matrixPath, JSON.stringify(results, null, 2));
  await test.info().attach('orientation-matrix.json', { path: matrixPath, contentType: 'application/json' });
  const failures = results.filter((result) => {
    if (result.type !== 'result') return true;
    if (result.format === 'MULTI') return result.codes?.length !== 2 || !result.codes.some((code) => code.value === 'FIRST-CODE') || !result.codes.some((code) => code.value === 'SECOND-CODE');
    if (result.format === 'BLANK') return result.codes?.length !== 0;
    if (result.codes?.length !== 1) return true;
    const actual = result.codes[0];
    if (result.format === 'QR_CODE') return actual.value !== result.value || actual.format !== result.format;
    return barcodeKey(actual.format as ProductBarcodeFormat, actual.value) !== barcodeKey(result.format as ProductBarcodeFormat, result.value);
  });
  expect(failures).toEqual([]);
});
