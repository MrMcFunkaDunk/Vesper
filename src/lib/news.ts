import { invoke } from "@tauri-apps/api/core";

export interface NewsItem {
  title: string;
  link: string;
  summary: string;
  pub_date: string;
}

/** CCP's official EVE Online news feed (Community Beat, patch notes, dev
 * blogs, store promos) - fetched live server-side, no caching, since it's
 * small and only changes a few times a week. */
export function getNewsFeed(): Promise<NewsItem[]> {
  return invoke("get_news_feed");
}

export interface ActivityEvent {
  title: string;
  link: string;
  category: string;
  pub_date: string;
}

/** DOTLAN's live universe activity ticker - sovereignty changes, faction
 * warfare contests, corp/alliance moves, incursions. Genuinely real-time
 * (confirmed live, updates every few minutes) - distinct from the news
 * feed above, which is editorial articles, not world events. */
export function getLiveActivityFeed(): Promise<ActivityEvent[]> {
  return invoke("get_live_activity_feed");
}
