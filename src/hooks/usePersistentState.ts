import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";

interface Store<T> {
  value: T;
  listeners: Set<() => void>;
}

/** One shared store per localStorage key, not per component - every
 * usePersistentState(key) call across the whole app reads/writes the exact
 * same in-memory value and re-renders together, the same way multiple
 * useState-in-one-component call sites would. Without this, two components
 * that each called the old per-instance useState version independently
 * (e.g. the Sidebar's favourites list and a page's own favourite-star
 * button) would silently drift out of sync - one's toggle updated
 * localStorage but the other's already-mounted copy never re-read it. */
const stores = new Map<string, Store<unknown>>();

function getStore<T>(key: string, defaultValue: T, sanitize?: (value: T) => T): Store<T> {
  let store = stores.get(key) as Store<T> | undefined;
  if (!store) {
    let initial: T;
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw === null ? defaultValue : (JSON.parse(raw) as T);
      initial = sanitize ? sanitize(parsed) : parsed;
    } catch {
      initial = defaultValue;
    }
    store = { value: initial, listeners: new Set() };
    stores.set(key, store as Store<unknown>);
  }
  return store;
}

/**
 * localStorage-backed React state, shared across every component that reads
 * the same key - factoring out the pattern that was hand-rolled
 * independently in over a dozen hooks across this app.
 *
 * `sanitize` runs once, the first time any component reads this key
 * (freshly parsed, or the default if nothing was stored / parsing failed) -
 * for a hook like useDefaultTradeHub that needs to reject a stored value
 * that's no longer valid.
 */
export function usePersistentState<T>(
  key: string,
  defaultValue: T,
  sanitize?: (value: T) => T,
): readonly [T, Dispatch<SetStateAction<T>>] {
  const store = getStore(key, defaultValue, sanitize);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      store.listeners.add(onStoreChange);
      return () => store.listeners.delete(onStoreChange);
    },
    [store],
  );
  const getSnapshot = useCallback(() => store.value, [store]);

  const value = useSyncExternalStore(subscribe, getSnapshot);

  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (next) => {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(store.value) : next;
      store.value = resolved;
      try {
        localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Not worth surfacing - worst case the preference doesn't persist.
      }
      store.listeners.forEach((listener) => listener());
    },
    [store, key],
  );

  return [value, setValue] as const;
}
