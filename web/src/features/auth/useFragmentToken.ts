import { useLayoutEffect, useState } from 'react';

/**
 * Captures a secret token from the URL fragment and removes it before paint.
 *
 * @param cleanPath - Public route that remains after the fragment is removed.
 * @returns The captured token, or an empty string when the fragment is invalid.
 */
export function useFragmentToken(cleanPath: string): string {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  useLayoutEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', cleanPath);
  }, [cleanPath]);
  return token;
}

