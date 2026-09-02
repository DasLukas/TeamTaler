import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field, TextInput } from './FormField';

describe('Field', () => {
  it('visually marks required controls without changing their accessible name', () => {
    render(<Field htmlFor="required-input" label="Required field" required><TextInput id="required-input" required /></Field>);

    const input = screen.getByRole('textbox', { name: 'Required field' }) as HTMLInputElement;
    expect(input).toBeRequired();
    expect(input.labels?.[0]).toHaveTextContent('Required field *');
  });
});
