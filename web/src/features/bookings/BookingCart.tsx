import BookCheck from 'lucide-react/dist/esm/icons/book-check';
import ChevronUp from 'lucide-react/dist/esm/icons/chevron-up';
import Minus from 'lucide-react/dist/esm/icons/minus';
import Package from 'lucide-react/dist/esm/icons/package';
import Plus from 'lucide-react/dist/esm/icons/plus';
import ShoppingBasket from 'lucide-react/dist/esm/icons/shopping-basket';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import UsersRound from 'lucide-react/dist/esm/icons/users-round';
import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney, majorUnitsInputPattern, majorUnitsPlaceholder, validatePositiveMajorUnits } from '@/api/money';
import type { ConfigurableItem, ReasonMode } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { IconButton } from '@/components/ui/IconButton';
import { calculateCartTotal, resolveCartLinePrice, type BookingCartLine } from './bookingCartModel';
import styles from './BookingCart.module.css';

/** Supported presentation levels for the compact booking cart. */
export type BookingCartView = 'peek' | 'summary' | 'details';

/** Properties accepted by the responsive booking cart. */
export interface BookingCartProps {
  lines: readonly BookingCartLine[];
  targetCount: number;
  reason: string;
  bookingReasons: readonly ConfigurableItem[];
  reasonMode: ReasonMode;
  pending: boolean;
  error?: string;
  compact: boolean;
  view: BookingCartView;
  priceEntryRequest?: Readonly<{ productId: string; requestId: number }>;
  onViewChange: (view: BookingCartView) => void;
  onQuantityChange: (productId: string, quantity: number) => void;
  onUnitPriceChange: (productId: string, value: string) => void;
  onUnitPriceBlur: (productId: string) => void;
  onRemove: (productId: string) => void;
  onReasonChange: (reason: string) => void;
  onSubmit: () => void;
}


/**
 * Renders product-line editing and the single atomic booking action.
 *
 * @param props - Cart state, target scope, validation state, and event callbacks.
 * @returns A desktop inspector or compact mobile booking summary.
 */
