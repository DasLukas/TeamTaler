import { expect, type Locator, type Page, test } from '@playwright/test';

const password = 'TeamTaler-Test-2026!';

/** Verifies that an external-account modal stays usable within a narrow viewport. */
async function expectResponsiveExternalAccountDialog(page: Page, dialog: Locator) {
  const viewport = page.viewportSize();
  if (!viewport || viewport.width > 600) return;

  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

  const form = dialog.locator('form');
  await expect(form).toHaveCSS('padding-left', '20px');
  await expect(form).toHaveCSS('padding-right', '20px');
  const footerButtons = dialog.locator('footer button');
  await expect(footerButtons).toHaveCount(2);
  await expect(footerButtons.first()).toBeInViewport();
  await expect(footerButtons.last()).toBeInViewport();
  const firstButtonBox = await footerButtons.first().boundingBox();
  const lastButtonBox = await footerButtons.last().boundingBox();
  expect(firstButtonBox).not.toBeNull();
  expect(lastButtonBox).not.toBeNull();
  expect(firstButtonBox!.width).toBeGreaterThanOrEqual(viewport.width - 40);
  expect(lastButtonBox!.width).toBeGreaterThanOrEqual(viewport.width - 40);
  expect(firstButtonBox!.y).not.toBe(lastButtonBox!.y);
}

/** Creates an external cash account through the reviewed account dialog. */
async function createCashAccount(page: Page, name: string, opening?: { amount: string; reason: string }) {
  await page.goto('/admin?tab=settings');
  const financeSettings = page.getByRole('region', { name: 'Finanzen' });
  await financeSettings.getByRole('button', { name: 'Konto anlegen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Konto anlegen' });
  await expectResponsiveExternalAccountDialog(page, dialog);
  await dialog.getByLabel('Kontoname').fill(name);
  if (opening) {
    await dialog.getByLabel('Betrag (EUR)').fill(opening.amount);
    await dialog.getByLabel('Kurzbegründung').fill(opening.reason);
  }
  await dialog.getByRole('button', { name: 'Prüfen' }).click();
  const response = page.waitForResponse((candidate) => candidate.request().method() === 'POST'
    && /\/external-accounts$/.test(new URL(candidate.url()).pathname));
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  expect((await response).status()).toBe(201);
  await expect(dialog).toBeHidden();
  await page.goto('/finance?tab=external-accounts');
  await expect(page.getByLabel('Aktive Konten').getByText(name, { exact: true })).toBeVisible();
}

/** Returns the table row or responsive card containing one uniquely named transaction. */
function transactionItem(page: Page, reason: string): Locator {
  return page.getByText(reason, { exact: true }).locator('xpath=ancestor::tr[1] | ancestor::article[1]');
}

/** Chooses one option from a shared custom single-value dropdown. */
async function selectCustomOption(scope: Locator, comboboxName: string, optionName: string) {
  await scope.getByRole('combobox', { name: comboboxName }).click();
  await scope.getByRole('option', { name: optionName, exact: true }).click();
}

