import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { PlanningToolbar } from './PlanningToolbar';

describe('PlanningToolbar', () => {
  it('keeps the Today action named while marking its label for narrow-screen collapse', () => {
    render(<PlanningToolbar label="31. Aug. – 6. Sept. 2026" onMove={vi.fn()} onToday={vi.fn()} onViewChange={vi.fn()} view="week" />);

    const todayButton = screen.getByRole('button', { name: i18n.t('planning.today') });
    expect(todayButton.className).toContain('collapseLabelAtNarrow');
    expect(screen.getByText(i18n.t('planning.today'))).toBeInTheDocument();
  });
});
