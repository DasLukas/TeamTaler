import Minus from 'lucide-react/dist/esm/icons/minus';
import Plus from 'lucide-react/dist/esm/icons/plus';
import ShoppingBasket from 'lucide-react/dist/esm/icons/shopping-basket';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useTranslation } from 'react-i18next';
import { formatMoney, majorUnitsInputPattern, majorUnitsPlaceholder, validatePositiveMajorUnits } from '@/api/money';
import type { ConfigurableItem } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { IconButton } from '@/components/ui/IconButton';
import { calculateCartTotal, resolveCartLinePrice, type BookingCartLine } from './bookingCartModel';
import styles from './BookingCart.module.css';

/** Properties accepted by the responsive booking cart. */
export interface BookingCartProps {
  lines: readonly BookingCartLine[];
  targetCount: number;
  targetSummary: string;
  reason: string;
  bookingReasons: readonly ConfigurableItem[];
  reasonRequired: boolean;
  pending: boolean;
  error?: string;
  compact: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
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
  targetSummary,
  reason,
  bookingReasons,
  reasonRequired,
  pending,
  error,
  compact,
  expanded,
  onExpandedChange,
  onQuantityChange,
  onUnitPriceChange,
  onUnitPriceBlur,
  onRemove,
  onReasonChange,
  onSubmit,
}: BookingCartProps) {
  const { t } = useTranslation();
  const productCount = lines.length;
  const bookingCount = productCount * targetCount;
  const total = calculateCartTotal(lines, targetCount);
  const hasInvalidPrice = lines.some((line) => !resolveCartLinePrice(line));
  const showDetails = !compact || expanded;
  const missingReason = reasonRequired && !reason.trim();
  const submitDisabled = pending || lines.length === 0 || targetCount === 0 || hasInvalidPrice || missingReason;
  const exceedsBookingLimit = bookingCount > 500;

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
    <form className={`${styles.cart} ${compact ? styles.compact : ''}`} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      {compact ? <span aria-hidden="true" className={styles.handle} /> : null}
      <header className={styles.header}>
        <div>
          <h2>{t('booking.cartTitle')}</h2>
          <strong>{targetSummary}</strong>
        </div>
        {compact ? expanded ? (
          <IconButton aria-expanded="true" label={t('booking.cartCollapse')} onClick={() => onExpandedChange(false)}><X size={28} strokeWidth={1.8} /></IconButton>
        ) : (
          <Button aria-expanded="false" onClick={() => onExpandedChange(true)} size="small" variant="ghost">{t('booking.cartEdit')}</Button>
        ) : null}
      </header>

      {showDetails ? (
        <div className={styles.details}>
          <ul className={styles.lines}>
            {lines.map((line) => {
              const userDefinesPrice = line.product.pricingMode === 'USER_DEFINED';
              const validation = userDefinesPrice ? validatePositiveMajorUnits(line.unitPriceInput, line.product.currency) : {};
              return (
                <li className={styles.line} key={line.product.id}>
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

      <footer className={styles.checkout}>
        <div aria-live="polite" className={styles.scope}>
          <span>{t('booking.bookingScope', {
            products: t('booking.productCount', { count: productCount }),
            targets: t('booking.personCount', { count: targetCount }),
            bookings: t('booking.bookingCount', { count: bookingCount }),
          })}</span>
          <strong>{total ? formatMoney(total) : '—'}</strong>
        </div>
        {exceedsBookingLimit ? <p className={styles.error} role="alert">{t('booking.tooManyBookings')}</p> : error ? <p className={styles.error} role="alert">{error}</p> : null}
        {reasonRequired ? (
          <Field error={!reason.trim() && error ? t('booking.reasonRequired') : undefined} htmlFor="booking-reason" label={`${t('booking.reason')} *`}>
            <TextInput id="booking-reason" list="booking-reason-suggestions" maxLength={500} onChange={(event) => onReasonChange(event.target.value)} required value={reason} />
            <datalist id="booking-reason-suggestions">{bookingReasons.map((item) => <option key={item.id} value={item.label} />)}</datalist>
          </Field>
        ) : null}
        <Button disabled={submitDisabled || exceedsBookingLimit} fullWidth size="large" type="submit">
          {pending ? t('booking.pending') : bookingCount === 1 ? t('booking.submit') : t('booking.submitBookingCount', { count: bookingCount })}
        </Button>
      </footer>
    </form>
  );
}
