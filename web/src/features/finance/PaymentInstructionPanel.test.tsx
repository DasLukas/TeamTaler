import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { PaymentInstructionPanel } from './PaymentInstructionPanel';

describe('PaymentInstructionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('keeps a PayPal.Me destination inactive until a valid amount is available', async () => {
    const user = userEvent.setup();
    const target = { type: 'PAYPAL_ME' as const, paypalMeHandle: 'TeamTaler42' };
    const view = render(<PaymentInstructionPanel amount={null} paymentTarget={target} reference="" />);

    const inactive = screen.getByText(i18n.t('paymentInstructions.openPaypal')).closest('a');
    expect(inactive).not.toHaveAttribute('href');
    expect(inactive).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: i18n.t('paymentInstructions.copyField', { field: i18n.t('paymentInstructions.paypalLink') }) })).toBeDisabled();

    view.rerender(<PaymentInstructionPanel amount={{ minorUnits: '1250', currency: 'EUR' }} paymentTarget={target} reference="" />);
    expect(screen.getByText(i18n.t('paymentInstructions.openPaypal')).closest('a')).toHaveAttribute('href', 'https://paypal.me/TeamTaler42/12.50EUR');
    await user.click(screen.getByRole('button', { name: i18n.t('paymentInstructions.copyField', { field: i18n.t('paymentInstructions.paypalLink') }) }));
    expect(await navigator.clipboard.readText()).toBe('https://paypal.me/TeamTaler42/12.50EUR');
  });

  it('generates and downloads an amount-bound EPC QR code while exposing copyable details', async () => {
    const user = userEvent.setup();
    let download: { fileName: string; href: string } | undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      download = { fileName: this.download, href: this.href };
    });
    render(<PaymentInstructionPanel
      amount={{ minorUnits: '1250', currency: 'EUR' }}
      paymentTarget={{ type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' }}
      reference="Membership August"
    />);

    expect(await screen.findByRole('img', { name: /SEPA-QR-Code.*TeamTaler Club/ })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/));
    expect(screen.getByText('DE89 3704 0044 0532 0130 00')).toBeVisible();

    await user.click(screen.getByRole('button', { name: i18n.t('paymentInstructions.copyField', { field: i18n.t('paymentInstructions.iban') }) }));
    expect(await navigator.clipboard.readText()).toBe('DE89370400440532013000');
    await user.click(screen.getByRole('button', { name: i18n.t('paymentInstructions.downloadQr') }));
    expect(click).toHaveBeenCalledOnce();
    expect(download).toEqual({ fileName: 'teamtaler-sepa-payment-qr.png', href: expect.stringMatching(/^data:image\/png/) });
  });

  it('removes the QR immediately for an invalid amount and keeps details when the EPC payload is too long', async () => {
    const target = { type: 'SEPA_TRANSFER' as const, recipientName: 'TeamTaler Club', iban: 'DE89370400440532013000' };
    const view = render(<PaymentInstructionPanel amount={{ minorUnits: '1250', currency: 'EUR' }} paymentTarget={target} reference="" />);

    expect(await screen.findByRole('img')).toBeVisible();
    view.rerender(<PaymentInstructionPanel amount={null} paymentTarget={target} reference="" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('paymentInstructions.enterAmount'))).toBeVisible();

    view.rerender(<PaymentInstructionPanel
      amount={{ minorUnits: '1350', currency: 'EUR' }}
      paymentTarget={{ ...target, recipientName: 'Ä'.repeat(70) }}
      reference={'ä'.repeat(140)}
    />);
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('paymentInstructions.epcErrors.PAYLOAD_TOO_LONG'));
    expect(screen.getByText('DE89 3704 0044 0532 0130 00')).toBeVisible();
  });

  it('discards clipboard feedback that completes after the payment context changes', async () => {
    let resolveCopy: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve; }));
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const amount = { minorUnits: '1250', currency: 'EUR' };
    const firstTarget = { type: 'SEPA_TRANSFER' as const, recipientName: 'First Club', iban: 'DE89370400440532013000' };
    const secondTarget = { type: 'SEPA_TRANSFER' as const, recipientName: 'Second Club', iban: 'DE12500105170648489890' };
    const view = render(<PaymentInstructionPanel amount={amount} paymentTarget={firstTarget} reference="August" />);

    await user.click(screen.getByRole('button', { name: i18n.t('paymentInstructions.copyField', { field: i18n.t('paymentInstructions.iban') }) }));
    expect(writeText).toHaveBeenCalledWith(firstTarget.iban);
    view.rerender(<PaymentInstructionPanel amount={amount} paymentTarget={secondTarget} reference="September" />);
    await act(async () => { resolveCopy?.(); });

    expect(screen.queryByText(i18n.t('common.copied'))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('paymentInstructions.copiedField', { field: i18n.t('paymentInstructions.iban') }))).not.toBeInTheDocument();
  });
});