export function BookingCart({
  lines,
  targetCount,
  reason,
  bookingReasons,
  reasonMode,
  pending,
  error,
  compact,
  view,
  priceEntryRequest,
  onViewChange,
  onQuantityChange,
  onUnitPriceChange,
  onUnitPriceBlur,
  onRemove,
  onReasonChange,
  onSubmit,
}: BookingCartProps) {
  const { t } = useTranslation();
  const cartRef = useRef<HTMLFormElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef(new Map<string, HTMLLIElement>());
  const dragRef = useRef<{ pointerId: number; startY: number; startTime: number; moved: boolean } | null>(null);
  const suppressHandleClickRef = useRef(false);
  const productCount = lines.length;
  const bookingCount = productCount * targetCount;
  const total = calculateCartTotal(lines, targetCount);
  const bookingScopeLabel = t('booking.bookingScope', {
    products: t('booking.productCount', { count: productCount }),
    targets: t('booking.personCount', { count: targetCount }),
    bookings: t('booking.bookingCount', { count: bookingCount }),
  });
  const hasInvalidPrice = lines.some((line) => !resolveCartLinePrice(line));
  const minimized = compact && view === 'peek';
  const showDetails = !compact || view === 'details';
  const reasonEnabled = reasonMode !== 'OFF';
  const reasonRequired = reasonMode === 'REQUIRED';
  const showReason = reasonEnabled && (reasonRequired || showDetails);
  const missingReason = reasonRequired && !reason.trim();
  const submitDisabled = pending || lines.length === 0 || targetCount === 0 || hasInvalidPrice || missingReason;
  const exceedsBookingLimit = bookingCount > 500;

  useEffect(() => {
    if (!priceEntryRequest || (compact && view !== 'details')) return;
    const frame = window.requestAnimationFrame(() => {
      const details = detailsRef.current;
      const line = lineRefs.current.get(priceEntryRequest.productId);
      const input = line?.querySelector<HTMLInputElement>('input');
      if (!details || !line || !input) return;

      input.focus({ preventScroll: true });
      const detailsTop = details.getBoundingClientRect().top;
      const lineTop = line.getBoundingClientRect().top;
      details.scrollTop = Math.max(0, details.scrollTop + lineTop - detailsTop);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [compact, priceEntryRequest, view]);

  const clearDragOffset = () => {
    const cart = cartRef.current;
    if (!cart) return;
    cart.style.removeProperty('transform');
    delete cart.dataset.dragging;
  };

  const startHandleDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startTime: performance.now(), moved: false };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events may not have an active platform pointer to capture.
    }
  };

  const moveHandleDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - drag.startY);
    if (distance > 3) {
      drag.moved = true;
      event.preventDefault();
    }
    const cart = cartRef.current;
    if (!cart) return;
    cart.dataset.dragging = 'true';
    cart.style.transform = `translateY(${Math.min(distance, 180)}px)`;
  };

  const finishHandleDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - drag.startY);
    const duration = Math.max(1, performance.now() - drag.startTime);
    const shouldMinimize = !cancelled && (distance >= 64 || (distance >= 28 && distance / duration >= 0.45));
    suppressHandleClickRef.current = drag.moved;
    if (drag.moved) window.setTimeout(() => { suppressHandleClickRef.current = false; }, 0);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    clearDragOffset();
    if (shouldMinimize) onViewChange('peek');
  };

  if (lines.length === 0) {
    return compact ? null : (
      <div className={styles.empty}>
        <ShoppingBasket aria-hidden="true" size={42} strokeWidth={1.6} />
        <strong>{t('booking.cartEmptyTitle')}</strong>
        <p>{t('booking.cartEmptyMessage')}</p>
      </div>
    );
  }

  return (
    <form className={`${styles.cart} ${compact ? styles.compact : ''} ${minimized ? styles.peekMode : ''}`} onSubmit={(event) => { event.preventDefault(); onSubmit(); }} ref={cartRef}>
      {compact ? minimized ? <span aria-hidden="true" className={styles.handle} /> : (
        <button
          aria-expanded="true"
          aria-label={t('booking.cartMinimize')}
          className={styles.dragHandle}
          onClick={() => {
            if (suppressHandleClickRef.current) {
              suppressHandleClickRef.current = false;
              return;
            }
            onViewChange('peek');
          }}
          onPointerCancel={(event) => finishHandleDrag(event, true)}
          onPointerDown={startHandleDrag}
          onPointerMove={moveHandleDrag}
          onPointerUp={finishHandleDrag}
          type="button"
        ><span aria-hidden="true" className={styles.handle} /></button>
      ) : null}
      {minimized ? (
        <button
          aria-expanded="false"
          aria-label={t('booking.cartExpandAccessible', {
            products: t('booking.productCount', { count: productCount }),
            total: total ? formatMoney(total) : '—',
          })}
          className={styles.peekButton}
          onClick={() => onViewChange('summary')}
          type="button"
        >
          <span className={styles.peekIdentity}>
            <strong>{t('booking.cartTitle')}</strong>
            <span aria-hidden="true" className={styles.peekProductCount}><Package size={16} strokeWidth={1.9} />{productCount}</span>
          </span>
          <strong className={styles.peekTotal}>{total ? formatMoney(total) : '—'}</strong>
          <ChevronUp aria-hidden="true" size={24} strokeWidth={2} />
        </button>
      ) : (
        <header className={styles.header}>
          <div>
            <h2>{t('booking.cartTitle')}</h2>
          </div>
          {compact ? (
            <div className={styles.headerActions}>
              {view === 'details' ? (
                <IconButton aria-expanded="true" label={t('booking.cartCollapse')} onClick={() => onViewChange('summary')}><X size={28} strokeWidth={1.8} /></IconButton>
              ) : (
                <Button aria-expanded="false" onClick={() => onViewChange('details')} size="small" variant="ghost">{t('booking.cartEdit')}</Button>
              )}
            </div>
          ) : null}
        </header>
      )}

      {!minimized && showDetails ? (
        <div className={styles.details} ref={detailsRef}>
          <ul className={styles.lines}>
            {lines.map((line) => {
              const userDefinesPrice = line.product.pricingMode === 'USER_DEFINED';
              const validation = userDefinesPrice ? validatePositiveMajorUnits(line.unitPriceInput, line.product.currency) : {};
              return (
                <li
                  className={styles.line}
                  key={line.product.id}
                  ref={(element) => {
                    if (element) lineRefs.current.set(line.product.id, element);
                    else lineRefs.current.delete(line.product.id);
                  }}
                >
                  <div className={styles.product}>
                    {line.product.imageUrl ? <img alt="" src={line.product.imageUrl} /> : <span className={styles.imageFallback}>{line.product.name.slice(0, 1)}</span>}
                    <div><strong>{line.product.name}</strong><span>{userDefinesPrice ? t('booking.enterPrice') : line.product.price ? formatMoney(line.product.price) : '—'}</span></div>
                    <IconButton label={t('booking.removeProduct', { name: line.product.name })} onClick={() => onRemove(line.product.id)}><Trash2 size={19} /></IconButton>
                  </div>
                  {userDefinesPrice ? (
                    <Field error={line.unitPriceTouched ? validation.error : undefined} htmlFor={`booking-unit-price-${line.product.id}`} label={t('booking.unitPriceForProduct', { name: line.product.name, currency: line.product.currency })}>
                      <TextInput autoComplete="off" id={`booking-unit-price-${line.product.id}`} inputMode="decimal" onBlur={() => onUnitPriceBlur(line.product.id)} onChange={(event) => onUnitPriceChange(line.product.id, event.target.value)} pattern={majorUnitsInputPattern(line.product.currency)} placeholder={majorUnitsPlaceholder(line.product.currency)} required type="text" value={line.unitPriceInput} />
                    </Field>
                  ) : null}
                  <div className={styles.quantityRow}>
                    <span>{t('booking.quantity')}</span>
                    <div className={styles.stepper}>
                      <IconButton disabled={line.quantity <= 1} label={t('booking.decreaseProductQuantity', { name: line.product.name })} onClick={() => onQuantityChange(line.product.id, Math.max(1, line.quantity - 1))}><Minus size={20} /></IconButton>
                      <output aria-label={t('booking.productQuantity', { name: line.product.name })}>{line.quantity}</output>
                      <IconButton disabled={line.quantity >= 99} label={t('booking.increaseProductQuantity', { name: line.product.name })} onClick={() => onQuantityChange(line.product.id, Math.min(99, line.quantity + 1))}><Plus size={20} /></IconButton>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

        </div>
      ) : null}

      {!minimized ? <footer className={styles.checkout}>
        {exceedsBookingLimit ? <p className={styles.error} role="alert">{t('booking.tooManyBookings')}</p> : error ? <p className={styles.error} role="alert">{error}</p> : null}
        {showReason ? (
          <div className={styles.reasonField}>
            <TextInput
              aria-describedby={!reason.trim() && error && reasonRequired ? 'booking-reason-error' : undefined}
              aria-invalid={!reason.trim() && error && reasonRequired ? true : undefined}
              aria-label={`${t('booking.reason')}${reasonRequired ? ' *' : ''}`}
              id="booking-reason"
              list="booking-reason-suggestions"
              maxLength={500}
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder={`${t('booking.reason')}${reasonRequired ? ' *' : ''}`}
              required={reasonRequired}
              value={reason}
            />
            <datalist id="booking-reason-suggestions">{bookingReasons.map((item) => <option key={item.id} value={item.label} />)}</datalist>
            {!reason.trim() && error && reasonRequired ? <span className={styles.reasonError} id="booking-reason-error" role="alert">{t('booking.reasonRequired')}</span> : null}
          </div>
        ) : null}
        <div aria-live="polite" className={styles.scope}>
          <strong>{total ? formatMoney(total) : '—'}</strong>
          {targetCount > 1 ? (
            <>
              <span aria-hidden="true" className={styles.scopeEquation}>
                <span className={styles.scopeFactor}><Package size={18} strokeWidth={2} /><b>{productCount}</b></span>
                <span className={styles.scopeOperator}>×</span>
                <span className={styles.scopeFactor}><UsersRound size={18} strokeWidth={2} /><b>{targetCount}</b></span>
                <span className={styles.scopeOperator}>=</span>
                <span className={styles.scopeFactor}><BookCheck size={18} strokeWidth={2} /><b>{bookingCount}</b></span>
              </span>
              <span className="sr-only">{bookingScopeLabel}</span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className={styles.scopeEquation}>
                <span className={styles.scopeFactor}><Package size={18} strokeWidth={2} /><b>{productCount}</b></span>
              </span>
              <span className="sr-only">{bookingScopeLabel}</span>
            </>
          )}
        </div>
        <Button disabled={submitDisabled || exceedsBookingLimit} fullWidth size="large" type="submit">
          {pending ? t('booking.pending') : bookingCount === 1 ? t('booking.submit') : t('booking.submitBookings')}
        </Button>
      </footer> : null}
    </form>
  );
}
