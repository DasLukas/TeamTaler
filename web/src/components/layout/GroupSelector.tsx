import { useMemo } from 'react';
import type { Group } from '@/api/types';
import { GroupMark } from '@/components/ui/GroupMark';
import { SelectMenu, type SelectMenuOption } from '@/components/ui/SelectMenu';
import styles from './GroupSelector.module.css';

/** Properties accepted by the shared responsive group selector. */
export interface GroupSelectorProps {
  ariaLabel: string;
  className?: string;
  compact?: boolean;
  groups: readonly Group[];
  id: string;
  onChange: (groupId: string) => void;
  responsiveCompact?: boolean;
  value: string;
}

/** Renders one logo-or-initial group identity inside the selector. */
function GroupChoice({ group }: { group: Group }) {
  return (
    <span className={styles.choice}>
      <GroupMark className={styles.mark} decorative imageUrl={group.logoUrl} name={group.name} />
      <span className={styles.label}>{group.name}</span>
    </span>
  );
}

/**
 * Renders the application-wide custom group dropdown.
 *
 * @param props - Available groups, selected ID, change callback, control labels,
 * and responsive compact presentation flags.
 * @returns A keyboard-operable group combobox with logo and initial fallbacks.
 */
export function GroupSelector({ ariaLabel, className = '', compact = false, groups, id, onChange, responsiveCompact = false, value }: GroupSelectorProps) {
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const options = useMemo<readonly SelectMenuOption[]>(() => groups.map((group) => ({ value: group.id, label: group.name })), [groups]);
  const renderChoice = (option: SelectMenuOption) => {
    const group = groupsById.get(option.value);
    return group ? <GroupChoice group={group} /> : option.label;
  };

  return (
    <SelectMenu
      ariaLabel={ariaLabel}
      className={`${styles.selector} ${compact ? styles.compact : ''} ${responsiveCompact ? styles.responsiveCompact : ''} ${className}`}
      id={id}
      menuMinWidth={240}
      onChange={onChange}
      options={options}
      renderOption={(option) => renderChoice(option)}
      renderValue={renderChoice}
      title={groupsById.get(value)?.name}
      value={value}
    />
  );
}
