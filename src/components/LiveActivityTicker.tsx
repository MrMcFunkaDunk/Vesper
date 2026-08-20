import { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getLiveActivityFeed, type ActivityEvent } from "../lib/news";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatRelativeTime } from "../lib/format";

const MAX_ITEMS = 10;
/** DOTLAN's own feed updates every few minutes, so a minute-ish poll keeps
 * this feeling live without hammering their server - same cadence as the
 * Stats popup's activity graphs. */
const REFRESH_INTERVAL_MS = 60_000;

/** Sovereignty/FW/corp events read as either a loss, a gain, contested
 * territory, or neutral admin noise - color-coding by category keeps that
 * distinction scannable at a glance without reading every line. */
function categoryTone(category: string): "danger" | "success" | "warning" | "neutral" {
  if (/Lost|Left|AttackStart/.test(category)) return "danger";
  if (/Upgrade|Claim|Gained/.test(category)) return "success";
  if (/Contested/.test(category)) return "warning";
  return "neutral";
}

/** Dashboard's second ticker panel - DOTLAN's live universe activity feed,
 * genuinely real-time (unlike the news feed above, which only changes a
 * few times a week), so this one polls in the background while the
 * Dashboard is open. */
function LiveActivityTicker() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const reportError = useErrorReporter();

  useEffect(() => {
    let cancelled = false;

    function refresh(reportOnError: boolean) {
      getLiveActivityFeed()
        .then((data) => {
          if (!cancelled) setEvents(data);
        })
        .catch((err) => {
          if (reportOnError) reportError(`Failed to load live activity feed: ${String(err)}`);
        });
    }

    refresh(true);
    const interval = setInterval(() => refresh(false), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openTicker(link: string) {
    openUrl(link).catch((err) => reportError(`Failed to open link: ${String(err)}`));
  }

  if (events !== null && events.length === 0) {
    return null;
  }

  return (
    <div className="news-ticker">
      <p className="news-ticker-title">
        <Radio size={14} strokeWidth={2} />
        New Eden Activity
      </p>
      <div className="news-ticker-row">
        {events === null
          ? Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="news-ticker-card news-ticker-card-wide news-ticker-card-skeleton" />
            ))
          : events.slice(0, MAX_ITEMS).map((event) => (
              <button
                key={event.link}
                type="button"
                className="news-ticker-card news-ticker-card-wide"
                onClick={() => openTicker(event.link)}
                title={event.title}
              >
                <span className="news-ticker-card-meta">
                  <span className={`activity-tag activity-tag-${categoryTone(event.category)}`}>{event.category}</span>
                  <span className="news-ticker-card-time">{formatRelativeTime(event.pub_date)}</span>
                </span>
                <span className="news-ticker-card-title">{event.title}</span>
              </button>
            ))}
      </div>
    </div>
  );
}

export default LiveActivityTicker;
