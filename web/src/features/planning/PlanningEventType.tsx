import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import UserRoundPlus from 'lucide-react/dist/esm/icons/user-round-plus';
import type { ComponentType, SVGProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanningEventType } from '@/api/types';
import { SelectMenu, type SelectMenuOption } from '@/components/ui/SelectMenu';
import styles from './Planning.module.css';

type EventTypeIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

const eventTypeIcons: Record<PlanningEventType, EventTypeIcon> = {
  APPOINTMENT: CalendarDays,
  APPOINTMENT_POLL: ListChecks,
  APPOINTMENT_REGISTRATION: UserRoundPlus,
};

const eventTypes = Object.keys(eventTypeIcons) as PlanningEventType[];

/**
 * Renders the canonical visual marker for one planning event type.
 *
 * @param props - Stable planning type, optional size, and decorative state.
 * @returns The Lucide icon assigned to the planning type across the app.
 */
export function PlanningEventTypeIcon({ decorative = true, size = 18, type }: { decorative?: boolean; size?: number; type: PlanningEventType }) {
  const Icon = eventTypeIcons[type];
  return <Icon aria-hidden={decorative || undefined} focusable="false" size={size} />;
}

/**
 * Renders the accessible custom single-select used to choose a planning type.
 *
 * @param props - Control identity, selected type, lock state, and change callback.
 * @returns A keyboard-operable icon and label dropdown.
 */
export function PlanningEventTypeSelect({ disabled = false, id, onChange, value }: { disabled?: boolean; id: string; onChange: (value: PlanningEventType) => void; value: PlanningEventType }) {
  const { t } = useTranslation();
  const options: SelectMenuOption<PlanningEventType>[] = eventTypes.map((type) => ({
    label: t(`planning.types.${type}`),
    value: type,
    visual: <span className={`${styles.eventTypeIcon} ${styles[`eventTypeIcon_${type}`]}`}><PlanningEventTypeIcon type={type} /></span>,
  }));
  return <SelectMenu disabled={disabled} id={id} onChange={onChange} options={options} value={value} />;
}

/**
 * Renders a consistent icon-and-label marker for a planning event type.
 *
 * @param props - Planning type and an optional compact presentation.
 * @returns A translated event-type marker for calendars, cards, and details.
 */
export function PlanningEventTypeBadge({ compact = false, type }: { compact?: boolean; type: PlanningEventType }) {
  const { t } = useTranslation();
  return <span className={`${styles.eventTypeBadge} ${compact ? styles.eventTypeBadgeCompact : ''}`}>
    <span className={`${styles.eventTypeIcon} ${styles[`eventTypeIcon_${type}`]}`}><PlanningEventTypeIcon size={compact ? 14 : 17} type={type} /></span>
    <span>{t(`planning.types.${type}`)}</span>
  </span>;
}
