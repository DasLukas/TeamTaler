import { useMutation, useQueryClient } from '@tanstack/react-query';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2';
import Minus from 'lucide-react/dist/esm/icons/minus';
import Plus from 'lucide-react/dist/esm/icons/plus';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, majorUnitsInputPattern, majorUnitsPlaceholder, multiplyMoney, validatePositiveMajorUnits } from '@/api/money';
import type { BookingTarget, ConfigurableItem, Period, Product } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { IconButton } from '@/components/ui/IconButton';
import { MemberMultiSelect } from './MemberMultiSelect';
import styles from './BookingInspector.module.css';

const BOOKING_CONFIRMATION_DURATION_MS = 700;

/** Properties accepted by the booking confirmation inspector. */
export interface BookingInspectorProps {
  groupId: string;
  product: Product;
  period: Period;
  targets: BookingTarget[];
  currentMembershipId: string;
  canBookForGuests: boolean;
  foreignBookingReasonRequired: boolean;
  bookingReasons: ConfigurableItem[];
  onCancel: () => void;
  onBooked?: () => void;
  compact?: boolean;
}

/**
 * Renders product booking confirmation with target and reason validation.
 *
 * @param props - Product, group, period, member, and callback configuration.
 * @returns A localized booking form or success confirmation.
 */
