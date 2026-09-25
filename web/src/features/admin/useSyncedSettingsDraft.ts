import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Synchronizes an untouched draft with persisted values while preserving in-progress edits.
 *
 * @param persisted - Latest server-confirmed value for this settings card.
 * @returns The current draft and its React state setter.
 * @throws No exceptions for JSON-compatible settings values.
 */
export function useSyncedSettingsDraft<T>(persisted: T): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(persisted);
  const previousPersisted = useRef(JSON.stringify(persisted));
  useEffect(() => {
    const serialized = JSON.stringify(persisted);
    if (serialized === previousPersisted.current) return;
    setDraft((current) => JSON.stringify(current) === previousPersisted.current ? persisted : current);
    previousPersisted.current = serialized;
  }, [persisted]);
  return [draft, setDraft];
}
