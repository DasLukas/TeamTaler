import ArrowDown from 'lucide-react/dist/esm/icons/arrow-down';
import ArrowUp from 'lucide-react/dist/esm/icons/arrow-up';
import FileCheck2 from 'lucide-react/dist/esm/icons/file-check-2';
import FilePlus2 from 'lucide-react/dist/esm/icons/file-plus-2';
import FileX2 from 'lucide-react/dist/esm/icons/file-x-2';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AttachmentMode, PaymentMethod, PaymentTarget } from '@/api/types';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { IconButton } from '@/components/ui/IconButton';
import { SelectMenu, type SelectMenuOption } from '@/components/ui/SelectMenu';
import { isBicRequiredForIban, isValidBic, isValidIban, normalizeBic, normalizeIban, normalizePaypalMeHandle } from '@/features/finance/paymentTargets';
import styles from './PaymentMethodEditor.module.css';

type PaymentTargetChoice = 'NONE' | PaymentTarget['type'];

/** Properties for the ordered payment-method, receipt-policy, and destination editor. */
interface PaymentMethodEditorProps {
  items: PaymentMethod[];
  label: string;
  addLabel: string;
  emptyLabel: string;
  currency: string;
  onChange: (items: PaymentMethod[]) => void;
}

const attachmentModeIcons = {
  OFF: FileX2,
  OPTIONAL: FilePlus2,
  REQUIRED: FileCheck2,
} satisfies Record<AttachmentMode, typeof FileX2>;

function renderAttachmentMode(option: SelectMenuOption<AttachmentMode>) {
  const Icon = attachmentModeIcons[option.value];
  return <span className={styles.modeChoice} data-mode={option.value}><Icon aria-hidden="true" size={18} /><span>{option.label}</span></span>;
}

/**
 * Edits ordered payment methods together with receipt and external-payment settings.
 *
 * @param props - Current methods, active currency, labels, and immutable update callback.
 * @returns An accessible editor whose conditional target fields travel with each method.
 */
