import { expect, test } from '@playwright/test';
import QRCode from 'qrcode';

import { installCameraFixture } from './camera-fixture';

test.beforeEach(async ({ page }) => installCameraFixture(page));

test('external QR exposes checkout; stable camera stays open; background changes preserve the cart', async ({ page }) => {
  const checkout = page.getByRole('button', { name: 'Jetzt buchen', exact: true });
  await expect(checkout).toBeVisible();
  await expect(checkout).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath('external-checkout.png'), animations: 'disabled' });
  await expect(page.getByLabel('Anzahl von Wasser', { exact: true })).toHaveText('1');
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  // Deliberately wait through warmup to prove elapsed time alone cannot collapse.
  await page.waitForTimeout(2200);
  await expect(checkout).toBeVisible();
  await page.evaluate(() => window.paintScene());
  await page.waitForTimeout(1200);
  await expect(checkout).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('scene-change.png') });
  await expect.poll(() => page.evaluate(() => window.cameraState().starts)).toBe(1);
  await page.getByRole('dialog', { name: 'Scan & Go' }).getByRole('button', { name: 'Schließen', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => window.cameraState().active)).toBe(false);
});

test('real decoder suppresses the linked QR and accepts a following product behind the cart', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Jetzt buchen', exact: true })).toBeVisible();
  await paintProduct(page, 'product-water');
  await page.waitForTimeout(2200);
  await expect(page.getByLabel('Anzahl von Wasser', { exact: true })).toHaveText('1');
  await paintProduct(page, 'product-spezi');
  await expect(page.getByRole('status').filter({ hasText: 'Spezi' })).toBeVisible();
});

test('a server error keeps the expanded draft available', async ({ page }) => {
  await page.getByRole('button', { name: 'Jetzt buchen', exact: true }).click();
  await expect(page.getByText('Controlled server error')).toBeVisible();
  await expect(page.getByLabel('Anzahl von Wasser', { exact: true })).toHaveText('1');
  await expect(page.getByRole('dialog', { name: 'Scan & Go' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Jetzt buchen', exact: true })).toBeEnabled();
});

test('camera denial leaves the external product bookable', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { cameraDenied: true }));
  await page.goto('/__scan-harness');
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Jetzt buchen', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Anzahl von Wasser', { exact: true })).toHaveText('1');
});

/** Paints a genuine same-origin product QR into the visible scan region. */
async function paintProduct(page: import('@playwright/test').Page, product: string, placement: 'inside' | 'outside' = 'inside') {
  await expect(page.getByRole('dialog', { name: 'Scan & Go' })).toBeVisible();
  const group = new URL(page.url()).searchParams.get('group')!;
  const source = await QRCode.toDataURL(`http://127.0.0.1:5184/book?group=${group}&product=${product}&scan=1`, { width: 300, margin: 4 });
  await page.evaluate(({ source, placement }) => window.paintCode(source, placement), { source, placement });
}

/** Expands the mobile cart while keeping the same camera session. */
async function expandCart(page: import('@playwright/test').Page) {
  const peek = page.getByRole('button', { name: /^Warenkorb öffnen:/ });
  if (await peek.isVisible()) await peek.click();
}

test('background motion and orientation changes never repeat the latest product', async ({ page }) => {
  await paintProduct(page, 'product-water');
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.paintScene());
  await page.waitForTimeout(1800);
  await expect(page.getByLabel('Anzahl von Wasser', { exact: true })).toHaveText('1');
  await paintProduct(page, 'product-spezi');
  await expect(page.getByRole('status').filter({ hasText: 'Spezi' })).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(2300);
  await expect(page.getByLabel('Anzahl von Spezi', { exact: true })).toHaveText('1');
  expect(await page.evaluate(() => window.cameraState().starts)).toBe(1);
  await page.screenshot({ path: test.info().outputPath('landscape.png') });
});

