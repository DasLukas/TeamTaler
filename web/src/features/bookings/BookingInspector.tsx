import { useMutation, useQueryClient } from '@tanstack/react-query';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2';
import Minus from 'lucide-react/dist/esm/icons/minus';
import Plus from 'lucide-react/dist/esm/icons/plus';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, majorUnitsInputPattern, majorUnitsPlaceholder, multiplyMoney, validatePositiveMajorUnits } from '@/api/money';
import type { Membership, Period, Product } from '@/api/types';
import { can } from '@/app/permissions';
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
  members: Membership[];
  currentMembershipId: string;
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
  members,
  currentMembershipId,
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
  const currentMember = members.find((member) => member.id === currentMembershipId);
  const canBookOwn = can(currentMember?.effectiveGrants, 'CREATE_OWN_BOOKING');
  const canAssignOthers = can(currentMember?.effectiveGrants, 'BOOK_FOR_OTHERS');
  const availableMembers = members.filter((member) => member.active && (member.id === currentMembershipId ? canBookOwn : canAssignOthers));
  const defaultTargetMembershipIds = () => canBookOwn ? [currentMembershipId] : availableMembers[0] ? [availableMembers[0].id] : [];
  const [requestedTargetMembershipIds, setRequestedTargetMembershipIds] = useState<string[]>(defaultTargetMembershipIds);
  const availableMemberIds = new Set(availableMembers.map((member) => member.id));
  const targetMembershipIds = requestedTargetMembershipIds.filter((membershipId) => availableMemberIds.has(membershipId));
  const isForeignAssignment = targetMembershipIds.some((membershipId) => membershipId !== currentMembershipId);
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
      if (targetMembershipIds.length === 0) throw new Error(t('booking.noAvailableTarget'));
      return api.createBookings(groupId, {
        productId: product.id,
        productVersion: product.version,
        expectedPeriodId: period.id,
        quantity,
        unitPrice: userDefinesPrice ? unitPrice : undefined,
        targetMembershipIds,
        reason: isForeignAssignment ? reason.trim() : undefined,
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
        setReason('');
        setConfirmed(false);
        onBooked?.();
      }, BOOKING_CONFIRMATION_DURATION_MS);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['bookings', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['ledger', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['account-summaries', groupId] }),
      ]);
    },
  });

  const selectedMembers = members.filter((member) => targetMembershipIds.includes(member.id));
  const totalPerMember = unitPrice ? multiplyMoney(unitPrice, quantity) : undefined;
  const combinedTotal = totalPerMember && targetMembershipIds.length > 0 ? multiplyMoney(totalPerMember, targetMembershipIds.length) : undefined;

  if (confirmed) {
    return (
      <div className={styles.success} role="status">
        <CheckCircle2 aria-hidden="true" size={46} strokeWidth={1.6} />
        <h2>{t('booking.successTitle')}</h2>
        <p>{targetMembershipIds.length > 1
          ? t('booking.successMessageMultiple', { product: product.name, count: targetMembershipIds.length })
          : t('booking.successMessage', { product: product.name, member: selectedMembers[0]?.displayName ?? t('common.selectedMemberFallback') })}</p>
      </div>
    );
  }

  return (
    <form className={`${styles.form} ${compact ? styles.compact : ''}`} onSubmit={(event) => { event.preventDefault(); bookingMutation.mutate(); }}>
      <div className={styles.product}>
        {product.imageUrl ? <img alt="" src={product.imageUrl} /> : <span className={styles.imageFallback}>{product.name.slice(0, 1)}</span>}
        <div><strong>{product.name}</strong><span>{product.pricingMode === 'FIXED' && product.price ? formatMoney(product.price) : t('booking.enterPrice')}</span></div>
      </div>

      {userDefinesPrice ? (
        <Field error={unitPriceTouched ? unitPriceValidation.error : undefined} htmlFor="booking-unit-price" label={t('booking.unitPrice', { currency: product.currency })}>
          <TextInput autoComplete="off" id="booking-unit-price" inputMode="decimal" onBlur={() => setUnitPriceTouched(true)} onChange={(event) => setUnitPriceInput(event.target.value)} pattern={majorUnitsInputPattern(product.currency)} placeholder={majorUnitsPlaceholder(product.currency)} required type="text" value={unitPriceInput} />
        </Field>
      ) : null}

      <Field htmlFor="booking-member" label={t('booking.forMember')}>
        {canAssignOthers ? (
          <MemberMultiSelect
            disabled={availableMembers.length === 0}
            id="booking-member"
            label={t('booking.forMember')}
            members={availableMembers}
            onChange={setRequestedTargetMembershipIds}
            placeholder={t('booking.selectMembers')}
            selectedIds={targetMembershipIds}
          />
        ) : (
          <SelectInput disabled id="booking-member" value={targetMembershipIds[0] ?? ''}>
            {availableMembers.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
          </SelectInput>
        )}
      </Field>

      {isForeignAssignment ? (
        <Field error={!reason.trim() && bookingMutation.isError ? t('booking.reasonRequired') : undefined} htmlFor="booking-reason" label={t('booking.reason')}>
          <TextInput id="booking-reason" onChange={(event) => setReason(event.target.value)} placeholder={t('booking.reasonPlaceholder')} required value={reason} />
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
        <span>{targetMembershipIds.length > 1 ? t('booking.combinedTotal', { count: targetMembershipIds.length }) : t('booking.total')}</span>
        <strong>{combinedTotal ? formatMoney(combinedTotal) : '—'}</strong>
        {targetMembershipIds.length > 1 && totalPerMember ? <small>{t('booking.totalPerMember', { total: formatMoney(totalPerMember) })}</small> : null}
      </div>
      {bookingMutation.isError ? <p className={styles.error} role="alert">{bookingMutation.error.message}</p> : null}
      <div className={styles.actions}>
        <Button fullWidth onClick={onCancel} size="large" variant="secondary">{t('common.cancel')}</Button>
        <Button disabled={bookingMutation.isPending || targetMembershipIds.length === 0 || (userDefinesPrice && !unitPrice) || (isForeignAssignment && !reason.trim())} fullWidth size="large" type="submit">
          {bookingMutation.isPending ? t('booking.pending') : targetMembershipIds.length > 1 ? t('booking.submitMultiple', { count: targetMembershipIds.length }) : t('booking.submit')}
        </Button>
      </div>
      <p className={styles.note}><CheckCircle2 aria-hidden="true" size={18} /> {t('booking.balanceUpdateNote')}</p>
    </form>
  );
}