export function PaymentMethodEditor({ items, label, addLabel, emptyLabel, currency, onChange }: PaymentMethodEditorProps) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const targetDescriptionId = useId();
  const [draft, setDraft] = useState('');
  const add = () => {
    const normalized = draft.trim();
    if (!normalized || items.some((item) => item.label.localeCompare(normalized, undefined, { sensitivity: 'accent' }) === 0)) return;
    onChange([...items, { id: `opt_${crypto.randomUUID()}`, label: normalized, attachmentMode: 'OFF', paymentTarget: null }]);
    setDraft('');
  };
  const update = (index: number, change: Partial<PaymentMethod>) => {
    onChange(items.map((item, itemIndex) => itemIndex === index ? { ...item, ...change } : item));
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const changeTargetType = (index: number, choice: PaymentTargetChoice) => {
    const paymentTarget: PaymentTarget | null = choice === 'PAYPAL_ME'
      ? { type: 'PAYPAL_ME', paypalMeHandle: '' }
      : choice === 'SEPA_TRANSFER'
        ? { type: 'SEPA_TRANSFER', recipientName: '', iban: '' }
        : null;
    update(index, { paymentTarget });
  };
  const methodLabel = t('behaviorSettings.paymentMethodLabel');
  const modeLabel = t('behaviorSettings.attachmentModeLabel');
  const targetLabel = t('behaviorSettings.paymentTargetLabel');
  const modeOptions: readonly SelectMenuOption<AttachmentMode>[] = [
    { value: 'OFF', label: t('behaviorSettings.attachmentModeOff') },
    { value: 'OPTIONAL', label: t('behaviorSettings.attachmentModeOptional') },
    { value: 'REQUIRED', label: t('behaviorSettings.attachmentModeRequired') },
  ];

  return <section aria-label={label} className={styles.editor}>
    <h4>{label}</h4>
    <div className={styles.descriptions}>
      <p className={styles.description} id={descriptionId}>{t('behaviorSettings.attachmentModeDescription')}</p>
      <p className={styles.description} id={targetDescriptionId}>{t('behaviorSettings.paymentTargetDescription')}</p>
    </div>
    <div className={styles.addRow}>
      <TextInput aria-label={addLabel} maxLength={120} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} value={draft} />
      <IconButton className={styles.addButton} disabled={!draft.trim()} label={addLabel} onClick={add} type="button" variant="surface"><Plus aria-hidden="true" size={18} /></IconButton>
    </div>
    {items.length === 0 ? <p className={styles.empty}>{emptyLabel}</p> : <ol className={styles.list}>
      <li aria-hidden="true" className={styles.columnHeaders}>
        <span>{methodLabel}</span>
        <span>{modeLabel}</span>
        <span />
      </li>
      {items.map((item, index) => {
        const sepaTarget = item.paymentTarget?.type === 'SEPA_TRANSFER' ? item.paymentTarget : null;
        const targetChoice: PaymentTargetChoice = item.paymentTarget?.type ?? 'NONE';
        const paypalHandle = item.paymentTarget?.type === 'PAYPAL_ME' ? normalizePaypalMeHandle(item.paymentTarget.paypalMeHandle) : null;
        const paypalError = item.paymentTarget?.type === 'PAYPAL_ME' && !paypalHandle ? t('behaviorSettings.paypalMeHandleInvalid') : '';
        const recipientError = sepaTarget && (!sepaTarget.recipientName.trim() || Array.from(sepaTarget.recipientName.trim()).length > 70)
          ? t('behaviorSettings.sepaRecipientInvalid')
          : '';
        const ibanValid = Boolean(sepaTarget && isValidIban(sepaTarget.iban));
        const ibanError = sepaTarget && !ibanValid ? t('behaviorSettings.sepaIbanInvalid') : '';
        const bic = sepaTarget?.bic ?? '';
        const bicError = sepaTarget && !isValidBic(bic)
          ? t('behaviorSettings.sepaBicInvalid')
          : sepaTarget && ibanValid && isBicRequiredForIban(sepaTarget.iban) && !bic.trim()
            ? t('behaviorSettings.sepaBicRequired')
            : '';
        const targetOptions: Array<{ value: PaymentTargetChoice; label: string }> = [
          { value: 'NONE', label: t('behaviorSettings.paymentTargetNone') },
          { value: 'PAYPAL_ME', label: t('behaviorSettings.paymentTargetPaypal') },
          ...(currency === 'EUR' ? [{ value: 'SEPA_TRANSFER' as const, label: t('behaviorSettings.paymentTargetSepa') }] : []),
        ];
        const prefix = `payment-method-${item.id}`;
        return <li className={styles.item} key={item.id}>
          <div className={styles.mainRow}>
            <TextInput aria-label={t('behaviorSettings.editOption', { name: item.label || label })} maxLength={120} onBlur={(event) => update(index, { label: event.target.value.trim() })} onChange={(event) => update(index, { label: event.target.value })} value={item.label} />
            <SelectMenu
              ariaDescribedBy={descriptionId}
              ariaLabel={`${modeLabel}: ${item.label}`}
              className={styles.modeControl}
              id={`${prefix}-attachment`}
              menuMinWidth={240}
              onChange={(attachmentMode) => update(index, { attachmentMode })}
              options={modeOptions}
              renderOption={renderAttachmentMode}
              renderValue={renderAttachmentMode}
              value={item.attachmentMode}
            />
            <div className={styles.actions}>
              <IconButton disabled={index === 0} label={t('behaviorSettings.moveUp', { name: item.label })} onClick={() => move(index, -1)} type="button"><ArrowUp size={16} /></IconButton>
              <IconButton disabled={index === items.length - 1} label={t('behaviorSettings.moveDown', { name: item.label })} onClick={() => move(index, 1)} type="button"><ArrowDown size={16} /></IconButton>
              <IconButton disabled={items.length <= 1} label={t('behaviorSettings.removeOption', { name: item.label })} onClick={() => onChange(items.filter((candidate) => candidate.id !== item.id))} type="button"><Trash2 size={16} /></IconButton>
            </div>
          </div>
          <div aria-label={`${item.label}: ${targetLabel}`} className={styles.targetPanel} role="group">
            <Field hint={currency !== 'EUR' ? t('behaviorSettings.sepaEuroOnly') : undefined} htmlFor={`${prefix}-target`} label={targetLabel} messageId={`${prefix}-target-description`}>
              <SelectInput aria-describedby={`${targetDescriptionId}${currency !== 'EUR' ? ` ${prefix}-target-description` : ''}`} id={`${prefix}-target`} onChange={(event) => changeTargetType(index, event.target.value as PaymentTargetChoice)} value={targetChoice}>
                {targetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </SelectInput>
            </Field>
            {item.paymentTarget?.type === 'PAYPAL_ME' ? <div className={styles.targetFields}>
              <Field error={paypalError || undefined} htmlFor={`${prefix}-paypal`} label={t('behaviorSettings.paypalMeHandle')} messageId={`${prefix}-paypal-error`}>
                <TextInput aria-describedby={paypalError ? `${prefix}-paypal-error` : undefined} aria-invalid={Boolean(paypalError)} autoCapitalize="none" id={`${prefix}-paypal`} maxLength={120} onBlur={(event) => { const normalized = normalizePaypalMeHandle(event.target.value); update(index, { paymentTarget: { type: 'PAYPAL_ME', paypalMeHandle: normalized ?? event.target.value.trim() } }); }} onChange={(event) => update(index, { paymentTarget: { type: 'PAYPAL_ME', paypalMeHandle: event.target.value } })} placeholder="paypal.me/YourHandle" spellCheck={false} value={item.paymentTarget.paypalMeHandle} />
              </Field>
              {paypalHandle ? <a className={styles.previewLink} href={`https://paypal.me/${paypalHandle}`} rel="noopener noreferrer" target="_blank">https://paypal.me/{paypalHandle}</a> : null}
            </div> : null}
            {sepaTarget ? <div className={`${styles.targetFields} ${styles.sepaFields}`}>
              <Field error={recipientError || undefined} htmlFor={`${prefix}-recipient`} label={t('behaviorSettings.sepaRecipient')} messageId={`${prefix}-recipient-error`}>
                <TextInput aria-describedby={recipientError ? `${prefix}-recipient-error` : undefined} aria-invalid={Boolean(recipientError)} id={`${prefix}-recipient`} maxLength={70} onBlur={(event) => update(index, { paymentTarget: { ...sepaTarget, recipientName: event.target.value.trim() } })} onChange={(event) => update(index, { paymentTarget: { ...sepaTarget, recipientName: event.target.value } })} value={sepaTarget.recipientName} />
              </Field>
              <Field error={ibanError || undefined} htmlFor={`${prefix}-iban`} label={t('behaviorSettings.sepaIban')} messageId={`${prefix}-iban-error`}>
                <TextInput aria-describedby={ibanError ? `${prefix}-iban-error` : undefined} aria-invalid={Boolean(ibanError)} autoCapitalize="characters" id={`${prefix}-iban`} maxLength={42} onBlur={(event) => update(index, { paymentTarget: { ...sepaTarget, iban: normalizeIban(event.target.value) } })} onChange={(event) => update(index, { paymentTarget: { ...sepaTarget, iban: event.target.value } })} spellCheck={false} value={sepaTarget.iban} />
              </Field>
              <Field error={bicError || undefined} htmlFor={`${prefix}-bic`} label={t('behaviorSettings.sepaBic')} messageId={`${prefix}-bic-error`}>
                <TextInput aria-describedby={bicError ? `${prefix}-bic-error` : undefined} aria-invalid={Boolean(bicError)} autoCapitalize="characters" id={`${prefix}-bic`} maxLength={14} onBlur={(event) => { const bic = normalizeBic(event.target.value); update(index, { paymentTarget: { ...sepaTarget, bic: bic || undefined } }); }} onChange={(event) => update(index, { paymentTarget: { ...sepaTarget, bic: event.target.value } })} spellCheck={false} value={sepaTarget.bic ?? ''} />
              </Field>
            </div> : null}
          </div>
        </li>;
      })}
    </ol>}
  </section>;
}
