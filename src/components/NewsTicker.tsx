import { useEffect, useState } from "react";
import { Newspaper } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getNewsFeed, type NewsItem } from "../lib/news";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { formatRelativeTime } from "../lib/format";

const MAX_ITEMS = 8;

/** Dashboard news strip - CCP's official RSS feed (Community Beat, patch
 * notes, dev blogs), fetched once per Dashboard visit since it only
 * changes a few times a week. Renders nothing if the feed comes back empty
 * rather than an awkward empty panel. */
function NewsTicker() {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const reportError = useErrorReporter();

  useEffect(() => {
    let cancelled = false;
    getNewsFeed()
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch((err) => reportError(`Failed to load EVE Online news: ${String(err)}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openArticle(link: string) {
    openUrl(link).catch((err) => reportError(`Failed to open link: ${String(err)}`));
  }

  if (items !== null && items.length === 0) {
    return null;
  }

  return (
    <div className="news-ticker">
      <p className="news-ticker-title">
        <Newspaper size={14} strokeWidth={2} />
        EVE Online News
      </p>
      <div className="news-ticker-row">
        {items === null
          ? Array.from({ length: 4 }, (_, i) => <div key={i} className="news-ticker-card news-ticker-card-skeleton" />)
          : items.slice(0, MAX_ITEMS).map((item) => (
              <button
                key={item.link}
                type="button"
                className="news-ticker-card"
                onClick={() => openArticle(item.link)}
                title={item.title}
              >
                <span className="news-ticker-card-date">{formatRelativeTime(item.pub_date)}</span>
                <span className="news-ticker-card-title">{item.title}</span>
                <span className="news-ticker-card-summary">{item.summary}</span>
              </button>
            ))}
      </div>
    </div>
  );
}

export default NewsTicker;
