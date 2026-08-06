import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { MobileHeader } from './MobileHeader';

const mocks = vi.hoisted(() => ({ setActiveGroupId: vi.fn(), useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@/components/brand/Brand', () => ({ Brand: () => <div>TeamTaler</div> }));

describe('MobileHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useActiveGroup.mockReturnValue({
      activeGroupId: 'group-a',
      session: {
        groups: [
          { id: 'group-a', name: 'TeamTaler Demo Club', currency: 'EUR' },
          { id: 'group-b', name: 'Second Club', currency: 'EUR' },
        ],
      },
      setActiveGroupId: mocks.setActiveGroupId,
    });
  });

  it('keeps the native group selector accessible when its mobile presentation is icon-only', () => {
    render(<MobileHeader />);

    const selector = screen.getByRole('combobox', { name: i18n.t('nav.selectGroup') });
    expect(selector).toHaveAttribute('title', 'TeamTaler Demo Club');
    expect(selector).toHaveValue('group-a');
    expect(screen.getByRole('option', { name: 'Second Club' })).toBeInTheDocument();

    fireEvent.change(selector, { target: { value: 'group-b' } });
    expect(mocks.setActiveGroupId).toHaveBeenCalledWith('group-b');
  });
});