test('administrator completes the external-account full-stack lifecycle', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${testInfo.retry}`;
  const primaryAccount = `E2E cash ${suffix}`;
  const transferAccount = `E2E transfer ${suffix}`;
  const openingReason = `E2E opening ${suffix}`;
  const paymentReason = `E2E payment ${suffix}`;
  const paymentHistoryReason = `Payment received: ${paymentReason}`;
  const transferReason = `E2E transfer flow ${suffix}`;
  const newTransferReason = `E2E new transfer ${suffix}`;
  const reversalReason = `E2E reversal ${suffix}`;

  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill('admin@example.test');
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/book$/);

  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Allgemein' }).click();
  const featureToggle = page.getByRole('switch', { name: 'Externe Konten für diese Gruppe aktivieren' });
  await expect(featureToggle).toBeVisible();
  if (!(await featureToggle.isChecked())) {
    const enabled = page.waitForResponse((response) => response.request().method() === 'PATCH' && /\/groups\/[^/]+\/settings$/.test(new URL(response.url()).pathname));
    await featureToggle.click();
    expect((await enabled).status()).toBe(200);
  }
  await expect(featureToggle).toBeChecked();

  await page.goto('/finance?tab=external-accounts');
  await expect(page.getByRole('tab', { name: 'Externe Konten' })).toBeVisible();
  await createCashAccount(page, primaryAccount, { amount: '25,00', reason: openingReason });

  await page.goto('/admin?tab=settings');
  const financeSettings = page.getByRole('region', { name: 'Finanzen' });
  const primaryAccountRow = financeSettings.getByRole('listitem').filter({ hasText: primaryAccount });
  await primaryAccountRow.getByRole('button', { name: 'Bearbeiten' }).click();
  const accountDialog = page.getByRole('dialog', { name: 'Konto bearbeiten' });
  await expectResponsiveExternalAccountDialog(page, accountDialog);
  await accountDialog.getByRole('button', { name: 'Verknüpfte Zahlungsarten' }).click();
  const paymentMethodMenu = accountDialog.getByRole('dialog', { name: 'Verknüpfte Zahlungsarten' });
  const unlinkedPaymentMethod = paymentMethodMenu.getByRole('checkbox', { checked: false }).first();
  const paymentMethodLabel = await unlinkedPaymentMethod.evaluate((element) => (element as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? '');
  expect(paymentMethodLabel, 'The test data must expose at least one payment method').not.toBe('');
  await unlinkedPaymentMethod.check();
  await page.keyboard.press('Escape');
  await accountDialog.getByRole('button', { name: 'Prüfen' }).click();
  const linked = page.waitForResponse((response) => response.request().method() === 'PUT'
    && /\/external-account-links$/.test(new URL(response.url()).pathname));
  await accountDialog.getByRole('button', { name: 'Speichern' }).click();
  expect((await linked).status()).toBe(200);
  await expect(accountDialog).toBeHidden();
  await page.goto('/finance?tab=external-accounts');
  await expect(page.getByLabel('Aktive Konten').getByText(paymentMethodLabel, { exact: true })).toBeVisible();

  await page.goto('/account');
  await page.getByRole('button', { name: 'Zahlung erfassen' }).first().click();
  const paymentDialog = page.getByRole('dialog', { name: 'Eigene Zahlung erfassen' });
  await paymentDialog.getByRole('textbox', { name: 'Betrag in EUR' }).fill('7,00');
  await selectCustomOption(paymentDialog, 'Zahlungsart', paymentMethodLabel);
  await paymentDialog.getByLabel(/^Begründung/).fill(paymentReason);
  const requiredReceipt = paymentDialog.getByRole('group', { name: 'Beleg *' });
  if (await requiredReceipt.isVisible().catch(() => false)) {
    await requiredReceipt.locator('input[type="file"]').last().setInputFiles({
      name: 'external-account-payment.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    });
  }
  await paymentDialog.getByRole('button', { name: 'Zahlung prüfen' }).click();
  const paymentResponse = page.waitForResponse((candidate) => candidate.request().method() === 'POST'
    && /\/groups\/[^/]+\/payments\/self$/.test(new URL(candidate.url()).pathname));
  await page.getByRole('dialog', { name: 'Zahlung prüfen' }).getByRole('button', { name: /als Zahlung buchen/ }).click();
  expect((await paymentResponse).status()).toBe(201);
  await page.getByRole('dialog', { name: 'Zahlung gebucht' }).getByRole('button', { name: 'Fertig' }).click();

  await page.goto('/finance?tab=external-accounts');
  const paymentItem = transactionItem(page, paymentHistoryReason);
  await expect(paymentItem).toBeVisible();
  await expect(paymentItem.getByText('Zahlung', { exact: true })).toBeVisible();
  await paymentItem.getByRole('link', { name: 'Zahlung öffnen' }).click();
  await expect(page).toHaveURL(/tab=payments&paymentId=/);
  await expect(page.locator('[data-highlighted="true"][data-data-table-row-id]')).toBeVisible();
  await expect(page.locator('[data-highlighted="true"][data-data-table-row-id]')).toContainText(paymentReason);

  await page.goto('/finance?tab=external-accounts');

  await createCashAccount(page, transferAccount);
  await page.getByRole('button', { name: 'Finanzfluss erfassen' }).click();
  const transferDialog = page.getByRole('dialog', { name: 'Finanzfluss erfassen' });
  await expectResponsiveExternalAccountDialog(page, transferDialog);
  await selectCustomOption(transferDialog, 'Vorgang', 'Umbuchung');
  await selectCustomOption(transferDialog, 'Quellkonto', primaryAccount);
  await selectCustomOption(transferDialog, 'Zielkonto', transferAccount);
  await transferDialog.getByLabel('Betrag (EUR)').fill('4,00');
  await transferDialog.getByLabel('Kurzbegründung').fill(transferReason);
  await transferDialog.getByRole('button', { name: 'Prüfen' }).click();
  const transferResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && /\/external-account-transactions$/.test(new URL(response.url()).pathname));
  await transferDialog.getByRole('button', { name: 'Speichern' }).click();
  expect((await transferResponse).status()).toBe(201);
  const transferItem = transactionItem(page, transferReason);
  await expect(transferItem).toBeVisible();
  await expect(transferItem.getByText('Umbuchung', { exact: true })).toBeVisible();

  await expect(transferItem.getByRole('button', { name: 'Korrigieren' })).toHaveCount(0);
  await transferItem.getByRole('button', { name: 'Stornieren' }).click();
  const reversalDialog = page.getByRole('dialog', { name: 'Kontobuchung stornieren' });
  await expectResponsiveExternalAccountDialog(page, reversalDialog);
  await reversalDialog.getByLabel('Stornierungsgrund').fill(reversalReason);
  const reversalResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
    && /\/external-account-transactions\/[^/]+\/reverse$/.test(new URL(response.url()).pathname));
  await reversalDialog.getByRole('button', { name: 'Stornierung bestätigen' }).click();
  const reversalResponse = await reversalResponsePromise;
  expect(reversalResponse.status()).toBe(201);
  expect(await reversalResponse.json()).toMatchObject({ kind: 'REVERSAL', reason: reversalReason });
  await expect(transactionItem(page, reversalReason)).toBeVisible();

  await page.getByRole('button', { name: 'Finanzfluss erfassen' }).click();
  const newTransferDialog = page.getByRole('dialog', { name: 'Finanzfluss erfassen' });
  await selectCustomOption(newTransferDialog, 'Vorgang', 'Umbuchung');
  await selectCustomOption(newTransferDialog, 'Quellkonto', primaryAccount);
  await selectCustomOption(newTransferDialog, 'Zielkonto', transferAccount);
  await newTransferDialog.getByLabel('Betrag (EUR)').fill('5,00');
  await newTransferDialog.getByLabel('Kurzbegründung').fill(newTransferReason);
  await newTransferDialog.getByRole('button', { name: 'Prüfen' }).click();
  const newTransferResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && /\/external-account-transactions$/.test(new URL(response.url()).pathname));
  await newTransferDialog.getByRole('button', { name: 'Speichern' }).click();
  expect((await newTransferResponse).status()).toBe(201);
  await expect(transactionItem(page, newTransferReason)).toBeVisible();

  await page.getByRole('button', { name: 'Exportieren' }).click();
  const exportDialog = page.getByRole('dialog', { name: /Kontobuchungen exportieren/ });
  const exportResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
    && /\/groups\/[^/]+\/table-exports$/.test(new URL(response.url()).pathname));
  await exportDialog.getByRole('button', { name: 'Als CSV herunterladen' }).click();
  const exportResponse = await exportResponsePromise;
  expect(exportResponse.status()).toBe(200);
  expect(exportResponse.request().postDataJSON()).toMatchObject({ format: 'CSV', table: 'EXTERNAL_ACCOUNT_TRANSACTIONS' });
  expect(exportResponse.headers()['content-type']).toContain('text/csv');
});
