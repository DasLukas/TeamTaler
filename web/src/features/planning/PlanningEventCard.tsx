import { Link } from '@tanstack/react-router';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import MapPin from 'lucide-react/dist/esm/icons/map-pin';
import Repeat2 from 'lucide-react/dist/esm/icons/repeat-2';
import UsersRound from 'lucide-react/dist/esm/icons/users-round';
import { useTranslation } from 'react-i18next';
import type { PlanningEvent } from '@/api/types';
import { ParticipationAction } from './ParticipationAction';
import { PlanningEventTypeIcon } from './PlanningEventType';
import type { PlanningSearch } from './planningSearch';
import { formatPlanningEventTime } from './planningTiming';
import styles from './Planning.module.css';

/** Properties accepted by a compact calendar agenda card. */
export interface PlanningEventCardProps {
  className?: string;
  event: PlanningEvent;
  navigationSearch: PlanningSearch;
  scheduleLabel?: string;
  showParticipation?: boolean;
  timeZone: string;
}

/** Renders a linked planning occurrence with its compact participation action. */
export function PlanningEventCard({ className = '', event, navigationSearch, scheduleLabel, showParticipation = true, timeZone }: PlanningEventCardProps) {
  const { t } = useTranslation();
  const eventTypeLabel = t(`planning.types.${event.eventType}`);
  const eventTime = scheduleLabel ?? formatPlanningEventTime(event, timeZone, t('planning.allDay'));
  return <article className={`${styles.eventCard} ${className}`} data-status={event.status}>
    <Link params={{ eventId: event.id }} search={navigationSearch} to="/planning/events/$eventId">
      <div className={styles.eventCardBody}>
        <div className={styles.eventCardHeader}>
          <div className={styles.eventCardBadges}>
            <span aria-label={eventTypeLabel} className={`${styles.eventCardIcon} ${styles[`eventTypeIcon_${event.eventType}`]}`} role="img" title={eventTypeLabel}><PlanningEventTypeIcon size={15} type={event.eventType} /></span>
            {event.seriesId ? <span aria-label={t('planning.recurrence.series')} className={styles.eventCardIcon} role="img" title={t('planning.recurrence.series')}><Repeat2 aria-hidden="true" size={15} /></span> : null}
          </div>
          <time className={styles.eventTime} dateTime={event.allDay ? event.startDate : event.startsAt}>{eventTime}</time>
        </div>
        <div className={styles.eventCopy}>
          <h3>{event.title}</h3>
          {event.description ? <p className={styles.eventDescription}>{event.description}</p> : null}
          {event.location || event.eventType !== 'APPOINTMENT' ? <div className={styles.eventCardMeta}>
            {event.location ? <span><MapPin aria-hidden="true" size={13} />{event.location}</span> : null}
            {event.eventType !== 'APPOINTMENT' ? <span><UsersRound aria-hidden="true" size={13} />{t('planning.summary', { attending: event.participation.attending, open: event.participation.unanswered })}</span> : null}
          </div> : null}
        </div>
      </div>
      <ChevronRight aria-hidden="true" className={styles.eventCardChevron} size={18} />
    </Link>
    {showParticipation ? <ParticipationAction compact event={event} /> : null}
  </article>;
}
