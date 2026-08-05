import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BottomNavigation } from './BottomNavigation';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));

describe('BottomNavigation', () => {
  it('always renders the four primary mobile destinations', () => {
    render(<BottomNavigation />);

    expect(screen.getAllByRole('link', { hidden: true }).map((link) => link.textContent)).toEqual(['Übersicht', 'Buchen', 'Aktivitäten', 'Mehr']);
    expect(screen.queryByRole('link', { name: 'Katalog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Finanzen' })).not.toBeInTheDocument();
  });
});
