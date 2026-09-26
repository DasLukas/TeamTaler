import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2';
import ScanLine from 'lucide-react/dist/esm/icons/scan-line';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, isCreditBalance } from '@/api/money';
import type { BookingContext, Category, Product } from '@/api/types';
import { canOpenBooking, hasGroupCapability } from '@/app/groupCapabilities';
import { can } from '@/app/permissions';
import { memberPaths } from '@/app/paths';
import { useActiveGroup } from '@/app/useActiveGroup';
import { StatePanel } from '@/components/ui/StatePanel';
import { Button } from '@/components/ui/Button';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { BookingCart, type BookingCartView } from './BookingCart';
import { resolveCartLinePrice, type BookingCartLine } from './bookingCartModel';
import { MemberMultiSelect } from './MemberMultiSelect';
import { ProductPicker } from './ProductPicker';
import { getBookableCategories } from './bookable';
import { KioskScanner } from './KioskScanner';
import { clearKioskProductFromUrl, parseKioskBookingLink } from './kioskDeepLink';
import { resolveKioskScan } from './kioskScan';
import { useScanInteractionGuard } from './useScanInteractionGuard';
import styles from './BookingPage.module.css';

const BOOKING_CONFIRMATION_DURATION_MS = 1_200;
const UNKNOWN_SCAN_FEEDBACK_DURATION_MS = 4_000;

/** Properties accepted by the loaded booking workspace. */
interface BookingWorkspaceProps {
  groupId: string;
  categories: Category[];
  context: BookingContext;
  compact: boolean;
  canUseKiosk: boolean;
}

/**
 * Renders the loaded recipient-first catalog and multi-product booking cart.
 *
 * @param props - Permission-filtered booking context and active catalog.
 * @returns A responsive booking workspace with one atomic submit action.
 */
