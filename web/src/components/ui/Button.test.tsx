import { render, screen } from '@testing-library/react';
import Save from 'lucide-react/dist/esm/icons/save';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders a semantic icon and a visible action label', () => {
    const rendered = render(<Button leadingIcon={<Save data-testid="save-icon" size={17} />}>Save</Button>);

    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    expect(screen.getByText('Save')).toBeVisible();
    expect(rendered.container.querySelector('[aria-hidden="true"]')).toContainElement(screen.getByTestId('save-icon'));
  });

  it('marks explicitly compact actions for shared narrow responsive behavior', () => {
    render(<Button aria-label="Save settings" collapseLabelAt="narrow" leadingIcon={<Save size={17} />}>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save settings' });
    expect(button.className).toContain('collapseLabelAtNarrow');
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('marks tablet-only compaction without changing the accessible name', () => {
    render(<Button aria-label="Save settings" collapseLabelAt="tablet" leadingIcon={<Save size={17} />}>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save settings' });
    expect(button.className).toContain('collapseLabelAtTablet');
    expect(screen.getByText('Save')).toBeInTheDocument();
  });
});
