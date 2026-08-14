import type { TFunction } from 'i18next';

interface ProblemErrorLike {
  problem?: {
    status?: unknown;
  };
}

/**
 * Maps technical login failures to safe, actionable German UI copy.
 *
 * The message deliberately treats unknown accounts and incorrect passwords
 * identically so the login form does not reveal whether an account exists.
 *
 * @param error - The unknown failure returned by the authentication request.
 * @param t - The active i18next translation function.
 * @returns A localized message suitable for the login form alert.
 *
 * @example
 * ```ts
 * const message = loginErrorMessage(error, t);
 * ```
 */
export function loginErrorMessage(error: unknown, t: TFunction): string {
  const status = typeof error === 'object' && error !== null
    ? (error as ProblemErrorLike).problem?.status
    : undefined;

  if (status === 401) return t('auth.invalidCredentials');
  if (status === 429) return t('auth.tooManyLoginAttempts');
  return t('auth.loginFailed');
}
