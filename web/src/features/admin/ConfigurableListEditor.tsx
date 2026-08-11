import ArrowDown from 'lucide-react/dist/esm/icons/arrow-down';
import ArrowUp from 'lucide-react/dist/esm/icons/arrow-up';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigurableItem } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/FormField';
import styles from './ConfigurableListEditor.module.css';

/** Properties for an accessible ordered option-list editor. */
interface ConfigurableListEditorProps {
  items: ConfigurableItem[];
  label: string;
  addLabel: string;
  emptyLabel: string;
  minimumItems?: number;
  onChange: (items: ConfigurableItem[]) => void;
}

/**
 * Edits an ordered list with explicit keyboard-accessible move controls.
 *
 * @param props - Current items, localized labels, minimum size, and update callback.
 * @returns An add field and ordered rows with move and remove actions.
 */
export function ConfigurableListEditor({ items, label, addLabel, emptyLabel, minimumItems = 0, onChange }: ConfigurableListEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const add = () => {
    const normalized = draft.trim();
    if (!normalized || items.some((item) => item.label.localeCompare(normalized, undefined, { sensitivity: 'accent' }) === 0)) return;
    onChange([...items, { id: `opt_${crypto.randomUUID()}`, label: normalized }]);
    setDraft('');
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const rename = (index: number, value: string) => {
    onChange(items.map((item, itemIndex) => itemIndex === index ? { ...item, label: value } : item));
  };

  return <section aria-label={label} className={styles.editor}>
    <h4>{label}</h4>
    <div className={styles.addRow}>
      <TextInput aria-label={addLabel} maxLength={120} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} value={draft} />
      <Button disabled={!draft.trim()} leadingIcon={<Plus size={16} />} onClick={add} size="small" type="button" variant="secondary">{addLabel}</Button>
    </div>
    {items.length === 0 ? <p className={styles.empty}>{emptyLabel}</p> : <ol className={styles.list}>
      {items.map((item, index) => <li className={styles.item} key={item.id}>
        <TextInput aria-label={t('behaviorSettings.editOption', { name: item.label || label })} maxLength={120} onBlur={(event) => rename(index, event.target.value.trim())} onChange={(event) => rename(index, event.target.value)} value={item.label} />
        <div className={styles.actions}>
          <Button aria-label={t('behaviorSettings.moveUp', { name: item.label })} disabled={index === 0} onClick={() => move(index, -1)} size="small" type="button" variant="ghost"><ArrowUp size={16} /></Button>
          <Button aria-label={t('behaviorSettings.moveDown', { name: item.label })} disabled={index === items.length - 1} onClick={() => move(index, 1)} size="small" type="button" variant="ghost"><ArrowDown size={16} /></Button>
          <Button aria-label={t('behaviorSettings.removeOption', { name: item.label })} disabled={items.length <= minimumItems} onClick={() => onChange(items.filter((candidate) => candidate.id !== item.id))} size="small" type="button" variant="ghost"><Trash2 size={16} /></Button>
        </div>
      </li>)}
    </ol>}
  </section>;
}
