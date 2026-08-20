import { expect, test, type Page } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

/** Authenticates the stable acceptance-test administrator. */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill('admin@example.test');
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);
}

/** Makes the existing miscellaneous payment method require one receipt. */
async function requireReceiptForMiscellaneousPayments(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Allgemein' }).click();
  const mode = page.getByRole('combobox', { name: 'Beleg-Upload: Sonstige' });
  await expect(mode).toBeVisible();
  await mode.selectOption({ label: 'Verpflichtend' });
  const save = page.getByRole('button', { name: 'Einstellungen speichern' });
  if (await save.isEnabled()) {
    const response = page.waitForResponse((candidate) => candidate.request().method() === 'PATCH'
      && /\/groups\/[^/]+\/settings$/.test(new URL(candidate.url()).pathname));
    await save.click();
    expect((await response).status()).toBe(200);
  }
}

test('required receipt scan creates a protected payment attachment on desktop and mobile', async ({ page }, testInfo) => {
  await login(page);
  await requireReceiptForMiscellaneousPayments(page);

  await page.goto('/account');
  await page.getByRole('button', { name: 'Zahlung erfassen' }).click();
  await page.getByRole('combobox', { name: 'Zahlungsart' }).selectOption({ label: 'Sonstige' });
  await expect(page.getByRole('group', { name: 'Beleg *' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zahlung prüfen' })).toBeDisabled();

  await page.getByRole('button', { name: 'Beleg scannen' }).click();
  let scanner = page.getByRole('dialog', { name: 'Dokument scannen' });
  await expect(scanner).toBeVisible();
  await expect(scanner.getByRole('button', { name: 'Dialog schließen' })).toHaveCount(0);
  await expect(scanner.getByRole('navigation', { name: 'Seitenquellen' })).toHaveCount(0);
  const geometry = await scanner.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { height: bounds.height, left: bounds.left, top: bounds.top, width: bounds.width };
  });
  if (testInfo.project.name === 'narrow-mobile') {
    expect(geometry).toEqual({ height: 844, left: 0, top: 0, width: 390 });
  } else {
    expect(geometry.width).toBeLessThan(1440);
    expect(geometry.height).toBeLessThan(1000);
    expect(geometry.left).toBeGreaterThan(0);
    expect(geometry.top).toBeGreaterThan(0);
  }

  await scanner.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(scanner).toHaveCount(0);
  const paymentDialogAfterCancel = page.getByRole('dialog', { name: 'Eigene Zahlung erfassen' });
  await expect(paymentDialogAfterCancel).toBeVisible();
  await expect(paymentDialogAfterCancel.getByRole('button', { name: 'Beleg scannen' })).toBeFocused();

  await paymentDialogAfterCancel.getByRole('button', { name: 'Beleg scannen' }).click();
  scanner = page.getByRole('dialog', { name: 'Dokument scannen' });
  const capture = scanner.getByRole('button', { name: 'Seite aufnehmen' });
  await expect(capture).toBeEnabled({ timeout: 15_000 });
  await capture.click();
  await expect(scanner.getByText('1 von 20 Seiten')).toBeHidden();
  await scanner.getByRole('button', { name: 'Seite 1' }).click();
  await expect(scanner.getByRole('region', { name: 'Seiteneditor' })).toBeVisible();
  await expect(scanner.getByRole('button', { name: 'Weitere Seite scannen' })).toBeVisible();
  await scanner.getByRole('button', { name: 'Dokument verwenden' }).click();

  const paymentDialog = page.getByRole('dialog', { name: 'Eigene Zahlung erfassen' });
  await expect(paymentDialog.getByText(/document-scan-.*\.pdf/)).toBeVisible();
  await paymentDialog.getByRole('textbox', { name: 'Betrag in EUR' }).fill('1,00');
  await paymentDialog.getByRole('combobox', { name: 'Begründung *' }).fill(`E2E receipt ${testInfo.project.name}`);
  await paymentDialog.getByRole('button', { name: 'Zahlung prüfen' }).click();

  const createResponse = page.waitForResponse((candidate) => candidate.request().method() === 'POST'
    && /\/groups\/[^/]+\/payments\/self$/.test(new URL(candidate.url()).pathname));
  await page.getByRole('dialog', { name: 'Zahlung prüfen' }).getByRole('button', { name: /als Zahlung buchen/ }).click();
  expect((await createResponse).status()).toBe(201);
  await page.getByRole('dialog', { name: 'Zahlung gebucht' }).getByRole('button', { name: 'Fertig' }).click();

  const receiptResponse = page.waitForResponse((candidate) => candidate.request().method() === 'GET'
    && /\/groups\/[^/]+\/payments\/[^/]+\/attachment$/.test(new URL(candidate.url()).pathname));
  await page.getByRole('button', { name: 'Beleg' }).first().click();
  const protectedReceipt = await receiptResponse;
  expect(protectedReceipt.status()).toBe(200);
  expect(protectedReceipt.headers()['content-type']).toBe('application/pdf');
  expect(protectedReceipt.headers()['cache-control']).toBe('private, no-store');
});
