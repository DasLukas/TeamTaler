import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { PlanningSeriesScopeDialog } from './PlanningSeriesScopeDialog';

function ScopeHarness({ disableThis = false, onConfirm }: { disableThis?: boolean; onConfirm: (scope: string) => void }) {
  const [open, setOpen] = useState(true);
  const [scope, setScope] = useState<'THIS' | 'THIS_AND_FOLLOWING' | 'ALL'>('THIS');
  return <><button onClick={() => { setScope('THIS'); setOpen(true); }} type="button">Open</button><PlanningSeriesScopeDialog action="edit" disabledScopes={disableThis ? ['THIS'] : []} onClose={() => setOpen(false)} onConfirm={onConfirm} onScopeChange={setScope} open={open} recurrenceChanged restrictionMessage={disableThis ? 'Audience restriction' : undefined} scope={scope} /></>;
}

describe('PlanningSeriesScopeDialog', () => {
  it('offers every calendar scope and resets the safe default when reopened', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScopeHarness onConfirm={onConfirm} />);

    const all = screen.getByRole('radio', { name: /Gesamte Serie/ });
    await user.click(all);
    expect(all).toBeChecked();
    expect(screen.getByText(i18n.t('planning.seriesScope.recurrenceOnlySeriesNote'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByRole('radio', { name: /Nur dieser Termin/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: i18n.t('planning.seriesScope.confirm.edit') }));
    expect(onConfirm).toHaveBeenCalledWith('THIS');
  });

  it('requires an explicit series scope when a published audience was reduced', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScopeHarness disableThis onConfirm={onConfirm} />);

    expect(screen.getByRole('radio', { name: /Nur dieser Termin/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Nur dieser Termin/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: i18n.t('planning.seriesScope.confirm.edit') })).toBeDisabled();
    expect(screen.getByText('Audience restriction')).toBeVisible();

    await user.click(screen.getByRole('radio', { name: /Dieser und folgende/ }));
    await user.click(screen.getByRole('button', { name: i18n.t('planning.seriesScope.confirm.edit') }));
    expect(onConfirm).toHaveBeenCalledWith('THIS_AND_FOLLOWING');
  });

  it('explains that cancellation includes future manual exceptions in scope', () => {
    render(<PlanningSeriesScopeDialog action="cancel" onClose={vi.fn()} onConfirm={vi.fn()} onScopeChange={vi.fn()} open scope="THIS" />);

    expect(screen.getByText(i18n.t('planning.seriesScope.exceptionNote.cancel'))).toBeVisible();
    expect(screen.queryByText(i18n.t('planning.seriesScope.exceptionNote.edit'))).not.toBeInTheDocument();
  });
});
