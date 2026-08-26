import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary } from '@/api/types';
import modalStyles from '@/components/ui/Modal.module.css';
import i18n from '@/i18n';
import { PaymentsPanel } from './PaymentsPanel';

const apiMock = vi.hoisted(() => ({
  getPaymentsPage: vi.fn(),
  getAccountSummaries: vi.fn(),
  createPayment: vi.fn(),
  reversePayment: vi.fn(),
  getTransactionSettings: vi.fn(),
}));
const mediaQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ api: apiMock }));
vi.mock('@/app/useActiveGroup', () => ({
  useActiveGroup: () => ({ activeGroupId: 'group-a', activeGroup: { currency: 'EUR' } }),
}));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: (query: string) => mediaQueryMock(query) }));

const accounts: AccountSummary[] = [
  { membershipId: 'member-active', displayName: 'Active Account', avatarUrl: '/avatars/active-account.png', isTemporaryGuest: false, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '0', currency: 'EUR' } },
  { membershipId: 'member-guest', displayName: 'Temporary Guest', isTemporaryGuest: true, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '100', currency: 'EUR' } },
  { membershipId: 'member-archived', displayName: 'Archived Account', isTemporaryGuest: false, status: 'ARCHIVED', currency: 'EUR', balance: { minorUnits: '500', currency: 'EUR' } },
  { membershipId: 'member-deleted', displayName: 'Deleted Account', isTemporaryGuest: false, status: 'DELETED', currency: 'EUR', balance: { minorUnits: '250', currency: 'EUR' } },
  { membershipId: 'member-deleted-credit', displayName: 'Deleted Credit', isTemporaryGuest: false, status: 'DELETED', currency: 'EUR', balance: { minorUnits: '-100', currency: 'EUR' } },
];

function renderPayments(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(<PaymentsPanel />, { wrapper });
}

