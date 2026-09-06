import Calendar from 'lucide-react/dist/esm/icons/calendar';
import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import CalendarRange from 'lucide-react/dist/esm/icons/calendar-range';
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import List from 'lucide-react/dist/esm/icons/list';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { PlanningView } from './planningSearch';
import styles from './Planning.module.css';

const views = [
  { icon: Calendar, value: 'day' },
  { icon: CalendarRange, value: 'week' },
  { icon: CalendarDays, value: 'month' },
  { icon: List, value: 'agenda' },
] as const;

/** Properties accepted by the planning period and view toolbar. */
export interface PlanningToolbarProps {
  label: string;
  onMove: (offset: -1 | 1) => void;
  onToday: () => void;
  onViewChange: (view: PlanningView) => void;
  view: PlanningView;
}

/** Renders period navigation and the four-view segmented control. */
export function PlanningToolbar({ label, onMove, onToday, onViewChange, view }: PlanningToolbarProps) {
  const { t } = useTranslation();
  const previousKey = view === 'day' ? 'planning.previousDay' : view === 'week' ? 'planning.previousWeek' : view === 'month' ? 'planning.previousMonth' : 'planning.previousPeriod';
  const nextKey = view === 'day' ? 'planning.nextDay' : view === 'week' ? 'planning.nextWeek' : view === 'month' ? 'planning.nextMonth' : 'planning.nextPeriod';
  return <div className={styles.toolbar}>
    <div className={styles.periodNavigation}>
      <Button aria-label={t(previousKey)} iconOnly leadingIcon={<ChevronLeft size={18} />} onClick={() => onMove(-1)} variant="secondary">{t(previousKey)}</Button>
      <strong aria-live="polite">{label}</strong>
      <Button aria-label={t(nextKey)} iconOnly leadingIcon={<ChevronRight size={18} />} onClick={() => onMove(1)} variant="secondary">{t(nextKey)}</Button>
      <Button aria-label={t('planning.today')} collapseLabelAt="narrow" leadingIcon={<CalendarDays size={17} />} onClick={onToday} size="small" variant="ghost">{t('planning.today')}</Button>
    </div>
    <div aria-label={t('planning.view')} className={styles.viewSwitch} role="group">
      {views.map(({ icon: Icon, value }) => <Button aria-label={t(`planning.${value}`)} aria-pressed={view === value} collapseLabelAt="narrow" key={value} leadingIcon={<Icon size={16} />} onClick={() => onViewChange(value)} size="small" variant={view === value ? 'primary' : 'secondary'}>{t(`planning.${value}`)}</Button>)}
    </div>
  </div>;
}
