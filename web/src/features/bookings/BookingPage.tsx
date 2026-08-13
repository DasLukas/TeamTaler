import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, isCreditBalance } from '@/api/money';
import type { BookingContext, Category, Product } from '@/api/types';
import { hasGroupCapability } from '@/app/groupCapabilities';
import { memberPaths } from '@/app/paths';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Field, TextInput } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { BookingCart } from './BookingCart';
import { resolveCartLinePrice, type BookingCartLine } from './bookingCartModel';
import { MemberMultiSelect } from './MemberMultiSelect';
import { ProductPicker } from './ProductPicker';
import { getBookableCategories } from './bookable';
import styles from './BookingPage.module.css';

const BOOKING_CONFIRMATION_DURATION_MS = 1_200;

/** Properties accepted by the loaded booking workspace. */
interface BookingWorkspaceProps {
  groupId: string;
  categories: Category[];
  context: BookingContext;
  compact: boolean;
}

/**
 * Renders the loaded recipient-first catalog and multi-product booking cart.
 *
 * @param props - Permission-filtered booking context and active catalog.
 * @returns A responsive booking workspace with one atomic submit action.
 */
function BookingWorkspace({ groupId, categories, context, compact }: BookingWorkspaceProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const bookableCategories = useMemo(() => getBookableCategories(categories), [categories]);
  const canBookOwn = context.targets.some((target) => target.membershipId === context.currentMembership.id);
  const canAssignOthers = context.canBookForGuests || context.targets.some((target) => target.membershipId !== context.currentMembership.id);
  const initialTargetMembershipIds = canBookOwn ? [context.currentMembership.id] : [];
  const [categoryId, setCategoryId] = useState(bookableCategories[0]?.id ?? '');
  const [lines, setLines] = useState<BookingCartLine[]>([]);
  const [requestedTargetMembershipIds, setRequestedTargetMembershipIds] = useState<string[]>(initialTargetMembershipIds);
  const [temporaryGuestDisplayNames, setTemporaryGuestDisplayNames] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [cartExpanded, setCartExpanded] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [cartLimitError, setCartLimitError] = useState('');
  const targetSelectionTouchedRef = useRef(false);
  const confirmationTimerRef = useRef<number | undefined>(undefined);
  const availableTargetIds = new Set(context.targets.map((target) => target.membershipId));
  const targetsById = new Map(context.targets.map((target) => [target.membershipId, target]));
  const targetMembershipIds = requestedTargetMembershipIds.filter((membershipId) => availableTargetIds.has(membershipId));
  const targetCount = targetMembershipIds.length + temporaryGuestDisplayNames.length;
  const selectedTargets = context.targets.filter((target) => targetMembershipIds.includes(target.membershipId));
  const targetSummary = targetCount === 1
    ? selectedTargets[0]?.displayName ?? temporaryGuestDisplayNames[0] ?? t('common.selectedMemberFallback')
    : t('booking.targetCount', { count: targetCount });
  const hasForeignBooking = targetMembershipIds.some((membershipId) => membershipId !== context.currentMembership.id && !targetsById.get(membershipId)?.isTemporaryGuest);
  const reasonRequired = hasForeignBooking && context.foreignBookingReasonRequired;
  useEffect(() => () => {
    if (confirmationTimerRef.current !== undefined) window.clearTimeout(confirmationTimerRef.current);
  }, []);

  const resetWorkspace = () => {
    setLines([]);
    setRequestedTargetMembershipIds(initialTargetMembershipIds);
    setTemporaryGuestDisplayNames([]);
    targetSelectionTouchedRef.current = false;
    setReason('');
    setCartExpanded(false);
  };

  const bookingMutation = useMutation({
    mutationFn: () => api.createBulkBookings(groupId, {
      expectedPeriodId: context.openPeriod.id,
      items: lines.map((line) => ({
        productId: line.product.id,
        productVersion: line.product.version,
        quantity: line.quantity,
        unitPrice: line.product.pricingMode === 'USER_DEFINED' ? resolveCartLinePrice(line) : undefined,
      })),
      targetMembershipIds,
      ...(temporaryGuestDisplayNames.length > 0 ? { temporaryGuestDisplayNames } : {}),
      reason: reason.trim() || undefined,
    }),
    onSuccess: (createdBookings) => {
      setConfirmation(t('booking.bulkSuccess', { count: createdBookings.length }));
      resetWorkspace();
      if (confirmationTimerRef.current !== undefined) window.clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = window.setTimeout(() => {
        confirmationTimerRef.current = undefined;
        setConfirmation('');
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

  const addProduct = (product: Product) => {
    const existing = lines.some((line) => line.product.id === product.id);
    if (existing) {
      setLines((current) => current.map((line) => line.product.id === product.id ? { ...line, quantity: Math.min(99, line.quantity + 1) } : line));
      return;
    }
    if (lines.length >= 25) {
      setCartLimitError(t('booking.tooManyProducts'));
      return;
    }
    setCartLimitError('');
    setLines((current) => [...current, { product, quantity: 1, unitPriceInput: '', unitPriceTouched: false }]);
    if (compact && product.pricingMode === 'USER_DEFINED') setCartExpanded(true);
  };

  const changeLineQuantity = (productId: string, quantity: number) => {
    setCartLimitError('');
    setLines((current) => quantity <= 0
      ? current.filter((line) => line.product.id !== productId)
      : current.map((line) => line.product.id === productId ? { ...line, quantity } : line));
  };

  const decreaseProduct = (product: Product) => {
    const line = lines.find((item) => item.product.id === product.id);
    if (line) changeLineQuantity(product.id, line.quantity - 1);
  };

  const changeTargets = (membershipIds: string[]) => {
    targetSelectionTouchedRef.current = true;
    const keepsForeignMember = membershipIds.some((membershipId) => membershipId !== context.currentMembership.id && !targetsById.get(membershipId)?.isTemporaryGuest);
    if (!keepsForeignMember) setReason('');
    setRequestedTargetMembershipIds(membershipIds);
  };

  const addTemporaryGuest = (displayName: string) => {
    if (!targetSelectionTouchedRef.current
      && temporaryGuestDisplayNames.length === 0
      && targetMembershipIds.length === 1
      && targetMembershipIds[0] === context.currentMembership.id) {
      setRequestedTargetMembershipIds([]);
    }
    targetSelectionTouchedRef.current = true;
    setTemporaryGuestDisplayNames((current) => [...current, displayName]);
  };

  return (
    <div className={`${styles.layout} ${lines.length > 0 ? styles.hasCart : ''}`}>
      <section className={styles.content}>
        <h1>{t('booking.quickTitle')}</h1>
        <div className={`${styles.balanceRow} ${canAssignOthers ? styles.hasTargetControl : ''}`}>
          <div className={styles.balance}>
            <div className={styles.balanceAmount}><span>{t('booking.openBalance')}</span><strong className={isCreditBalance(context.ownBalance) ? styles.creditBalance : undefined} data-financial-state={isCreditBalance(context.ownBalance) ? 'credit' : 'due'}>{formatMoney(context.ownBalance)}</strong></div>
            {!canAssignOthers ? <WalletCards aria-hidden="true" size={40} strokeWidth={1.8} /> : null}
          </div>
          {canAssignOthers ? <div className={styles.targetControl}>
              <MemberMultiSelect
                canBookForGuests={context.canBookForGuests}
                disabled={context.targets.length === 0 && !context.canBookForGuests}
                id="booking-member"
                iconOnly
                label={t('booking.targetButtonLabel', { count: targetCount })}
                onAddGuest={addTemporaryGuest}
                onChange={changeTargets}
                onRemoveGuest={(index) => { targetSelectionTouchedRef.current = true; setTemporaryGuestDisplayNames((current) => current.filter((_, itemIndex) => itemIndex !== index)); }}
                overlayOnMobile
                pendingGuestNames={temporaryGuestDisplayNames}
                placeholder={t('booking.selectMembers')}
                selectedIds={targetMembershipIds}
                targets={context.targets}
              />
          </div> : null}
        </div>

        {hasForeignBooking && !context.foreignBookingReasonRequired ? (
          <div className={styles.optionalReason}>
            <Field htmlFor="booking-shared-reason" label={t('booking.reason')}>
              <TextInput id="booking-shared-reason" list="booking-shared-reason-suggestions" maxLength={500} onChange={(event) => setReason(event.target.value)} value={reason} />
              <datalist id="booking-shared-reason-suggestions">{context.bookingReasons.map((item) => <option key={item.id} value={item.label} />)}</datalist>
            </Field>
          </div>
        ) : null}

        {confirmation ? <div className={styles.confirmation} role="status"><CheckCircle2 aria-hidden="true" size={22} /> {confirmation}</div> : null}

        <ProductPicker
          categories={bookableCategories}
          layout="rows"
          onCategoryChange={setCategoryId}
          onProductDecrease={decreaseProduct}
          onProductSelect={addProduct}
          productQuantities={Object.fromEntries(lines.map((line) => [line.product.id, line.quantity]))}
          selectedCategoryId={categoryId}
          selectedProductIds={lines.map((line) => line.product.id)}
        />
      </section>
      <aside aria-label={t('booking.cartTitle')} className={styles.inspector}>
        <BookingCart
          bookingReasons={context.bookingReasons}
          compact={compact}
          error={cartLimitError || (bookingMutation.isError ? bookingMutation.error.message : undefined)}
          expanded={cartExpanded}
          lines={lines}
          onExpandedChange={setCartExpanded}
          onQuantityChange={changeLineQuantity}
          onReasonChange={setReason}
          onRemove={(productId) => changeLineQuantity(productId, 0)}
          onSubmit={() => bookingMutation.mutate()}
          onUnitPriceBlur={(productId) => setLines((current) => current.map((line) => line.product.id === productId ? { ...line, unitPriceTouched: true } : line))}
          onUnitPriceChange={(productId, value) => setLines((current) => current.map((line) => line.product.id === productId ? { ...line, unitPriceInput: value } : line))}
          pending={bookingMutation.isPending}
          reason={reason}
          reasonRequired={reasonRequired}
          targetCount={targetCount}
          targetSummary={targetSummary}
        />
      </aside>
    </div>
  );
}

/**
 * Loads and renders the dedicated product booking workspace.
 *
 * @returns Product choices, persistent recipient scope, and a responsive cart.
 */
export function BookingPage() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const bookingContextQuery = useQuery({ queryKey: ['booking-context', activeGroupId], queryFn: () => api.getBookingContext(activeGroupId, activeGroup.currency) });
  const compact = useMediaQuery('(max-width: 1023px)');

  if (categoriesQuery.isLoading || bookingContextQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (categoriesQuery.isError || bookingContextQuery.isError || !categoriesQuery.data || !bookingContextQuery.data) {
    return <div className={styles.state}><StatePanel kind="error" message={t('booking.productsError')} /></div>;
  }
  if (bookingContextQuery.data.targets.length === 0 && !bookingContextQuery.data.canBookForGuests) {
    return <div className={styles.state}><StatePanel kind="empty" title={t('booking.noAccessTitle')} message={t('booking.noAccessMessage')} /></div>;
  }
  const bookableCategories = getBookableCategories(categoriesQuery.data);
  if (!bookableCategories.some((category) => category.products.length > 0)) {
    const canManageCatalog = hasGroupCapability(activeGroup.membership?.effectiveGrants, 'catalog');
    return <div className={styles.state}><StatePanel kind="empty" title={t('booking.noProductsTitle')} message={t('booking.noProductsMessage')}>{canManageCatalog ? <Link className={styles.catalogLink} to={memberPaths.catalog}>{t('booking.catalogLink')}</Link> : null}</StatePanel></div>;
  }

  return <BookingWorkspace categories={categoriesQuery.data} compact={compact} context={bookingContextQuery.data} groupId={activeGroupId} key={activeGroupId} />;
}