describe('PaymentsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mediaQueryMock.mockReturnValue(false);
    window.history.replaceState({}, '', '/finance');
    apiMock.getPaymentsPage.mockResolvedValue({ hasMore: false, items: [], limit: 50 });
    apiMock.getAccountSummaries.mockResolvedValue(accounts);
    apiMock.getTransactionSettings.mockResolvedValue({
      foreignBookingReasonRequired: true,
      ownPaymentReasonRequired: true,
      otherPaymentReasonRequired: false,
      paymentMethods: [{ id: 'CASH', label: 'Bar' }, { id: 'PAYPAL', label: 'PayPal' }],
      bookingReasons: [],
      paymentReasons: [{ id: 'CORRECTION', label: 'Korrektur' }],
    });
  });

  it('renders payment entry as a bottom sheet on compact screens', async () => {
    const user = userEvent.setup();
    mediaQueryMock.mockReturnValue(true);
    renderPayments();

    await user.click((await screen.findAllByRole('button', { name: i18n.t('finance.record') }))[0]);

    const sheet = screen.getByRole('dialog', { name: i18n.t('finance.record') });
    expect(mediaQueryMock).toHaveBeenCalledWith('(max-width: 600px)');
    expect(sheet).toHaveClass(modalStyles.sheet);
    expect(sheet.querySelector(`button[aria-label="${i18n.t('dialog.sheetHandle')}"]`)).toBeInTheDocument();
  });

  it('uses finance account summaries without requesting the protected member directory', async () => {
    const user = userEvent.setup();
    renderPayments();

    await waitFor(() => expect(apiMock.getAccountSummaries).toHaveBeenCalledWith('group-a'));
    await user.click((await screen.findAllByRole('button', { name: i18n.t('finance.record') }))[0]);

    const accountSelect = screen.getByRole('combobox', { name: i18n.t('common.member') });
    await user.click(accountSelect);
    const listbox = screen.getByRole('listbox', { name: i18n.t('common.member') });
    expect(within(listbox).getByText(i18n.t('booking.regularMembers'))).toBeVisible();
    expect(within(listbox).getByText(i18n.t('booking.guests'))).toBeVisible();
    expect(within(listbox).getByText(i18n.t('financeWorkspace.archivedMembers'))).toBeVisible();
    expect(within(listbox).getByText(i18n.t('financeWorkspace.deletedAccounts'))).toBeVisible();
    expect(within(listbox).getByRole('option', { name: 'Active Account' }).querySelector('img')).toHaveAttribute('src', '/avatars/active-account.png');
    expect(within(listbox).getByRole('option', { name: 'Temporary Guest' })).toHaveTextContent('TG');
    expect(within(listbox).getByRole('option', { name: 'Archived Account' })).toHaveTextContent('AA');
    expect(within(listbox).getByRole('option', { name: 'Deleted Account' })).toBeVisible();
    expect(within(listbox).queryByRole('option', { name: 'Deleted Credit' })).not.toBeInTheDocument();
  });

  it('renders member avatars in the payments table', async () => {
    apiMock.getPaymentsPage.mockResolvedValue({
      hasMore: false,
      items: [{
        id: 'payment-active',
        membershipId: 'member-active',
        memberName: 'Active Account',
        membershipStatus: 'ACTIVE',
        amount: { minorUnits: '500', currency: 'EUR' },
        receivedAt: '2026-08-30T10:00:00Z',
        method: 'CASH',
        methodLabel: 'Bar',
        status: 'POSTED',
      }],
      limit: 50,
    });
    renderPayments();

    const member = await screen.findByText('Active Account');
    expect(member.closest('td')?.querySelector('img')).toHaveAttribute('src', '/avatars/active-account.png');
  });

  it('marks the amount as required while keeping the optional reference unmarked', async () => {
    const user = userEvent.setup();
    renderPayments();

    await user.click((await screen.findAllByRole('button', { name: i18n.t('finance.record') }))[0]);

    const amountInput = screen.getByLabelText(`${i18n.t('finance.amountIn', { currency: 'EUR' })} *`);
    expect(amountInput).toBeRequired();
    expect(amountInput).toHaveAttribute('inputmode', 'decimal');
    expect(amountInput).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText(i18n.t('finance.reason'))).not.toBeRequired();
    expect(screen.queryByLabelText(`${i18n.t('finance.reason')} *`)).not.toBeInTheDocument();
    expect(screen.getByLabelText(i18n.t('finance.paymentType'))).toHaveValue('CASH');
  });

  it('requires a reason for managed payments when configured', async () => {
    const user = userEvent.setup();
    apiMock.getTransactionSettings.mockResolvedValue({
      foreignBookingReasonRequired: true,
      ownPaymentReasonRequired: false,
      otherPaymentReasonRequired: true,
      paymentMethods: [{ id: 'CASH', label: 'Bar' }],
      bookingReasons: [],
      paymentReasons: [{ id: 'CORRECTION', label: 'Korrektur' }],
    });
    renderPayments();
    await user.click((await screen.findAllByRole('button', { name: i18n.t('finance.record') }))[0]);

    const reason = screen.getByLabelText(`${i18n.t('finance.reason')} *`);
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('list', 'payment-reason-suggestions');
  });

  it('hides the managed-payment reason when its mode is off', async () => {
    const user = userEvent.setup();
    apiMock.getTransactionSettings.mockResolvedValue({
      otherPaymentReasonMode: 'OFF',
      otherPaymentReasonRequired: false,
      paymentMethods: [{ id: 'CASH', label: 'Bar' }],
      bookingReasons: [],
      paymentReasons: [],
    });
    renderPayments();
    await user.click((await screen.findAllByRole('button', { name: i18n.t('finance.record') }))[0]);

    expect(screen.queryByLabelText(i18n.t('finance.reason'))).not.toBeInTheDocument();
    expect(screen.queryByLabelText(`${i18n.t('finance.reason')} *`)).not.toBeInTheDocument();
  });
});
