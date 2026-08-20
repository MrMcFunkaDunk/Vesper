import { useEffect, useRef, useState } from "react";
import { useErrorReporter } from "./useErrorReporter";
import type { KillEntry } from "../lib/kills";

/**
 * Loads a kills/losses feed one real zKillboard page (200 killmails) at a
 * time, growing as the UI's own 10-per-page Pager clicks deeper - instead
 * of fetching a small fixed batch once and never going further, which used
 * to make an active character/corp/alliance's history look truncated next
 * to zKillboard's own site (verified live: zKillboard paginates the same
 * feeds all the way back through actual history, terminating with an empty
 * array once you're past it - see fetch_character_kills_raw's doc comment
 * in kills.rs for the verification).
 */
export function usePaginatedKillFeed(fetchPage: (page: number) => Promise<KillEntry[]>, resetKey: unknown) {
  const [items, setItems] = useState<KillEntry[] | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const stateRef = useRef({ items: [] as KillEntry[], nextPage: 1, exhausted: false, loading: false });
  const reportError = useErrorReporter();

  useEffect(() => {
    stateRef.current = { items: [], nextPage: 1, exhausted: false, loading: false };
    setItems(null);
    setExhausted(false);
    let cancelled = false;

    fetchPage(1)
      .then((page1) => {
        if (cancelled) return;
        stateRef.current.items = page1;
        stateRef.current.nextPage = 2;
        stateRef.current.exhausted = page1.length === 0;
        setItems(page1);
        setExhausted(stateRef.current.exhausted);
      })
      .catch((err) => {
        if (!cancelled) reportError(`Failed to load kills: ${String(err)}`);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  /** Fetches further zKillboard pages until at least minCount items are
   * loaded (or the real history runs out) - a no-op once already loaded or
   * once exhausted, so paging back and forth over already-fetched pages
   * never re-fetches anything. */
  async function ensureLoadedThrough(minCount: number) {
    const s = stateRef.current;
    while (!s.exhausted && !s.loading && s.items.length < minCount) {
      s.loading = true;
      try {
        const more = await fetchPage(s.nextPage);
        s.nextPage += 1;
        if (more.length === 0) s.exhausted = true;
        s.items = [...s.items, ...more];
        setItems(s.items);
        setExhausted(s.exhausted);
      } catch (err) {
        reportError(`Failed to load more kills: ${String(err)}`);
        break;
      } finally {
        s.loading = false;
      }
    }
  }

  return { items, exhausted, ensureLoadedThrough };
}
