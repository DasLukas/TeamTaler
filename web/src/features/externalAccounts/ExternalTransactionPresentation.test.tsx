import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ExternalAccountTransaction } from '@/api/types';
import { ExternalTransactionActor, ExternalTransactionAmount, ExternalTransactionKind, ExternalTransactionStatus } from './ExternalTransactionPresentation';
import styles from './ExternalTransactionPresentation.module.css';

describe('external transaction presentation', () => {
  it('shows an icon and semantic badge for each transaction kind', () => {
    const { container } = render(<><ExternalTransactionKind kind="TRANSFER" /><ExternalTransactionKind kind="INCOME" /><ExternalTransactionKind kind="EXPENSE" /></>);

    expect(screen.getByText('Umbuchung').closest('[data-transaction-kind]')).toHaveClass(styles.kindInfo);
    expect(screen.getByText('Einzahlung').closest('[data-transaction-kind]')).toHaveClass(styles.kindPositive);
    expect(screen.getByText('Auszahlung').closest('[data-transaction-kind]')).toHaveClass(styles.kindNegative);
    expect(container.querySelectorAll('[data-transaction-kind] svg')).toHaveLength(3);
  });

  it('colors the signed amount and mutes a reversed original', () => {
    render(<>
      <ExternalTransactionAmount amount={{ minorUnits: '1500', currency: 'EUR' }} status="POSTED" />
      <ExternalTransactionAmount amount={{ minorUnits: '-1000', currency: 'EUR' }} status="POSTED" />
      <ExternalTransactionAmount amount={{ minorUnits: '250', currency: 'EUR' }} status="REVERSED" />
    </>);

    expect(screen.getByText(/\+15,00/)).toHaveClass(styles.amountPositive);
    expect(screen.getByText(/-10,00/)).toHaveClass(styles.amountNegative);
    expect(screen.getByText(/\+2,50/)).toHaveClass(styles.amountReversed);
  });

  it('shows a protected profile image when available and initials otherwise', () => {
    const { container } = render(<>
      <ExternalTransactionActor actor={{ id: 'member-1', displayName: 'Ada Admin', avatarUrl: '/api/v1/users/user-1/avatar/image.png' }} />
      <ExternalTransactionActor actor={{ id: 'member-2', displayName: 'Emil Trainer' }} />
    </>);

    expect(screen.getByText('Ada Admin')).toBeVisible();
    expect(screen.getByText('Emil Trainer')).toBeVisible();
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/api/v1/users/user-1/avatar/image.png');
    expect(container.textContent).toContain('ET');
  });

  it.each<ExternalAccountTransaction['status']>(['POSTED', 'REVERSED'])('shows the %s status with an icon', (status) => {
    const { container } = render(<ExternalTransactionStatus status={status} />);

    expect(screen.getByText(status === 'POSTED' ? 'Gebucht' : 'Storniert')).toBeVisible();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
