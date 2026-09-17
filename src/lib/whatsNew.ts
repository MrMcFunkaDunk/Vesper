/** Shared between UpdateBanner (which stashes the just-installed version's
 * release notes right before relaunching, since it already has them in
 * hand from the update check) and WhatsNewModal (which reads them back
 * after the relaunch lands on the new version). */
export interface PendingWhatsNew {
  version: string;
  body: string;
}

/** The just-installed update's own release notes, stashed by UpdateBanner
 * immediately before relaunch - read once by WhatsNewModal on the next
 * launch, then cleared. */
export const WHATS_NEW_PENDING_KEY = "vesper.pendingWhatsNew";

/** The last app version WhatsNewModal has shown (or deliberately skipped
 * showing) a changelog for - comparing this against the running version is
 * what decides whether a fresh launch just came from an update. */
export const WHATS_NEW_SEEN_KEY = "vesper.lastSeenChangelogVersion";

/** Fallback source when there's no stashed pending entry for the version
 * actually running (e.g. a manual download/install rather than VESPER's
 * own in-app updater) - the same GitHub release these builds already
 * publish to, read by its own tag rather than "latest" so this always
 * matches the version actually running, not whatever's newest right now. */
export const RELEASES_API_BASE = "https://api.github.com/repos/MrMcFunkaDunk/Vesper/releases/tags";

/** Every past release, newest first - Settings' Update History list. Public
 * and unauthenticated, same as RELEASES_API_BASE above; GitHub's default
 * page size (30) comfortably covers this app's release history so far. */
export const RELEASES_API_LIST = "https://api.github.com/repos/MrMcFunkaDunk/Vesper/releases";

export interface ReleaseHistoryEntry {
  version: string;
  body: string;
  publishedAt: string;
}

interface GithubReleaseJson {
  tag_name?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** Fetches and normalizes the release list for Update History - drops
 * drafts (not a real published version yet) and anything with no tag. */
export async function fetchReleaseHistory(): Promise<ReleaseHistoryEntry[]> {
  const res = await fetch(RELEASES_API_LIST);
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const data = (await res.json()) as GithubReleaseJson[];
  return data
    .filter((r) => r.tag_name && !r.draft)
    .map((r) => ({
      version: r.tag_name!.replace(/^v/, ""),
      body: r.body ?? "",
      publishedAt: r.published_at ?? "",
    }));
}
