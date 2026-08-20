import ArrowDown from 'lucide-react/dist/esm/icons/arrow-down';
import ArrowUp from 'lucide-react/dist/esm/icons/arrow-up';
import FileCheck2 from 'lucide-react/dist/esm/icons/file-check-2';
import FilePlus2 from 'lucide-react/dist/esm/icons/file-plus-2';
import FileX2 from 'lucide-react/dist/esm/icons/file-x-2';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AttachmentMode, PaymentMethod } from '@/api/types';
import { TextInput } from '@/components/ui/FormField';
import { IconButton } from '@/components/ui/IconButton';
import { SelectMenu, type SelectMenuOption } from '@/components/ui/SelectMenu';
import styles from './PaymentMethodEditor.module.css';

/** Properties for the ordered payment-method and receipt-policy editor. */
interface PaymentMethodEditorProps {
  items: PaymentMethod[];
  label: string;
  addLabel: string;
  emptyLabel: string;
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

/** Edits payment methods together with their immutable receipt requirement policy. */
export function PaymentMethodEditor({ items, label, addLabel, emptyLabel, onChange }: PaymentMethodEditorProps) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const [draft, setDraft] = useState('');
  const add = () => {
    const normalized = draft.trim();
    if (!normalized || items.some((item) => item.label.localeCompare(normalized, undefined, { sensitivity: 'accent' }) === 0)) return;
    onChange([...items, { id: `opt_${crypto.randomUUID()}`, label: normalized, attachmentMode: 'OFF' }]);
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
  const methodLabel = t('behaviorSettings.paymentMethodLabel', { defaultValue: 'Payment method' });
  const modeLabel = t('behaviorSettings.attachmentModeLabel', { defaultValue: 'Receipt when paying' });
  const modeOptions: readonly SelectMenuOption<AttachmentMode>[] = [
    { value: 'OFF', label: t('behaviorSettings.attachmentModeOff', { defaultValue: 'No receipt' }) },
    { value: 'OPTIONAL', label: t('behaviorSettings.attachmentModeOptional', { defaultValue: 'Receipt optional' }) },
    { value: 'REQUIRED', label: t('behaviorSettings.attachmentModeRequired', { defaultValue: 'Receipt required' }) },
  ];

  return <section aria-label={label} className={styles.editor}>
    <h4>{label}</h4>
    <p className={styles.description} id={descriptionId}>
      {t('behaviorSettings.attachmentModeDescription', { defaultValue: 'Choose whether members can or must add a receipt when using each payment method.' })}
    </p>
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
      {items.map((item, index) => <li className={styles.item} key={item.id}>
        <TextInput aria-label={t('behaviorSettings.editOption', { name: item.label || label })} maxLength={120} onBlur={(event) => update(index, { label: event.target.value.trim() })} onChange={(event) => update(index, { label: event.target.value })} value={item.label} />
        <SelectMenu
          ariaDescribedBy={descriptionId}
          ariaLabel={`${modeLabel}: ${item.label}`}
          className={styles.modeControl}
          id={`payment-method-attachment-${index}`}
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
      </li>)}
    </ol>}
  </section>;
}
