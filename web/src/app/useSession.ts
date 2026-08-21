import { useContext } from 'react';
import { DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES, DEFAULT_MEDIA_UPLOAD_MAX_BYTES, type InstanceCapabilities, type Session } from '@/api/types';
import { SessionContext } from './session-context';

/** Safe browser defaults used only when a standalone component lacks the app provider. */
export const DEFAULT_INSTANCE_CAPABILITIES: InstanceCapabilities = {
  instanceName: 'TeamTaler',
  maintenanceMode: false,
  maintenanceMessage: '',
  publicJoinEnabled: true,
  mediaUploadMaxBytes: DEFAULT_MEDIA_UPLOAD_MAX_BYTES,
  attachmentUploadMaxBytes: DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES,
  emailNotificationsAvailable: false,
  webPushAvailable: false,
  webPushPublicKey: null,
  webPushKeyId: null,
};

/**
 * Returns the authenticated session available to every signed-in route.
 *
 * @returns Current authenticated session.
 * @throws Error when called outside {@link SessionProvider}.
 */
export function useSession(): Session {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider.');
  return value.session;
}

/**
 * Returns effective public instance capabilities.
 *
 * @returns Server-provided capabilities, or safe defaults in isolated component tests.
 */
export function useInstanceCapabilities(): InstanceCapabilities {
  return useContext(SessionContext)?.instanceCapabilities ?? DEFAULT_INSTANCE_CAPABILITIES;
}

/**
 * Checks the global role projection used exclusively for UI visibility.
 *
 * Server endpoints revalidate the role for every request; this helper does not
 * grant authorization.
 *
 * @param session - Canonical authenticated session.
 * @returns Whether the UI should expose the system-administration workspace.
 */
export function isSystemAdministrator(session: Session): boolean {
  return session.systemRoles?.includes('SYSTEM_ADMINISTRATOR') === true;
}