export function BookingInspector({
  groupId,
  product,
  period,
  targets,
  currentMembershipId,
  canBookForGuests,
  foreignBookingReasonRequired,
  bookingReasons,
  onCancel,
  onBooked,
  compact = false,
}: BookingInspectorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState(1);
  const [unitPriceInput, setUnitPriceInput] = useState('');
  const [unitPriceTouched, setUnitPriceTouched] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const confirmationTimerRef = useRef<number | undefined>(undefined);
  const targetSelectionTouchedRef = useRef(false);
  const canBookOwn = targets.some((target) => target.membershipId === currentMembershipId);
  const canAssignOthers = canBookForGuests || targets.some((target) => target.membershipId !== currentMembershipId);
  const defaultTargetMembershipIds = () => canBookOwn ? [currentMembershipId] : [];
  const [requestedTargetMembershipIds, setRequestedTargetMembershipIds] = useState<string[]>(defaultTargetMembershipIds);
  const [temporaryGuestDisplayNames, setTemporaryGuestDisplayNames] = useState<string[]>([]);
  const availableTargetIds = new Set(targets.map((target) => target.membershipId));
  const targetsById = new Map(targets.map((target) => [target.membershipId, target]));
  const targetMembershipIds = requestedTargetMembershipIds.filter((membershipId) => availableTargetIds.has(membershipId));
  const targetCount = targetMembershipIds.length + temporaryGuestDisplayNames.length;
  const hasForeignBooking = targetMembershipIds.some((membershipId) => membershipId !== currentMembershipId && !targetsById.get(membershipId)?.isTemporaryGuest);
  const needsReason = hasForeignBooking && foreignBookingReasonRequired;
  const userDefinesPrice = product.pricingMode === 'USER_DEFINED';
  const unitPriceValidation = userDefinesPrice ? validatePositiveMajorUnits(unitPriceInput, product.currency) : {};
  const unitPrice = userDefinesPrice
    ? unitPriceValidation.minorUnits ? { minorUnits: unitPriceValidation.minorUnits, currency: product.currency } : undefined
    : product.price;

  useEffect(() => () => {
    if (confirmationTimerRef.current !== undefined) window.clearTimeout(confirmationTimerRef.current);
  }, []);

  const bookingMutation = useMutation({
    mutationFn: () => {
      if (userDefinesPrice && !unitPrice) throw new Error(unitPriceValidation.error ?? t('errors.amountFormat'));
      if (targetCount === 0) throw new Error(t('booking.noAvailableTarget'));
      return api.createBookings(groupId, {
        productId: product.id,
        productVersion: product.version,
        expectedPeriodId: period.id,
        quantity,
        unitPrice: userDefinesPrice ? unitPrice : undefined,
        targetMembershipIds,
        ...(temporaryGuestDisplayNames.length > 0 ? { temporaryGuestDisplayNames } : {}),
        reason: reason.trim() || undefined,
      });
    },
    onSuccess: () => {
      setConfirmed(true);
      confirmationTimerRef.current = window.setTimeout(() => {
        confirmationTimerRef.current = undefined;
        setQuantity(1);
        setUnitPriceInput('');
        setUnitPriceTouched(false);
        setRequestedTargetMembershipIds(defaultTargetMembershipIds());
        setTemporaryGuestDisplayNames([]);
        targetSelectionTouchedRef.current = false;
        setReason('');
        setConfirmed(false);
        onBooked?.();
      }, BOOKING_CONFIRMATION_DURATION_MS);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['booking-context', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['bookings', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['ledger', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['account-summaries', groupId] }),
        ...(temporaryGuestDisplayNames.length > 0 ? [queryClient.invalidateQueries({ queryKey: ['members', groupId] })] : []),
      ]);
    },
  });

  const selectedTargetIds = new Set(targetMembershipIds);
  const selectedTargets = targets.filter((target) => selectedTargetIds.has(target.membershipId));
  const totalPerMember = unitPrice ? multiplyMoney(unitPrice, quantity) : undefined;
  const combinedTotal = totalPerMember && targetCount > 0 ? multiplyMoney(totalPerMember, targetCount) : undefined;

  const changeTargets = (membershipIds: string[]) => {
    targetSelectionTouchedRef.current = true;
    setRequestedTargetMembershipIds(membershipIds);
  };

  const addTemporaryGuest = (displayName: string) => {
    if (!targetSelectionTouchedRef.current
      && temporaryGuestDisplayNames.length === 0
      && targetMembershipIds.length === 1
      && targetMembershipIds[0] === currentMembershipId) {
      setRequestedTargetMembershipIds([]);
    }
    targetSelectionTouchedRef.current = true;
    setTemporaryGuestDisplayNames((current) => [...current, displayName]);
  };

  if (confirmed) {
    return (
      <div className={styles.success} role="status">
        <CheckCircle2 aria-hidden="true" size={46} strokeWidth={1.6} />
        <h2>{t('booking.successTitle')}</h2>
        <p>{targetCount > 1
          ? t('booking.successMessageMultiple', { product: product.name, count: targetCount })
          : t('booking.successMessage', { product: product.name, member: selectedTargets[0]?.displayName ?? temporaryGuestDisplayNames[0] ?? t('common.selectedMemberFallback') })}</p>
      </div>
    );
  }

  return (
    <form className={`${styles.form} ${compact ? styles.compact : ''}`} onSubmit={(event) => { event.preventDefault(); bookingMutation.mutate(); }}>
      <div className={styles.product}>
        {product.imageUrl ? <img alt="" src={product.imageUrl} /> : <span className={styles.imageFallback}>{product.name.slice(0, 1)}</span>}
        <div><strong>{product.name}</strong><span>{product.pricingMode === 'FIXED' && product.price ? formatMoney(product.price) : t('booking.enterPrice')}</span></div>
      </div>

      <Field htmlFor="booking-member" label={t('booking.forMember')}>
        {canAssignOthers ? (
          <MemberMultiSelect
            canBookForGuests={canBookForGuests}
            disabled={targets.length === 0 && !canBookForGuests}
            id="booking-member"
            label={t('booking.forMember')}
            onAddGuest={addTemporaryGuest}
            onChange={changeTargets}
            onRemoveGuest={(index) => { targetSelectionTouchedRef.current = true; setTemporaryGuestDisplayNames((current) => current.filter((_, itemIndex) => itemIndex !== index)); }}
            pendingGuestNames={temporaryGuestDisplayNames}
            placeholder={t('booking.selectMembers')}
            selectedIds={targetMembershipIds}
            targets={targets}
          />
        ) : (
          <SelectInput disabled id="booking-member" value={targetMembershipIds[0] ?? ''}>
            {targets.map((target) => <option key={target.membershipId} value={target.membershipId}>{target.displayName}</option>)}
          </SelectInput>
        )}
      </Field>

      {userDefinesPrice ? (
        <Field error={unitPriceTouched ? unitPriceValidation.error : undefined} htmlFor="booking-unit-price" label={t('booking.unitPrice', { currency: product.currency })}>
          <TextInput autoComplete="off" id="booking-unit-price" inputMode="decimal" onBlur={() => setUnitPriceTouched(true)} onChange={(event) => setUnitPriceInput(event.target.value)} pattern={majorUnitsInputPattern(product.currency)} placeholder={majorUnitsPlaceholder(product.currency)} required type="text" value={unitPriceInput} />
        </Field>
      ) : null}

      {hasForeignBooking ? (
        <Field error={needsReason && !reason.trim() && bookingMutation.isError ? t('booking.reasonRequired') : undefined} htmlFor="booking-reason" label={`${t('booking.reason')}${needsReason ? ' *' : ''}`}>
          <TextInput id="booking-reason" list="booking-reason-suggestions" maxLength={500} onChange={(event) => setReason(event.target.value)} required={needsReason} value={reason} />
          <datalist id="booking-reason-suggestions">{bookingReasons.map((item) => <option key={item.id} value={item.label} />)}</datalist>
        </Field>
      ) : null}

      <Field htmlFor="booking-quantity" label={t('booking.quantity')}>
        <div className={styles.stepper} id="booking-quantity">
          <IconButton disabled={quantity <= 1} label={t('booking.decreaseQuantity')} onClick={() => setQuantity((current) => Math.max(1, current - 1))}><Minus size={22} /></IconButton>
          <output aria-live="polite">{quantity}</output>
          <IconButton disabled={quantity >= 99} label={t('booking.increaseQuantity')} onClick={() => setQuantity((current) => Math.min(99, current + 1))}><Plus size={22} /></IconButton>
        </div>
      </Field>

      <div className={styles.total}>
        <div className={styles.totalCopy}>
          <span>{t('booking.total')}</span>
          {targetCount > 1 && totalPerMember ? <small>{t('booking.totalPerMember', { total: formatMoney(totalPerMember) })}</small> : null}
        </div>
        <strong>{combinedTotal ? formatMoney(combinedTotal) : '—'}</strong>
      </div>
      {bookingMutation.isError ? <p className={styles.error} role="alert">{bookingMutation.error.message}</p> : null}
      <div className={styles.actions}>
        <Button fullWidth onClick={onCancel} size="large" variant="secondary">{t('common.cancel')}</Button>
        <Button disabled={bookingMutation.isPending || targetCount === 0 || (userDefinesPrice && !unitPrice) || (needsReason && !reason.trim())} fullWidth size="large" type="submit">
          {bookingMutation.isPending ? t('booking.pending') : targetCount > 1 ? t('booking.submitMultiple', { count: targetCount }) : t('booking.submit')}
        </Button>
      </div>
      <p className={styles.note}><CheckCircle2 aria-hidden="true" size={18} /> {t('booking.balanceUpdateNote')}</p>
    </form>
  );
}
