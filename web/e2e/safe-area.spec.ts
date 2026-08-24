import { expect, test, type Page } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

interface ShellGeometry {
  financeLeft: number;
  mainLeft: number;
  mainPaddingRight: number;
  routeRight: number;
  sidebarWidth: number;
}

/**
 * Authenticates the stable acceptance-test administrator.
 *
 * @param page - Playwright page connected to the disposable full-stack fixture.
 * @returns A promise that resolves after the authenticated booking route is visible.
 * @throws When the fixture rejects the stable credentials or redirects elsewhere.
 */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill('admin@example.test');
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);
}

/**
 * Applies deterministic physical safe-area values to the authenticated shell.
 *
 * @param page - Playwright page containing the authenticated shell.
 * @param left - Physical left safe-area inset in CSS pixels.
 * @param right - Physical right safe-area inset in CSS pixels.
 * @returns A promise that resolves after both custom properties are applied.
 */
async function setSafeArea(page: Page, left: number, right: number): Promise<void> {
  await page.addStyleTag({
    content: `div[data-sidebar-collapsed] { --shell-safe-area-left: ${left}px !important; --shell-safe-area-right: ${right}px !important; }`,
  });
  const shell = page.locator('div[data-sidebar-collapsed]');
  await expect.poll(() => shell.evaluate((element) => getComputedStyle(element).getPropertyValue('--shell-safe-area-left').trim())).toBe(`${left}px`);
  await expect.poll(() => shell.evaluate((element) => getComputedStyle(element).getPropertyValue('--shell-safe-area-right').trim())).toBe(`${right}px`);
}

/**
 * Reads the physical bounds that must remain outside a display cutout.
 *
 * @param page - Playwright page showing the authenticated finance workspace.
 * @returns Navigation and route-content geometry in CSS pixels.
 * @throws When a required authenticated-shell element is missing.
 */
async function readShellGeometry(page: Page): Promise<ShellGeometry> {
  return page.locator('#desktop-sidebar').evaluate((sidebar) => {
    const finance = document.querySelector<HTMLElement>('a[href="/finance"]');
    const main = document.querySelector<HTMLElement>('#main-content');
    const route = main?.firstElementChild as HTMLElement | null;
    if (!finance || !main || !route) throw new Error('Authenticated shell geometry is incomplete.');
    return {
      financeLeft: finance.getBoundingClientRect().left,
      mainLeft: main.getBoundingClientRect().left,
      mainPaddingRight: Number.parseFloat(getComputedStyle(main).paddingRight),
      routeRight: route.getBoundingClientRect().right,
      sidebarWidth: sidebar.getBoundingClientRect().width,
    };
  });
}

test('physical safe areas protect navigation in landscape without changing portrait spacing', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'A single Chromium context covers the deterministic viewport matrix.');

  await page.setViewportSize({ width: 956, height: 440 });
  await login(page);
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'Finanzen' })).toBeVisible();
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);

  await setSafeArea(page, 59, 0);
  await expect.poll(async () => Math.round((await readShellGeometry(page)).sidebarWidth)).toBe(139);
  const leftCutout = await readShellGeometry(page);
  expect(leftCutout.sidebarWidth).toBeCloseTo(139);
  expect(leftCutout.financeLeft).toBeGreaterThanOrEqual(59);
  expect(leftCutout.mainLeft).toBeCloseTo(139);

  await setSafeArea(page, 0, 59);
  await expect.poll(async () => Math.round((await readShellGeometry(page)).sidebarWidth)).toBe(80);
  const rightCutout = await readShellGeometry(page);
  expect(rightCutout.sidebarWidth).toBeCloseTo(80);
  expect(rightCutout.mainPaddingRight).toBeCloseTo(59);
  expect(rightCutout.routeRight).toBeCloseTo(897);

  await page.setViewportSize({ width: 667, height: 375 });
  await setSafeArea(page, 44, 0);
  const mobileHeader = page.locator('div[data-sidebar-collapsed] > header');
  await expect(page.locator('#desktop-sidebar')).toBeHidden();
  await expect(page.locator('#main-content')).toHaveCSS('padding-left', '44px');
  await expect(mobileHeader).toHaveCSS('padding-left', '64px');
  await expect(page.getByRole('navigation', { name: 'Mobile Hauptnavigation' })).toHaveCSS('padding-left', '44px');

  await page.setViewportSize({ width: 440, height: 956 });
  await setSafeArea(page, 0, 0);
  await expect(page.locator('#main-content')).toHaveCSS('padding-left', '0px');
  await expect(page.locator('#main-content')).toHaveCSS('padding-right', '0px');
  await expect(mobileHeader).toHaveCSS('padding-left', '16px');
  await expect(mobileHeader).toHaveCSS('padding-right', '16px');
});
