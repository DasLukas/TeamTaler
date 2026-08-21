import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Brand } from './Brand';

describe('Brand', () => {
  it('always renders the transparent TeamTaler emblem', () => {
    render(<Brand name="TeamTaler" />);

    expect(screen.getByAltText('TeamTaler Bildmarke')).toHaveAttribute(
      'src',
      '/brand/teamtaler-emblem-transparent.webp',
    );
  });

  it('keeps the accessible instance name while hiding visible text in compact mode', () => {
    render(<Brand compact name="TeamTaler Local" />);

    expect(screen.getByLabelText('TeamTaler Local')).toBeVisible();
    expect(screen.queryByText('TeamTaler Local')).not.toBeInTheDocument();
  });
});
