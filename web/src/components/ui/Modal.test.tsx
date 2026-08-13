import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { Modal } from './Modal';

/** Renders a modal that is removed from the tree when its parent closes it. */
function UnmountingModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">Open sheet</button>
      {open ? (
        <Modal onClose={() => setOpen(false)} open title="Booking" variant="sheet">
          <button onClick={() => setOpen(false)} type="button">Cancel booking</button>
        </Modal>
      ) : null}
    </>
  );
}

/** Renders a controlled modal that remains mounted after it closes. */
function ControlledModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">Open dialog</button>
      <Modal onClose={() => setOpen(false)} open={open} title="Controlled dialog">
        <span>Dialog content</span>
      </Modal>
    </>
  );
}

describe('Modal lifecycle and focus restoration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('closes before unmounting and restores focus after an in-content cancel action', async () => {
    const user = userEvent.setup();
    const closeSpy = vi.spyOn(HTMLDialogElement.prototype, 'close');
    render(<StrictMode><UnmountingModalHarness /></StrictMode>);

    const trigger = screen.getByRole('button', { name: 'Open sheet' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Booking' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Cancel booking' }));

    expect(screen.queryByRole('dialog', { name: 'Booking' })).not.toBeInTheDocument();
    expect(closeSpy).toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('restores focus when the native cancel event closes an unmounting sheet', async () => {
    const user = userEvent.setup();
    render(<UnmountingModalHarness />);

    const trigger = screen.getByRole('button', { name: 'Open sheet' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Booking' });
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));

    expect(screen.queryByRole('dialog', { name: 'Booking' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes a mounted controlled dialog and restores focus through its close button', async () => {
    const user = userEvent.setup();
    render(<ControlledModalHarness />);

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: i18n.t('dialog.close') }));

    expect(screen.queryByRole('dialog', { name: 'Controlled dialog' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps sheets above the software keyboard visual viewport', () => {
    const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const visualViewport = {
      addEventListener,
      height: 540,
      offsetTop: 0,
      removeEventListener,
    } as unknown as VisualViewport;

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 915 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    const rendered = render(<Modal onClose={vi.fn()} open title="Keyboard-safe sheet" variant="sheet"><input aria-label="Guest name" /></Modal>);

    try {
      const dialog = screen.getByRole('dialog', { name: 'Keyboard-safe sheet' });
      expect(dialog).toHaveStyle({ '--modal-visual-viewport-height': '540px', '--modal-visual-viewport-bottom': '375px' });
      expect(addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
      expect(addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    } finally {
      rendered.unmount();
      if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
      else Reflect.deleteProperty(window, 'visualViewport');
      if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
    }

    expect(removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
