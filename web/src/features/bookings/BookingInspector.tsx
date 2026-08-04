import { useMutation, useQueryClient } from '@tanstack/react-query';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2';
import Minus from 'lucide-react/dist/esm/icons/minus';
import Plus from 'lucide-react/dist/esm/icons/plus';
import UserRound from 'lucide-react/dist/esm/icons/user-round';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, multiplyMoney } from '@/api/money';
import type { Membership, Period, Product } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { IconButton } from '@/components/ui/IconButton';
import styles from './BookingInspector.module.css';

/** Properties accepted by the booking confirmation inspector. */
export interface BookingInspectorProps {
  groupId: string;
  product: Product;
  categoryType: 'STANDARD' | 'PENALTY';
  period: Period;
  members: Membership[];
  currentMembershipId: string;
  onCancel: () => void;
  onBooked?: () => void;
  compact?: boolean;
}

/**
 * Renders product booking confirmation with target and penalty validation.
 *
 * @param props - Product, group, period, member, and callback configuration.
 * @returns A localized booking form or success confirmation.
 */
export function BookingInspector({
  groupId,
  product,
  categoryType,
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
  const [targetMembershipId, setTargetMembershipId] = useState(currentMembershipId);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const isPenalty = categoryType === 'PENALTY';
  const currentMember = members.find((member) => member.id === currentMembershipId);
  const canAssignOthers = currentMember?.roles.includes('ADMIN') || currentMember?.categoryPermissions.some((permission) => permission.categoryId === product.categoryId && permission.assignToOthers);
  const availableMembers = canAssignOthers ? members.filter((member) => member.active) : members.filter((member) => member.id === currentMembershipId);
  const isForeignAssignment = targetMembershipId !== currentMembershipId;

  const bookingMutation = useMutation({
    mutationFn: () => api.createBooking(groupId, {
      productId: product.id,
      productVersion: product.version,
      expectedPeriodId: period.id,
      quantity: isPenalty ? 1 : quantity,
      targetMembershipId: targetMembershipId === currentMembershipId ? undefined : targetMembershipId,
      reason: isPenalty && isForeignAssignment ? reason.trim() : undefined,
    }),
    onSuccess: async () => {
      setConfirmed(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['bookings', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['ledger', groupId] }),
      ]);
      window.setTimeout(() => onBooked?.(), 700);
    },
  });

  const selectedMember = members.find((member) => member.id === targetMembershipId);
  const total = multiplyMoney(product.price, isPenalty ? 1 : quantity);

  if (confirmed) {
    return (
      <div className={styles.success} role="status">
        <CheckCircle2 aria-hidden="true" size={46} strokeWidth={1.6} />
        <h2>{t('booking.successTitle')}</h2>
        <p>{t('booking.successMessage', { product: product.name, member: selectedMember?.displayName ?? t('common.selectedMemberFallback') })}</p>
      </div>
    );
  }

  return (
    <form className={`${styles.form} ${compact ? styles.compact : ''}`} onSubmit={(event) => { event.preventDefault(); bookingMutation.mutate(); }}>
      <div className={styles.product}>
        {product.imageUrl ? <img alt="" src={product.imageUrl} /> : <span className={styles.imageFallback}>{product.name.slice(0, 1)}</span>}
        <div><strong>{product.name}</strong><span>{formatMoney(product.price)}</span></div>
      </div>

      <Field htmlFor="booking-member" label={t('booking.forMember')}>
        <div className={styles.selectWithIcon}>
          <UserRound aria-hidden="true" size={22} strokeWidth={1.7} />
          <SelectInput id="booking-member" onChange={(event) => setTargetMembershipId(event.target.value)} value={targetMembershipId}>
            {availableMembers.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
          </SelectInput>
        </div>
      </Field>

      {isPenalty && isForeignAssignment ? (
        <Field error={!reason.trim() && bookingMutation.isError ? t('booking.reasonRequired') : undefined} htmlFor="penalty-reason" label={t('booking.reason')}>
          <TextInput id="penalty-reason" onChange={(event) => setReason(event.target.value)} placeholder={t('booking.reasonPlaceholder')} value={reason} />
        </Field>
      ) : (
        <Field htmlFor="booking-quantity" label={t('booking.quantity')}>
          <div className={styles.stepper} id="booking-quantity">
            <IconButton disabled={quantity <= 1} label={t('booking.decreaseQuantity')} onClick={() => setQuantity((current) => Math.max(1, current - 1))}><Minus size={22} /></IconButton>
            <output aria-live="polite">{quantity}</output>
            <IconButton disabled={quantity >= 99} label={t('booking.increaseQuantity')} onClick={() => setQuantity((current) => Math.min(99, current + 1))}><Plus size={22} /></IconButton>
          </div>
        </Field>
      )}

      <div className={styles.total}><span>{t('booking.total')}</span><strong>{formatMoney(total)}</strong></div>
      {bookingMutation.isError ? <p className={styles.error} role="alert">{bookingMutation.error.message}</p> : null}
      <div className={styles.actions}>
        <Button fullWidth onClick={onCancel} size="large" variant="secondary">{t('common.cancel')}</Button>
        <Button disabled={bookingMutation.isPending || (isPenalty && isForeignAssignment && !reason.trim())} fullWidth size="large" type="submit">
          {bookingMutation.isPending ? t('booking.pending') : t('booking.submit')}
        </Button>
      </div>
      <p className={styles.note}><CheckCircle2 aria-hidden="true" size={18} /> {t('booking.balanceUpdateNote')}</p>
    </form>
  );
}
