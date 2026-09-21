import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { usePersistentState } from "./usePersistentState";
import { useNotificationCenter } from "./useNotificationCenter";
import { RELEASES_API_BASE, WHATS_NEW_PENDING_KEY, WHATS_NEW_SEEN_KEY, type PendingWhatsNew } from "../lib/whatsNew";

export interface WhatsNewEntry {
  version: string;
  body: string;
}

/**
 * Drives the What's New modal and its matching bell notification. Marks a
 * version "seen" the moment it's been checked (shown or not - a version
 * with no real notes still shouldn't be re-checked every launch), not when
 * the modal is dismissed, so the bell notification stays clickable to
 * reopen it later without re-triggering the auto-popup.
 *
 * Never gates on "is this a fresh install" - the modal only ever mounts
 * once a character is logged in (App.tsx shows LoginScreen instead until
 * then), so by the time this runs the app has necessarily been set up
 * before. Skipping on a null seenVersion was tried and is exactly what
 * caused the very update that introduced this feature (1.9.6 -> 1.9.7) to
 * silently show nothing - the old build had never written the key, so it
 * looked identical to a brand-new install.
 */
export function useWhatsNew() {
  const [seenVersion, setSeenVersion] = usePersistentState<string | null>(WHATS_NEW_SEEN_KEY, null);
  const [pending, setPending] = usePersistentState<PendingWhatsNew | null>(WHATS_NEW_PENDING_KEY, null);
  const [entry, setEntry] = useState<WhatsNewEntry | null>(null);
  const [open, setOpen] = useState(false);
  const { addNotification } = useNotificationCenter();

  /** Distinguishes "checked successfully, there's just nothing to show"
   * (ok: true, body: null - a version with no real notes) from "couldn't
   * check at all" (ok: false - network hiccup, GitHub unreachable, rate
   * limited) - only the former should ever mark a version seen. Losing
   * this distinction is exactly the kind of bug that silently eats a
   * changelog forever: a transient failure would otherwise get treated as
   * "confirmed no notes" and never retried. */
  async function fetchNotesFor(version: string): Promise<{ ok: boolean; body: string | null }> {
    if (pending && pending.version === version && pending.body.trim()) return { ok: true, body: pending.body };
    try {
      const res = await fetch(`${RELEASES_API_BASE}/v${version}`);
      if (!res.ok) return { ok: false, body: null };
      const data = (await res.json()) as { body?: string };
      return { ok: true, body: data.body && data.body.trim() ? data.body : null };
    } catch {
      return { ok: false, body: null };
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const version = await getVersion();
      if (cancelled || seenVersion === version) return;
      const result = await fetchNotesFor(version);
      if (cancelled || !result.ok) return;

      setSeenVersion(version);
      if (pending?.version === version) setPending(null);
      if (!result.body) return;

      setEntry({ version, body: result.body });
      setOpen(true);
      addNotification(`VESPER ${version} is here`, "See what's new in this update.", undefined, undefined, "update", "open-whats-new");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Reopens the last-shown entry, or - if the app restarted since then and
   * nothing's cached in memory - refetches notes for whichever version was
   * last recorded as seen, since that's exactly the version the bell
   * notification (persisted across restarts) refers to. */
  async function reopen() {
    if (entry) {
      setOpen(true);
      return;
    }
    if (!seenVersion) return;
    const result = await fetchNotesFor(seenVersion);
    if (result.body) {
      setEntry({ version: seenVersion, body: result.body });
      setOpen(true);
    }
  }

  /** Primes the modal's content without opening it - UpdateBanner calls
   * this the moment it detects a pending update, using the notes it
   * already has in hand, so that update's own bell notification can open
   * a preview later without a second fetch. Doesn't touch seenVersion -
   * this is a preview of what's coming, not "you've now seen this". */
  function preview(newEntry: WhatsNewEntry) {
    setEntry(newEntry);
  }

  return { entry, open, close: () => setOpen(false), reopen, preview };
}
