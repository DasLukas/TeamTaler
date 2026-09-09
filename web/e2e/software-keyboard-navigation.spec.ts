import { expect, test, type Page } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

/**
 * Installs a deterministic Visual Viewport before application code runs.
 *
 * @param page - Playwright page that has not navigated to the application yet.
 * @returns A promise that resolves after the browser initializer is registered.
 */
async function installControllableVisualViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let viewportHeight = window.innerHeight;
    let viewportOffsetTop = 0;
    const events = new EventTarget();
    const visualViewport = {
      addEventListener: events.addEventListener.bind(events),
      get height() { return viewportHeight; },
      get offsetTop() { return viewportOffsetTop; },
      removeEventListener: events.removeEventListener.bind(events),
    };

    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    Object.defineProperty(window, '__setTestVisualViewport', {
      configurable: true,
      value: (height: number, offsetTop = 0) => {
        viewportHeight = height;
        viewportOffsetTop = offsetTop;
        events.dispatchEvent(new Event(offsetTop > 0 ? 'scroll' : 'resize'));
      },
    });
  });
}

/**
 * Authenticates the stable administrator and opens group settings.
 *
 * @param page - Playwright page connected to the disposable full-stack fixture.
 * @returns A promise that resolves when the editable group-name field is visible.
 */
async function openGroupSettings(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill('admin@example.test');
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);
  await page.goto('/admin?tab=settings');
  await expect(page.getByLabel('Name der Gruppe')).toBeVisible();
}

test('software keyboard keeps mobile bottom navigation hidden while the visual viewport scrolls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'narrow-mobile', 'The compact navigation is rendered only in the mobile project.');
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await installControllableVisualViewport(page);
  await openGroupSettings(page);

  const groupName = page.getByLabel('Name der Gruppe');
  const shell = page.locator('div[data-sidebar-collapsed]');
  const main = page.locator('#main-content');
  const bottomNavigation = page.getByRole('navigation', { name: 'Mobile Hauptnavigation' });
  await groupName.focus();
  await expect(bottomNavigation).toBeVisible();
  const stableViewportHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);

  await page.evaluate((height) => {
    (window as typeof window & { __setTestVisualViewport: (height: number, offsetTop?: number) => void })
      .__setTestVisualViewport(height);
  }, stableViewportHeight - 320);
  await expect(shell).toHaveAttribute('data-software-keyboard-visible', 'true');
  await expect(bottomNavigation).toBeHidden();
  await expect(main).toHaveCSS('padding-bottom', '0px');

  await page.evaluate((height) => {
    (window as typeof window & { __setTestVisualViewport: (height: number, offsetTop?: number) => void })
      .__setTestVisualViewport(height, 240);
  }, stableViewportHeight - 320);
  await expect(shell).toHaveAttribute('data-software-keyboard-visible', 'true');
  await expect(bottomNavigation).toBeHidden();

  await page.evaluate((height) => {
    (window as typeof window & { __setTestVisualViewport: (height: number, offsetTop?: number) => void })
      .__setTestVisualViewport(height);
  }, stableViewportHeight);
  await expect(shell).not.toHaveAttribute('data-software-keyboard-visible');
  await expect(bottomNavigation).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
