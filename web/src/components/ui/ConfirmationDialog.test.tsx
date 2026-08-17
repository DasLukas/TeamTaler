import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Archive from 'lucide-react/dist/esm/icons/archive';
import { describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { ConfirmationDialog } from './ConfirmationDialog';

describe('ConfirmationDialog', () => {
  it('confirms through the shared application dialog without browser APIs', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmationDialog
        confirmIcon={<Archive size={17} />}
        confirmLabel="Archive"
        message="Regular access will be disabled."
        onClose={onClose}
        onConfirm={onConfirm}
        open
        title="Archive group?"
        tone="danger"
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Archive group?' });
    expect(within(dialog).getByText('Regular access will be disabled.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Archive' }).className).toContain('danger');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('prevents dismissal and duplicate confirmation while pending', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmationDialog
        confirmIcon={<Archive size={17} />}
        confirmLabel="Archiving …"
        message="Regular access will be disabled."
        onClose={onClose}
        onConfirm={onConfirm}
        open
        pending
        title="Archive group?"
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Archive group?' });
    expect(within(dialog).getByRole('button', { name: 'Archiving …' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.cancel') }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
