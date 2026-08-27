import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState, type FormEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { Modal, ModalFooter } from './Modal';
import styles from './Modal.module.css';

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

/** Renders sibling modal layers to verify nested workflow scroll locking. */
function NestedModalHarness() {
  const [primaryOpen, setPrimaryOpen] = useState(false);
  const [nestedOpen, setNestedOpen] = useState(false);
  return (
    <>
      <button onClick={() => setPrimaryOpen(true)} type="button">Open primary dialog</button>
      <Modal onClose={() => setPrimaryOpen(false)} open={primaryOpen} title="Primary dialog">
        <button onClick={() => setNestedOpen(true)} type="button">Open nested dialog</button>
        <button onClick={() => setPrimaryOpen(false)} type="button">Close primary dialog</button>
      </Modal>
      <Modal onClose={() => setNestedOpen(false)} open={nestedOpen} title="Nested dialog">
        <button onClick={() => setNestedOpen(false)} type="button">Close nested dialog</button>
      </Modal>
    </>
  );
}

describe('Modal lifecycle and focus restoration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

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

  it('locks document scrolling until the last open modal layer closes', async () => {
    const user = userEvent.setup();
    render(<NestedModalHarness />);

    expect(document.documentElement).not.toHaveAttribute('data-modal-scroll-lock');
    await user.click(screen.getByRole('button', { name: 'Open primary dialog' }));
    expect(document.documentElement).toHaveAttribute('data-modal-scroll-lock', 'true');

    await user.click(screen.getByRole('button', { name: 'Open nested dialog' }));
    expect(document.documentElement).toHaveAttribute('data-modal-scroll-lock', 'true');
    await user.click(screen.getByRole('button', { name: 'Close nested dialog' }));
    expect(document.documentElement).toHaveAttribute('data-modal-scroll-lock', 'true');

    await user.click(screen.getByRole('button', { name: 'Close primary dialog' }));
    expect(document.documentElement).not.toHaveAttribute('data-modal-scroll-lock');
  });

  it('preserves and restores the page position without a visible background jump', () => {
    const originalScrollX = Object.getOwnPropertyDescriptor(window, 'scrollX');
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 12 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 240 });
    const rendered = render(<Modal onClose={vi.fn()} open title="Position-safe dialog"><span>Content</span></Modal>);

    try {
      expect(document.documentElement).toHaveStyle({ '--modal-scroll-lock-left': '-12px', '--modal-scroll-lock-top': '-240px' });
      Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 });
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
      rendered.rerender(<Modal onClose={vi.fn()} open={false} title="Position-safe dialog"><span>Content</span></Modal>);
      expect(scrollTo).toHaveBeenCalledWith(12, 240);
      expect(document.documentElement).not.toHaveAttribute('data-modal-scroll-lock');
    } finally {
      rendered.unmount();
      if (originalScrollX) Object.defineProperty(window, 'scrollX', originalScrollX);
      else Reflect.deleteProperty(window, 'scrollX');
      if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY);
      else Reflect.deleteProperty(window, 'scrollY');
    }
  });

  it('keeps shared footer actions outside the scrollable body for every modal size', () => {
    render(
      <Modal
        footer={<button type="button">Apply changes</button>}
        onClose={vi.fn()}
        open
        size="workspace"
        title="Structured dialog"
        variant="sheet"
      >
        <span>Scrollable criteria</span>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Structured dialog' });
    const action = screen.getByRole('button', { name: 'Apply changes' });
    expect(dialog.className).toContain(styles.workspace);
    expect(screen.getByText('Scrollable criteria').parentElement?.className).toContain(styles.body);
    expect(action.closest('footer')?.className).toContain(styles.footer);
    expect(action.closest('footer')?.parentElement).toBe(dialog);
  });

  it('renders viewport-filling workspaces without sheet drag chrome', () => {
    const rendered = render(
      <Modal onClose={vi.fn()} open size="workspace" title="Document scanner" variant="fullscreen">
        <span>Scanner content</span>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Document scanner' });
    expect(dialog.className).toContain(styles.workspace);
    expect(dialog.className).toContain(styles.fullscreen);
    expect(rendered.container.querySelector(`button[aria-label="${i18n.t('dialog.sheetHandle')}"]`)).toBeNull();
  });

  it('keeps a headerless workspace accessible without rendering visible chrome', () => {
    const rendered = render(
      <Modal headerMode="accessible-only" onClose={vi.fn()} open size="workspace" title="Camera scanner" variant="fullscreen">
        <span>Camera content</span>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Camera scanner' });
    expect(dialog.className).toContain(styles.headerless);
    expect(screen.getByRole('heading', { name: 'Camera scanner' }).className).toContain(styles.accessibleTitle);
    expect(rendered.container.querySelector(`button[aria-label="${i18n.t('dialog.close')}"]`)).toBeNull();
  });

  it('portals content-owned workflow actions into the persistent footer', () => {
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    render(
      <Modal onClose={vi.fn()} open title="Compound footer">
        <form id="profile-form" onSubmit={onSubmit}>
          <label htmlFor="profile-name">Name</label>
          <input id="profile-name" />
          <ModalFooter><button form="profile-form" type="submit">Save profile</button></ModalFooter>
        </form>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Compound footer' });
    const form = dialog.querySelector('#profile-form');
    const action = screen.getByRole('button', { name: 'Save profile' });
    expect(form?.contains(action)).toBe(false);
    expect(action).toHaveAttribute('form', 'profile-form');
    expect(action.closest('footer')?.className).toContain(styles.footer);
    expect(action.closest('footer')?.parentElement).toBe(dialog);
    fireEvent.click(action);
    expect(onSubmit).toHaveBeenCalledOnce();
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

  it('closes every sheet when its shared handle is swiped down', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const rendered = render(<Modal onClose={onClose} open title="Swipeable sheet" variant="sheet"><span>Content</span></Modal>);
    const handle = rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('dialog.sheetHandle')}"]`);
    expect(handle).not.toBeNull();
    if (!handle) return;

    fireEvent.pointerDown(handle, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 180, pointerId: 1 });
    vi.advanceTimersByTime(220);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns a sheet to its resting position after a short handle drag', () => {
    const onClose = vi.fn();
    const rendered = render(<Modal onClose={onClose} open title="Stable sheet" variant="sheet"><span>Content</span></Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Stable sheet' });
    const handle = rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('dialog.sheetHandle')}"]`);
    expect(handle).not.toBeNull();
    if (!handle) return;

    fireEvent.pointerDown(handle, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 110, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 110, pointerId: 1 });

    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.style.transform).toBe('');
    expect(dialog).not.toHaveAttribute('data-dragging');
  });

  it('supports the shared swipe gesture when pointer events are unavailable', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const rendered = render(<Modal onClose={onClose} open title="Mouse-compatible sheet" variant="sheet"><span>Content</span></Modal>);
    const handle = rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('dialog.sheetHandle')}"]`);
    expect(handle).not.toBeNull();
    if (!handle) return;

    fireEvent.mouseDown(handle, { button: 0, clientY: 100 });
    fireEvent.mouseMove(window, { button: 0, clientY: 180 });
    fireEvent.mouseUp(window, { button: 0, clientY: 180 });
    vi.advanceTimersByTime(220);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports direct touch swipes on the shared sheet handle', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const rendered = render(<Modal onClose={onClose} open title="Touch sheet" variant="sheet"><span>Content</span></Modal>);
    const handle = rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('dialog.sheetHandle')}"]`);
    expect(handle).not.toBeNull();
    if (!handle) return;

    fireEvent.touchStart(handle, { touches: [{ clientY: 100, identifier: 4 }] });
    fireEvent.touchMove(handle, { touches: [{ clientY: 180, identifier: 4 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientY: 180, identifier: 4 }], touches: [] });
    vi.advanceTimersByTime(220);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
