import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSoftwareKeyboardVisibility } from './useSoftwareKeyboardVisibility';

/** Renders the keyboard state beside representative text and non-text inputs. */
function KeyboardVisibilityHarness() {
  const visible = useSoftwareKeyboardVisibility();
  return (
    <div data-keyboard-visible={visible}>
      <input aria-label="Name" />
      <input aria-label="Description" />
      <input aria-label="Attachment" type="file" />
    </div>
  );
}

describe('useSoftwareKeyboardVisibility', () => {
  const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');

  afterEach(() => {
    if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
    else Reflect.deleteProperty(window, 'visualViewport');
    if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
  });

  it('stays visible while iOS scrolls or changes the focused field above a reduced visual viewport', async () => {
    const visualViewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    render(<KeyboardVisibilityHarness />);

    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    act(() => nameInput.focus());
    expect(nameInput).toHaveFocus();
    visualViewport.height = 520;
    act(() => visualViewport.dispatchEvent(new Event('resize')));
    expect(nameInput.parentElement).toHaveAttribute('data-keyboard-visible', 'true');

    visualViewport.offsetTop = 240;
    act(() => visualViewport.dispatchEvent(new Event('scroll')));
    expect(nameInput.parentElement).toHaveAttribute('data-keyboard-visible', 'true');

    const descriptionInput = screen.getByRole('textbox', { name: 'Description' });
    await act(async () => descriptionInput.focus());
    expect(descriptionInput.parentElement).toHaveAttribute('data-keyboard-visible', 'true');

    visualViewport.height = 844;
    act(() => visualViewport.dispatchEvent(new Event('resize')));
    expect(nameInput.parentElement).toHaveAttribute('data-keyboard-visible', 'false');
  });

  it('does not treat a non-text file picker as a software keyboard', () => {
    const visualViewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    render(<KeyboardVisibilityHarness />);

    act(() => screen.getByLabelText('Attachment').focus());

    expect(screen.getByLabelText('Attachment').parentElement).toHaveAttribute('data-keyboard-visible', 'false');
  });
});