test('codes outside the guide are ignored; removing and returning a code allows a deliberate repeat', async ({ page }) => {
  await paintProduct(page, 'product-spezi', 'outside');
  await page.waitForTimeout(2200);
  await expect(page.getByLabel('Anzahl von Spezi', { exact: true })).toHaveCount(0);
  await paintProduct(page, 'product-spezi');
  await expect(page.getByRole('status').filter({ hasText: 'Spezi' })).toBeVisible();
  // Let the cart resize settle and observe the same code before establishing absence.
  await page.waitForTimeout(1300);
  await page.evaluate(() => window.clearCode());
  await page.waitForTimeout(1500);
  await paintProduct(page, 'product-spezi');
  await page.waitForTimeout(1200);
  await expandCart(page);
  await expect(page.getByLabel('Anzahl von Spezi', { exact: true })).toHaveText('2');
});

test('cart price editing blocks scans and uses legible colors', async ({ page }) => {
  await paintProduct(page, 'product-kit');
  const input = page.getByRole('textbox', { name: 'Preis für Ausrüstung vergessen in EUR', exact: true });
  await expect(input).toBeFocused();
  await input.fill('2,50');
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Buchungen bestätigen', exact: true })).toBeInViewport({ ratio: 1 });
  const colors = await input.evaluate((element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
  expect(colors.color).not.toBe(colors.background);
  await paintProduct(page, 'product-spezi');
  await page.waitForTimeout(2000);
  await expect(input).toHaveValue('2,50');
  await expect(page.getByLabel('Anzahl von Spezi', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('price-edit.png') });
  await page.getByRole('dialog').getByText('Scan & Go', { exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Spezi' })).toBeVisible({ timeout: 6000 });
});

test('pending submission freezes the exact draft; success closes every camera track', async ({ page }) => {
  await page.evaluate(() => { window.bookingMode = 'pending'; });
  await page.getByRole('button', { name: 'Jetzt buchen', exact: true }).click();
  await paintProduct(page, 'product-spezi');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.submittedDraft?.items.map(({ productId, quantity }) => ({ productId, quantity })))).toEqual([{ productId: 'product-water', quantity: 1 }]);
  await expect(page.getByLabel('Anzahl von Wasser', { exact: true })).toHaveText('1');
  await expect(page.getByLabel('Anzahl von Spezi', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.finishBooking?.());
  await expect(page.getByRole('dialog', { name: 'Scan & Go' })).toHaveCount(0);
  expect(await page.evaluate(() => window.cameraState().active)).toBe(false);
});

test('camera errors and the unified guide stay unobscured by checkout', async ({ page }) => {
  await page.addInitScript(() => { window.cameraDenied = true; });
  await page.goto('/__scan-harness');
  const alert = page.getByRole('dialog').getByRole('alert');
  await expect(alert).toBeVisible();
  expect(await alert.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit === element || element.contains(hit);
  })).toBe(true);
  await expect(page.getByRole('dialog').getByText('QR-Code', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Barcode', { exact: true })).toBeVisible();
  const quantity = page.getByLabel('Anzahl von Wasser', { exact: true });
  expect(await quantity.evaluate((element) => getComputedStyle(element).color)).not.toBe('rgb(255, 255, 255)');
  await page.screenshot({ path: test.info().outputPath('camera-error.png'), animations: 'disabled' });
});

test('price entry and checkout remain visible when the mobile keyboard reduces the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await paintProduct(page, 'product-kit');
  const input = page.getByRole('textbox', { name: 'Preis für Ausrüstung vergessen in EUR', exact: true });
  await expect(input).toBeFocused();
  await input.fill('2,50');
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 400 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  const visible = await input.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 2);
    return { bottom: rect.bottom, top: rect.top, unobscured: hit === element || element.contains(hit) };
  });
  expect(visible.bottom).toBeLessThanOrEqual(400);
  expect(visible.unobscured).toBe(true);
  const checkout = page.getByRole('button', { name: 'Buchungen bestätigen', exact: true });
  expect(await checkout.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(400);
  await page.screenshot({ path: test.info().outputPath('keyboard-viewport.png') });
});