function BookingWorkspace({ groupId, categories, context, compact, canUseKiosk }: BookingWorkspaceProps) {
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
  const [cartView, setCartView] = useState<BookingCartView>('details');
  const [priceEntryRequest, setPriceEntryRequest] = useState<{ productId: string; requestId: number }>();
  const [confirmation, setConfirmation] = useState('');
  const [cartLimitError, setCartLimitError] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [initialScanKey, setInitialScanKey] = useState<string>();
  const bookingInFlightRef = useRef(false);
  const interactionGuard = useScanInteractionGuard();
  const isScanBlocked = () => bookingInFlightRef.current || interactionGuard.isBlocked();
  const [scanOpening, setScanOpening] = useState(false);
  const [scannerOpenError, setScannerOpenError] = useState('');
  const [scanFeedback, setScanFeedback] = useState('');
  const [scanFeedbackTone, setScanFeedbackTone] = useState<'default' | 'error'>('default');
  const [scanSuccess, setScanSuccess] = useState<{ id: number; message: string } | null>(null);
  const [scanCategories, setScanCategories] = useState<Category[] | null>(null);
  const consumedLinkRef = useRef(false);
  const scanSuccessIdRef = useRef(0);
  const targetSelectionTouchedRef = useRef(false);
  const confirmationTimerRef = useRef<number | undefined>(undefined);
  const scanFeedbackTimerRef = useRef<number | undefined>(undefined);
  const priceEntryRequestIdRef = useRef(0);
  const availableTargetIds = new Set(context.targets.map((target) => target.membershipId));
  const targetsById = new Map(context.targets.map((target) => [target.membershipId, target]));
  const targetMembershipIds = requestedTargetMembershipIds.filter((membershipId) => availableTargetIds.has(membershipId));
  const targetCount = targetMembershipIds.length + temporaryGuestDisplayNames.length;
  const hasForeignBooking = targetMembershipIds.some((membershipId) => membershipId !== context.currentMembership.id && !targetsById.get(membershipId)?.isTemporaryGuest);
  const hasOwnBooking = targetMembershipIds.includes(context.currentMembership.id);
  const reasonContext = hasForeignBooking ? 'FOREIGN' : hasOwnBooking ? 'OWN' : 'OFF';
  const reasonMode = hasForeignBooking ? context.foreignBookingReasonMode : hasOwnBooking ? context.ownBookingReasonMode : 'OFF';
  const balanceLabel = formatMoney(context.ownBalance);
  const balanceLengthClass = balanceLabel.length > 10 ? styles.balanceAmountCompact : balanceLabel.length > 8 ? styles.balanceAmountReduced : '';
  const showKioskAction = canUseKiosk && !scanOpen;
  const bookingActionCount = Number(canAssignOthers) + Number(showKioskAction);
  useEffect(() => () => {
    if (confirmationTimerRef.current !== undefined) window.clearTimeout(confirmationTimerRef.current);
    if (scanFeedbackTimerRef.current !== undefined) window.clearTimeout(scanFeedbackTimerRef.current);
  }, []);

  const clearScanFeedbackTimer = useCallback(() => {
    if (scanFeedbackTimerRef.current !== undefined) window.clearTimeout(scanFeedbackTimerRef.current);
    scanFeedbackTimerRef.current = undefined;
  }, []);

  const resetWorkspace = () => {
    setLines([]);
    setRequestedTargetMembershipIds(initialTargetMembershipIds);
    setTemporaryGuestDisplayNames([]);
    targetSelectionTouchedRef.current = false;
    setReason('');
    setCartView('details');
    setPriceEntryRequest(undefined);
  };

  const bookingMutation = useMutation({
    mutationFn: (draft: Parameters<typeof api.createBulkBookings>[1]) => api.createBulkBookings(groupId, draft),
    onError: () => { setCartView('details'); },
    onSettled: () => { bookingInFlightRef.current = false; },
    onSuccess: (createdBookings) => {
      setScanOpen(false);
      setScanSuccess(null);
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
        queryClient.invalidateQueries({ queryKey: ['activities', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['ledger', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['account-summaries', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['statistics', groupId] }),
        ...(temporaryGuestDisplayNames.length > 0 ? [queryClient.invalidateQueries({ queryKey: ['members', groupId] })] : []),
      ]);
    },
  });

  /** Snapshots the validated draft and synchronously locks scan adoption until settlement. */
  const submitBooking = () => {
    if (bookingInFlightRef.current) return;
    bookingInFlightRef.current = true;
    bookingMutation.mutate({
      expectedPeriodId: context.openPeriod.id,
      items: lines.map((line) => ({
        productId: line.product.id,
        productVersion: line.product.version,
        quantity: line.quantity,
        unitPrice: line.product.pricingMode === 'USER_DEFINED' ? resolveCartLinePrice(line) : undefined,
      })),
      targetMembershipIds,
      ...(temporaryGuestDisplayNames.length > 0 ? { temporaryGuestDisplayNames } : {}),
      reason: reasonMode !== 'OFF' ? reason.trim() || undefined : undefined,
    });
  };

  const addProduct = useCallback((product: Product, fromScanner = false) => {
    if (bookingInFlightRef.current) return;
    if (product.pricingMode === 'USER_DEFINED') {
      priceEntryRequestIdRef.current += 1;
      setPriceEntryRequest({ productId: product.id, requestId: priceEntryRequestIdRef.current });
    }
    const existing = lines.some((line) => line.product.id === product.id);
    if (existing) {
      if (compact) setCartView(product.pricingMode === 'USER_DEFINED' ? 'details' : 'peek');
      setLines((current) => current.map((line) => line.product.id === product.id ? { ...line, quantity: Math.min(99, line.quantity + 1) } : line));
      return;
    }
    if (lines.length >= 25) {
      setCartLimitError(t('booking.tooManyProducts'));
      if (compact) setCartView('details');
      return;
    }
    if (compact) setCartView(product.pricingMode === 'USER_DEFINED' || (!fromScanner && lines.length === 0) ? 'details' : 'peek');
    setCartLimitError('');
    setLines((current) => [...current, { product, quantity: 1, unitPriceInput: '', unitPriceTouched: false }]);
  }, [compact, lines, t]);

  /**
   * Records a localized product confirmation while leaving decoding active.
   *
   * @param message - Product-specific announcement shown over the camera.
   * @returns Nothing; the latest confirmation replaces the previous one.
   */
  const showScanSuccess = useCallback((message: string) => {
    clearScanFeedbackTimer();
    scanSuccessIdRef.current += 1;
    setScanSuccess({ id: scanSuccessIdRef.current, message });
    setScanFeedback('');
    setScanFeedbackTone('default');
  }, [clearScanFeedbackTimer]);

  useEffect(() => {
    if (consumedLinkRef.current) return;
    const link = parseKioskBookingLink(window.location.href);
    if (!link?.productId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active || consumedLinkRef.current) return;
      consumedLinkRef.current = true;
      clearKioskProductFromUrl();
      if (link.groupId !== groupId) {
        setScanFeedback(t('kiosk.linkUnavailable'));
        return;
      }
      void Promise.all([api.getSession(), api.getCategories(groupId)]).then(([freshSession, freshCategories]) => {
        if (!active) return;
        const group = freshSession.groups.find((candidate) => candidate.id === groupId);
        queryClient.setQueryData(['session'], freshSession);
        queryClient.setQueryData(['categories', groupId], freshCategories);
        if (!group?.kioskEnabled || !canOpenBooking(group.membership?.effectiveGrants)) {
          setScanFeedback(t('kiosk.linkUnavailable'));
          return;
        }
        const product = getBookableCategories(freshCategories).flatMap((category) => category.products).find((candidate) => candidate.id === link.productId);
        if (!product) {
          setScanFeedback(t('kiosk.productUnavailable'));
          return;
        }
        const openLinkedScanner = Boolean(link.scan && can(group.membership?.effectiveGrants, 'USE_KIOSK'));
        addProduct(product, openLinkedScanner);
        setScanCategories(freshCategories);
        if (openLinkedScanner) {
          setInitialScanKey(`product:${product.id}`);
          setCartView('details');
          showScanSuccess(t('kiosk.added', { name: product.name }));
          setScanOpen(true);
        } else setScanFeedback(t('kiosk.added', { name: product.name }));
      }).catch(() => { if (active) setScanFeedback(t('kiosk.verifyError')); });
    });
    return () => { active = false; };
  }, [addProduct, groupId, queryClient, showScanSuccess, t]);

  const openScanner = async () => {
    setInitialScanKey(undefined);
    clearScanFeedbackTimer();
    setScannerOpenError('');
    setScanFeedback('');
    setScanFeedbackTone('default');
    setScanSuccess(null);
    setScanOpening(true);
    try {
      const [freshSession, freshCategories] = await Promise.all([api.getSession(), api.getCategories(groupId)]);
      const group = freshSession.groups.find((candidate) => candidate.id === groupId);
      queryClient.setQueryData(['session'], freshSession);
      queryClient.setQueryData(['categories', groupId], freshCategories);
      if (!group?.kioskEnabled || !can(group.membership?.effectiveGrants, 'USE_KIOSK') || !canOpenBooking(group.membership?.effectiveGrants)) {
        setScannerOpenError(t('kiosk.linkUnavailable'));
        return;
      }
      setScanCategories(freshCategories);
      if (compact && lines.length > 0) setCartView('peek');
      setScanOpen(true);
    } catch {
      setScannerOpenError(t('kiosk.verifyError'));
    } finally {
      setScanOpening(false);
    }
  };

  const returnToProducts = () => {
    clearScanFeedbackTimer();
    setScanOpen(false);
    setScanSuccess(null);
    setScanFeedback('');
    setScanFeedbackTone('default');
    if (compact && lines.length > 0) setCartView('peek');
  };

  const handleScan = (value: string, format?: import('@/api/types').ProductBarcodeFormat | 'QR_CODE') => {
    if (isScanBlocked()) return;
    const resolved = resolveKioskScan(value, groupId, scanCategories ?? categories, format);
    if (resolved.kind === 'product') {
      addProduct(resolved.product, true);
      showScanSuccess(t('kiosk.added', { name: resolved.product.name }));
    } else {
      clearScanFeedbackTimer();
      setScanSuccess(null);
      setScanFeedback(t(resolved.kind === 'group' ? 'kiosk.groupQrHint' : 'kiosk.unknownCode'));
      setScanFeedbackTone(resolved.kind === 'group' ? 'default' : 'error');
      if (resolved.kind === 'unknown') {
        scanFeedbackTimerRef.current = window.setTimeout(() => {
          scanFeedbackTimerRef.current = undefined;
          setScanFeedback('');
          setScanFeedbackTone('default');
        }, UNKNOWN_SCAN_FEEDBACK_DURATION_MS);
      }
    }
  };

  const changeLineQuantity = (productId: string, quantity: number) => {
    if (bookingInFlightRef.current) return;
    setCartLimitError('');
    setLines((current) => quantity <= 0
      ? current.filter((line) => line.product.id !== productId)
      : current.map((line) => line.product.id === productId ? { ...line, quantity } : line));
  };

  const decreaseProduct = (product: Product) => {
    const line = lines.find((item) => item.product.id === product.id);
    if (line) changeLineQuantity(product.id, line.quantity - 1);
  };

  const changeCategory = (nextCategoryId: string) => {
    setCategoryId(nextCategoryId);
    if (compact && lines.length > 0 && cartView === 'details') setCartView('peek');
  };

  const changeTargets = (membershipIds: string[]) => {
    targetSelectionTouchedRef.current = true;
	const nextHasForeignBooking = membershipIds.some((membershipId) => membershipId !== context.currentMembership.id && !targetsById.get(membershipId)?.isTemporaryGuest);
	const nextHasOwnBooking = membershipIds.includes(context.currentMembership.id);
	const nextReasonContext = nextHasForeignBooking ? 'FOREIGN' : nextHasOwnBooking ? 'OWN' : 'OFF';
    if (nextReasonContext !== reasonContext) setReason('');
    setRequestedTargetMembershipIds(membershipIds);
  };

  const addTemporaryGuest = (displayName: string) => {
    if (!targetSelectionTouchedRef.current
      && temporaryGuestDisplayNames.length === 0
      && targetMembershipIds.length === 1
      && targetMembershipIds[0] === context.currentMembership.id) {
      setRequestedTargetMembershipIds([]);
	  setReason('');
    }
    targetSelectionTouchedRef.current = true;
    setTemporaryGuestDisplayNames((current) => [...current, displayName]);
  };

  const cart = <BookingCart
    bookingReasons={context.bookingReasons}
    compact={compact}
    error={cartLimitError || (bookingMutation.isError ? bookingMutation.error.message : undefined)}
    interactionRef={interactionGuard.ref}
    lines={lines}
    onQuantityChange={changeLineQuantity}
    onReasonChange={setReason}
    onRemove={(productId) => changeLineQuantity(productId, 0)}
    onSubmit={submitBooking}
    onUnitPriceBlur={(productId) => setLines((current) => current.map((line) => line.product.id === productId ? { ...line, unitPriceTouched: true } : line))}
    onUnitPriceChange={(productId, value) => setLines((current) => current.map((line) => line.product.id === productId ? { ...line, unitPriceInput: value } : line))}
    onViewChange={setCartView}
    pending={bookingMutation.isPending}
    priceEntryRequest={priceEntryRequest}
    reason={reason}
    reasonMode={reasonMode}
    targetCount={targetCount}
    view={cartView}
  />;

  return (
    <div className={`${styles.layout} ${lines.length > 0 ? styles.hasCart : ''} ${cartView === 'peek' ? styles.hasPeekCart : ''}`}>
      <section className={`${styles.content} ${scanOpen && !compact ? styles.scannerContent : ''}`}>
        {!scanOpen || compact ? <>
        <div className={styles.titleRow}>
          <h1>{t('booking.quickTitle')}</h1>
        </div>
        {scannerOpenError ? <p className={styles.kioskError} role="alert">{scannerOpenError}</p> : null}
        <div className={`${styles.balanceRow} ${bookingActionCount > 0 ? styles.hasActions : ''} ${bookingActionCount > 1 ? styles.hasTwoActions : ''}`}>
          <div className={styles.balance}>
            <div className={styles.balanceAmount}><span>{t('booking.openBalance')}</span><strong className={`${isCreditBalance(context.ownBalance) ? styles.creditBalance : ''} ${balanceLengthClass}`} data-financial-state={isCreditBalance(context.ownBalance) ? 'credit' : 'due'} title={balanceLabel}>{balanceLabel}</strong></div>
          </div>
          {bookingActionCount > 0 ? <div className={styles.bookingActions}>
            {canAssignOthers ? <div className={styles.targetControl}>
              <MemberMultiSelect
                canBookForGuests={context.canBookForGuests}
                currentMembershipId={context.currentMembership.id}
                disabled={context.targets.length === 0 && !context.canBookForGuests}
                id="booking-member"
                iconOnly
                label={t('booking.targetButtonLabel', { count: targetCount })}
                iconLabel={t('booking.members')}
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
            {showKioskAction ? <Button className={styles.bookingAction} disabled={scanOpening} leadingIcon={<ScanLine size={28} />} onClick={() => { void openScanner(); }} size="small" variant="secondary">{t('kiosk.scannerTitle')}</Button> : null}
          </div> : null}
        </div>

        {confirmation ? <div className={styles.confirmation} role="status"><CheckCircle2 aria-hidden="true" size={22} /> {confirmation}</div> : null}

        {scanFeedback && !scanOpen ? <p className={styles.kioskFeedback} role="status">{scanFeedback}</p> : null}
        </> : null}
        {scanOpen ? <KioskScanner cart={compact && lines.length > 0 ? cart : undefined} cartExpanded={compact && lines.length > 0 && cartView === 'details'} embedded={!compact} feedback={scanFeedback} feedbackTone={scanFeedbackTone} initialScanKey={initialScanKey} isScanBlocked={isScanBlocked} resolveScanKey={(value, format) => {
          const resolved = resolveKioskScan(value, groupId, scanCategories ?? categories, format);
          return resolved.kind === 'product' ? `product:${resolved.product.id}` : undefined;
        }} onClose={returnToProducts} onCollapseCart={() => setCartView('peek')} onScan={handleScan} success={scanSuccess} /> : null}

        {!scanOpen || compact ? <ProductPicker
          categories={bookableCategories}
          layout="rows"
          onCategoryChange={changeCategory}
          onProductDecrease={decreaseProduct}
          onProductSelect={addProduct}
          productQuantities={Object.fromEntries(lines.map((line) => [line.product.id, line.quantity]))}
          selectedCategoryId={categoryId}
          selectedProductIds={lines.map((line) => line.product.id)}
        /> : null}
      </section>
      {!scanOpen || !compact ? <aside aria-label={t('booking.cartTitle')} className={styles.inspector}>{cart}</aside> : null}
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
  const { activeGroupId, activeGroup, session } = useActiveGroup();
  const linkedGroupId = parseKioskBookingLink(window.location.href)?.groupId;
  const unavailableLinkedGroup = new URLSearchParams(window.location.search).has('group') && (!linkedGroupId || !session.groups.some((group) => group.id === linkedGroupId));
  const awaitingGroupSwitch = linkedGroupId !== undefined && linkedGroupId !== activeGroupId && session.groups.some((group) => group.id === linkedGroupId);
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId), enabled: !awaitingGroupSwitch && !unavailableLinkedGroup });
  const bookingContextQuery = useQuery({ queryKey: ['booking-context', activeGroupId], queryFn: () => api.getBookingContext(activeGroupId, activeGroup.currency), enabled: !awaitingGroupSwitch && !unavailableLinkedGroup });
  const compact = useMediaQuery('(max-width: 767px)');

  if (unavailableLinkedGroup) return <div className={styles.state}><StatePanel kind="empty" message={t('kiosk.groupUnavailable')} title={t('booking.noAccessTitle')} /></div>;
  if (awaitingGroupSwitch) return <div className={styles.state}><StatePanel kind="loading" /></div>;
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

  const kioskEnabled = activeGroup.kioskEnabled === true;
  const canUseKiosk = kioskEnabled && can(activeGroup.membership?.effectiveGrants, 'USE_KIOSK') && canOpenBooking(activeGroup.membership?.effectiveGrants);
  return <BookingWorkspace canUseKiosk={canUseKiosk} categories={categoriesQuery.data} compact={compact} context={bookingContextQuery.data} groupId={activeGroupId} key={activeGroupId} />;
}
