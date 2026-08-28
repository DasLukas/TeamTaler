import { describe, expect, it } from 'vitest';
import {
  buildEpcQrPayload,
  buildPaypalMePaymentUrl,
  isBicRequiredForIban,
  isPaymentTargetValid,
  isValidBic,
  isValidIban,
  normalizeBic,
  normalizeIban,
  normalizePaypalMeHandle,
} from './paymentTargets';

describe('payment target helpers', () => {
  it('normalizes canonical handles and exact PayPal.Me links only', () => {
    expect(normalizePaypalMeHandle(' TeamTaler42 ')).toBe('TeamTaler42');
    expect(normalizePaypalMeHandle('https://www.paypal.me/TeamTaler42/')).toBe('TeamTaler42');
    expect(normalizePaypalMeHandle('paypal.me/TeamTaler42')).toBe('TeamTaler42');
    expect(normalizePaypalMeHandle('https://paypal.me/TeamTaler42/25EUR')).toBeNull();
    expect(normalizePaypalMeHandle('https://paypal.me.evil.test/TeamTaler42')).toBeNull();
    expect(normalizePaypalMeHandle('https://user@paypal.me/TeamTaler42')).toBeNull();
    expect(normalizePaypalMeHandle('https://paypal.me:444/TeamTaler42')).toBeNull();
    expect(normalizePaypalMeHandle('https://paypal.me/%54eamTaler42')).toBeNull();
    expect(normalizePaypalMeHandle('http://paypal.me/TeamTaler42')).toBeNull();
    expect(normalizePaypalMeHandle('team-taler')).toBeNull();
    expect(isPaymentTargetValid({ type: 'PAYPAL_ME', paypalMeHandle: 'https://paypal.me/TeamTaler42' }, 'EUR')).toBe(true);
  });

  it('builds exact currency-aware PayPal.Me amount URLs without floating point math', () => {
    expect(buildPaypalMePaymentUrl('TeamTaler42', { minorUnits: '1250', currency: 'EUR' })).toBe('https://paypal.me/TeamTaler42/12.50EUR');
    expect(buildPaypalMePaymentUrl('TeamTaler42', { minorUnits: '123', currency: 'JPY' })).toBe('https://paypal.me/TeamTaler42/123JPY');
    expect(buildPaypalMePaymentUrl('TeamTaler42', { minorUnits: '1234', currency: 'KWD' })).toBe('https://paypal.me/TeamTaler42/1.234KWD');
    expect(() => buildPaypalMePaymentUrl('TeamTaler42', { minorUnits: 'invalid', currency: 'EUR' })).toThrow(TypeError);
    expect(() => buildPaypalMePaymentUrl('TeamTaler42', { minorUnits: '0', currency: 'EUR' })).toThrow(TypeError);
  });

  it('normalizes and validates IBAN and optional BIC values', () => {
    expect(normalizeIban('de89 3704 0044 0532 0130 00')).toBe('DE89370400440532013000');
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(isValidIban('DE89 3704 0044 0532 0130 01')).toBe(false);
    expect(normalizeBic('coba de ff xxx')).toBe('COBADEFFXXX');
    expect(isValidBic('COBADEFFXXX')).toBe(true);
    expect(isValidBic('')).toBe(true);
    expect(isValidBic('INVALID')).toBe(false);
    expect(isBicRequiredForIban('DE89370400440532013000')).toBe(false);
    expect(isBicRequiredForIban('CH9300762011623852957')).toBe(true);
    expect(isPaymentTargetValid({ type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'CH9300762011623852957' }, 'EUR')).toBe(false);
    expect(isPaymentTargetValid({ type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'CH9300762011623852957', bic: 'POFICHBEXXX' }, 'EUR')).toBe(true);
  });

  it('builds an EPC version-002 UTF-8 payload without a trailing separator', () => {
    const target = { type: 'SEPA_TRANSFER' as const, recipientName: 'TeamTaler Club', iban: 'DE89 3704 0044 0532 0130 00', bic: 'cobadeffxxx' };
    const result = buildEpcQrPayload(target, { minorUnits: '1250', currency: 'EUR' }, 'Membership August');

    expect(result).toEqual({
      error: null,
      payload: 'BCD\n002\n1\nSCT\nCOBADEFFXXX\nTeamTaler Club\nDE89370400440532013000\nEUR12.50\n\n\nMembership August',
    });
    expect(result.payload?.endsWith('\n')).toBe(false);
    expect(buildEpcQrPayload({ ...target, bic: undefined }, { minorUnits: '1', currency: 'EUR' })).toEqual({
      error: null,
      payload: 'BCD\n002\n1\nSCT\n\nTeamTaler Club\nDE89370400440532013000\nEUR0.01',
    });
  });

  it('rejects invalid targets, EPC bounds, control characters, and oversized UTF-8 payloads', () => {
    const target = { type: 'SEPA_TRANSFER' as const, recipientName: 'TeamTaler Club', iban: 'DE89370400440532013000' };
    expect(isPaymentTargetValid(target, 'USD')).toBe(false);
    expect(isPaymentTargetValid({ ...target, recipientName: 'TeamTaler\u0085Club' }, 'EUR')).toBe(false);
    expect(buildEpcQrPayload(target, { minorUnits: '100000000000', currency: 'EUR' })).toEqual({ payload: null, error: 'INVALID_AMOUNT' });
    expect(buildEpcQrPayload(target, { minorUnits: '1250', currency: 'EUR' }, 'x'.repeat(141))).toEqual({ payload: null, error: 'REFERENCE_TOO_LONG' });
    expect(buildEpcQrPayload(target, { minorUnits: '1250', currency: 'EUR' }, 'line\nbreak')).toEqual({ payload: null, error: 'REFERENCE_TOO_LONG' });
    expect(buildEpcQrPayload(target, { minorUnits: '1250', currency: 'EUR' }, 'control\u0085break')).toEqual({ payload: null, error: 'REFERENCE_TOO_LONG' });
    expect(buildEpcQrPayload({ ...target, recipientName: 'Ä'.repeat(70) }, { minorUnits: '1250', currency: 'EUR' }, 'ä'.repeat(140))).toEqual({ payload: null, error: 'PAYLOAD_TOO_LONG' });
  });
});
