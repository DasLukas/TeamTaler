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
    let viewportHeight: number | undefined;
    let viewportOffsetTop = 0;
    const events = new EventTarget();
    const visualViewport = {
      addEventListener: events.addEventListener.bind(events),
      get height() { return viewportHeight ?? window.innerHeight; },
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
 * Updates the deterministic Visual Viewport and emits its matching browser event.
 *
 * @param page - Playwright page initialized by {@link installControllableVisualViewport}.
 * @param height - New visible viewport height in CSS pixels.
 * @param offsetTop - Optional iOS-style viewport scroll offset.
 * @returns A promise that resolves after listeners process the viewport event.
 */
async function setVisualViewport(page: Page, height: number, offsetTop = 0): Promise<void> {
  await page.evaluate(({ nextHeight, nextOffsetTop }) => {
    (window as typeof window & { __setTestVisualViewport: (height: number, offsetTop?: number) => void })
      .__setTestVisualViewport(nextHeight, nextOffsetTop);
  }, { nextHeight: height, nextOffsetTop: offsetTop });
}

/** Authenticates the stable administrator against the disposable full-stack fixture. */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill('admin@example.test');
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);
}

/** Opens the editable group-name field after authenticating the stable administrator. */
async function openGroupSettings(page: Page): Promise<void> {
  await login(page);
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

  await setVisualViewport(page, stableViewportHeight - 320);
  await expect(shell).toHaveAttribute('data-software-keyboard-visible', 'true');
  await expect(bottomNavigation).toBeHidden();
  await expect(main).toHaveCSS('padding-bottom', '0px');

  await setVisualViewport(page, stableViewportHeight - 320, 240);
  await expect(shell).toHaveAttribute('data-software-keyboard-visible', 'true');
  await expect(bottomNavigation).toBeHidden();

  await setVisualViewport(page, stableViewportHeight);
  await expect(shell).not.toHaveAttribute('data-software-keyboard-visible');
  await expect(bottomNavigation).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('shared bottom sheets keep persistent actions above the keyboard while the visual viewport scrolls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'narrow-mobile', 'Bottom sheets use compact geometry only in the mobile project.');
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await installControllableVisualViewport(page);
  await login(page);
  await page.goto('/planning/new?date=2026-09-09');
  await expect(page.getByRole('heading', { name: 'Termin erstellen' })).toBeVisible();

  const recurrence = page.getByRole('combobox', { name: 'Wiederholung' });
  await recurrence.scrollIntoViewIfNeeded();
  await recurrence.click();
  await recurrence.press('End');
  await expect(recurrence).toHaveAttribute('aria-activedescendant', /-6$/);
  await recurrence.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Wiederholung anpassen' });
  const interval = sheet.getByRole('spinbutton', { name: 'Intervall' });
  const apply = sheet.getByRole('button', { name: 'Wiederholung übernehmen' });
  await expect(sheet).toBeVisible();
  await sheet.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  await interval.focus();
  const stableViewportHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
  const keyboardTop = stableViewportHeight - 320;

  await setVisualViewport(page, keyboardTop);
  await expect(sheet).toHaveCSS('--modal-visual-viewport-bottom', '320px');
  await expect(sheet).toHaveCSS('--modal-visual-viewport-height', `${keyboardTop}px`);
  await expect(apply).toBeInViewport();
  const sheetBottomBeforeScroll = await sheet.evaluate((element) => element.getBoundingClientRect().bottom);
  expect(sheetBottomBeforeScroll).toBeCloseTo(keyboardTop, 0);

  await setVisualViewport(page, keyboardTop, 240);
  await expect(sheet).toHaveCSS('--modal-visual-viewport-bottom', '320px');
  await expect(apply).toBeInViewport();
  const sheetBottomAfterScroll = await sheet.evaluate((element) => element.getBoundingClientRect().bottom);
  expect(sheetBottomAfterScroll).toBeCloseTo(keyboardTop, 0);
  expect(consoleErrors).toEqual([]);
});

test('the custom booking-cart sheet releases the hidden navigation offset for text entry', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'narrow-mobile', 'The custom cart sheet is rendered only in the mobile project.');
  await installControllableVisualViewport(page);
  await login(page);
  await page.getByRole('combobox', { name: 'Gruppe auswählen' }).click();
  await page.getByRole('option', { name: 'TSV Sonnenberg' }).click();

  const categoryTabs = page.getByRole('tab');
  let userDefinedProduct = page.getByRole('button', { name: /Preis wählen.*zum Warenkorb hinzufügen/i }).first();
  for (let index = 0; index < await categoryTabs.count() && !await userDefinedProduct.isVisible().catch(() => false); index += 1) {
    await categoryTabs.nth(index).click();
    userDefinedProduct = page.getByRole('button', { name: /Preis wählen.*zum Warenkorb hinzufügen/i }).first();
  }
  await expect(userDefinedProduct).toBeVisible();
  await userDefinedProduct.click();

  const cartSheet = page.getByRole('complementary', { name: 'Warenkorb' });
  const priceInput = cartSheet.locator('input[inputmode="decimal"]');
  await expect(priceInput).toBeFocused();
  const stableViewportHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
  await setVisualViewport(page, stableViewportHeight - 320, 180);

  await expect(page.locator('div[data-sidebar-collapsed]')).toHaveAttribute('data-software-keyboard-visible', 'true');
  await expect(cartSheet).toHaveCSS('bottom', '0px');
  await expect(page.getByRole('navigation', { name: 'Mobile Hauptnavigation' })).toBeHidden();
});
