use serde::{Deserialize, Serialize};

/// CCP's own official news feed - confirmed live: the eveonline.com/news
/// page's <link rel="alternate" type="application/rss+xml"> points here
/// (the more obvious /rss/news guess 500s - this is the real one), plain
/// RSS 2.0 with no auth needed. Covers Community Beat posts, patch notes,
/// dev blogs, and store promos.
const NEWS_FEED_URL: &str = "https://www.eveonline.com/rss";
/// How many characters of an article's HTML description survive into the
/// ticker's plain-text summary - just enough to be scannable, not a full
/// article reader (that's what the "read more" link is for).
const SUMMARY_MAX_CHARS: usize = 220;

#[derive(Deserialize)]
struct RssFeed {
    channel: RssChannel,
}

#[derive(Deserialize)]
struct RssChannel {
    #[serde(rename = "item", default)]
    items: Vec<RssItem>,
}

#[derive(Deserialize)]
struct RssItem {
    title: String,
    link: String,
    #[serde(default)]
    description: String,
    #[serde(rename = "pubDate", default)]
    pub_date: String,
}

#[derive(Serialize, Clone)]
pub struct NewsItem {
    pub title: String,
    pub link: String,
    pub summary: String,
    pub pub_date: String,
}

/// Strips HTML tags and decodes the handful of entities CCP's CMS actually
/// uses, then collapses whitespace and truncates - the raw <description> is
/// full article markup (headings, images, links) meant for a web page, not
/// a one-line ticker row. Deliberately not rendered as HTML at all (even
/// sanitized) since a ticker only needs plain text.
fn plain_text_summary(html: &str, max_chars: usize) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let decoded = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(max_chars).collect();
    format!("{}...", truncated.trim_end())
}

/// The Dashboard's news ticker source - fetched live on every call rather
/// than cached, since the feed is small (a handful of items) and changes
/// at most a few times a week, so there's no real staleness problem to
/// solve and no benefit to the extra bookkeeping a cache would add.
pub async fn fetch_news_feed(client: &reqwest::Client) -> Result<Vec<NewsItem>, String> {
    let response = client.get(NEWS_FEED_URL).send().await.map_err(|e| format!("news feed request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("news feed returned {status}"));
    }
    let body = response.text().await.map_err(|e| format!("failed to read news feed: {e}"))?;
    let feed: RssFeed = quick_xml::de::from_str(&body).map_err(|e| format!("failed to parse news feed: {e}"))?;

    Ok(feed
        .channel
        .items
        .into_iter()
        .map(|item| NewsItem {
            title: item.title,
            link: item.link,
            summary: plain_text_summary(&item.description, SUMMARY_MAX_CHARS),
            pub_date: item.pub_date,
        })
        .collect())
}

/// DOTLAN's live universe activity ticker - sovereignty changes, faction
/// warfare contests, corp/alliance moves, incursions. Confirmed live and
/// genuinely real-time (lastBuildDate matched wall-clock time within a
/// minute when checked) - NOT the same as DOTLAN's separate WordPress blog
/// feed at /blog/feed/, which is dead (last post 2019). Distinct source and
/// distinct shape from the EVE news feed above (a `category` per item, no
/// HTML description worth stripping - the title alone is already a
/// complete plain-text description of the event), so it's a second,
/// separate Dashboard panel rather than merged into the same one.
const LIVE_ACTIVITY_FEED_URL: &str = "https://evemaps.dotlan.net/feed";

#[derive(Deserialize)]
struct ActivityRssItem {
    title: String,
    link: String,
    #[serde(default)]
    category: String,
    #[serde(rename = "pubDate", default)]
    pub_date: String,
}

#[derive(Deserialize)]
struct ActivityRssChannel {
    #[serde(rename = "item", default)]
    items: Vec<ActivityRssItem>,
}

#[derive(Deserialize)]
struct ActivityRssFeed {
    channel: ActivityRssChannel,
}

#[derive(Serialize, Clone)]
pub struct ActivityEvent {
    pub title: String,
    pub link: String,
    pub category: String,
    pub pub_date: String,
}

pub async fn fetch_live_activity_feed(client: &reqwest::Client) -> Result<Vec<ActivityEvent>, String> {
    let response =
        client.get(LIVE_ACTIVITY_FEED_URL).send().await.map_err(|e| format!("live activity feed request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("live activity feed returned {status}"));
    }
    let body = response.text().await.map_err(|e| format!("failed to read live activity feed: {e}"))?;
    let feed: ActivityRssFeed = quick_xml::de::from_str(&body).map_err(|e| format!("failed to parse live activity feed: {e}"))?;

    Ok(feed
        .channel
        .items
        .into_iter()
        .map(|item| ActivityEvent { title: item.title, link: item.link, category: item.category, pub_date: item.pub_date })
        .collect())
}
