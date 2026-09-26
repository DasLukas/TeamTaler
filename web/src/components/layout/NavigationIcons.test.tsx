import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FinanceNavigationIcon } from './FinanceNavigationIcon';
import { AccountNavigationIcon } from './AccountNavigationIcon';

describe('contextual navigation icons', () => {
  it('updates the currency glyph when the workspace currency changes', () => {
    const view = render(<FinanceNavigationIcon currency="EUR" />);
    expect(view.container.querySelector('text')).toHaveTextContent('€');
    view.rerender(<FinanceNavigationIcon currency="GBP" />);
    expect(view.container.querySelector('text')).toHaveTextContent('£');
    view.rerender(<FinanceNavigationIcon currency="USD" />);
    expect(view.container.querySelector('text')).toHaveTextContent('$');
    view.rerender(<FinanceNavigationIcon currency="invalid" />);
    expect(view.container.querySelector('text')).toHaveTextContent('¤');
  });

  it('retains the account fallback for absent or failed images and reflects profile changes', () => {
    const view = render(<AccountNavigationIcon />);
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('svg')).toBeInTheDocument();
    view.rerender(<AccountNavigationIcon avatarUrl="/avatar-a.png" />);
    const image = view.container.querySelector('img')!;
    expect(image).toHaveAttribute('src', '/avatar-a.png');
    fireEvent.error(image);
    expect(view.container.querySelector('svg')).toBeInTheDocument();
    view.rerender(<AccountNavigationIcon avatarUrl="/avatar-b.png" />);
    expect(view.container.querySelector('img')).toHaveAttribute('src', '/avatar-b.png');
    view.rerender(<AccountNavigationIcon />);
    expect(view.container.querySelector('img')).toBeNull();
  });
});
