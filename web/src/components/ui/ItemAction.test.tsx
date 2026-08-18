import { render, screen } from '@testing-library/react';
import Archive from 'lucide-react/dist/esm/icons/archive';
import { describe, expect, it } from 'vitest';
import { ItemAction } from './ItemAction';

describe('ItemAction', () => {
  it('keeps its icon and visible label in the shared link-style presentation', () => {
    const rendered = render(<ItemAction leadingIcon={<Archive data-testid="archive-icon" size={16} />}>Archive</ItemAction>);

    const action = screen.getByRole('button', { name: 'Archive' });
    expect(action.className).toContain('small');
    expect(action.className).toContain('ghost');
    expect(action.className).not.toContain('collapseLabelAt');
    expect(screen.getByText('Archive')).toBeVisible();
    expect(rendered.container.querySelector('[aria-hidden="true"]')).toContainElement(screen.getByTestId('archive-icon'));
  });
});
