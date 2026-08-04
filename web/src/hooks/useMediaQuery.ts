import { useEffect, useState } from 'react';

/**
 * Subscribes to a browser media query.
 *
 * @param query - A valid CSS media query.
 * @returns Whether the query currently matches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}
