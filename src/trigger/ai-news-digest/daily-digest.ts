import { schedules } from "@trigger.dev/sdk";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";
import { XMLParser } from "fast-xml-parser";

// ─── Env Validation ────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");

const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL;
if (!RECIPIENT_EMAIL) throw new Error("RECIPIENT_EMAIL is not set");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is not set");

const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

// ─── Clients ───────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const resend = new Resend(RESEND_API_KEY);
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
});

// ─── Sources ───────────────────────────────────────────────────────────────────
// RSS feeds — each fails gracefully; missing one doesn't break the run
const RSS_FEEDS = [
  // AI / Claude / Anthropic
  { url: "https://www.anthropic.com/news/rss.xml",                                       label: "Anthropic Blog",      topic: "AI"        },
  { url: "https://techcrunch.com/category/artificial-intelligence/feed/",                label: "TechCrunch AI",       topic: "AI"        },
  { url: "https://venturebeat.com/category/ai/feed/",                                    label: "VentureBeat AI",      topic: "AI"        },
  { url: "https://arstechnica.com/ai/feed/",                                              label: "Ars Technica AI",     topic: "AI"        },
  { url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",            label: "The Verge AI",        topic: "AI"        },
  { url: "https://huggingface.co/blog/feed.xml",                                          label: "Hugging Face Blog",   topic: "AI"        },
  // Microsoft / Fabric / Dataverse
  { url: "https://azure.microsoft.com/en-us/blog/feed/",                                 label: "Azure Blog",          topic: "Microsoft" },
  { url: "https://powerapps.microsoft.com/en-us/blog/feed/",                             label: "Power Platform Blog", topic: "Microsoft" },
  { url: "https://www.microsoft.com/en-us/microsoft-fabric/blog/feed/",                  label: "Fabric Blog",         topic: "Microsoft" },
  { url: "https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=FabricTechBlog", label: "Fabric Tech Community", topic: "Microsoft" },
] as const;

// YouTube queries — returns up to 5 videos each, deduped by video ID
const YOUTUBE_QUERIES = [
  { query: "Claude AI Anthropic announcement",        topic: "AI",        label: "Claude/Anthropic" },
  { query: "artificial intelligence news",            topic: "AI",        label: "AI News"          },
  { query: "Microsoft Fabric update tutorial",        topic: "Microsoft", label: "Microsoft Fabric"  },
  { query: "Microsoft Dataverse",                     topic: "Microsoft", label: "Dataverse"         },
] as const;

// ─── Types ─────────────────────────────────────────────────────────────────────
interface NewsItem {
  title: string;
  url: string;
  summary: string;
  source: string;
  topic: string;
}

interface VideoItem {
  title: string;
  url: string;
  channel: string;
  description: string;
  topic: string;
}

// ─── RSS Fetching ──────────────────────────────────────────────────────────────
async function fetchFeed(
  feedUrl: string,
  label: string,
  topic: string,
  since: Date
): Promise<NewsItem[]> {
  try {
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "AI-News-Digest/1.0" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      console.log(`Feed skipped (${res.status}): ${label}`);
      return [];
    }

    const text = await res.text();
    const parsed = xml.parse(text);

    // Support both RSS 2.0 (rss.channel.item) and Atom (feed.entry)
    const channel = parsed?.rss?.channel ?? parsed?.feed;
    if (!channel) return [];

    const rawItems = channel.item ?? channel.entry ?? [];
    const items: unknown[] = Array.isArray(rawItems) ? rawItems : [rawItems];
    const feedTitle: string = channel.title?.["#text"] ?? channel.title ?? label;

    const results: NewsItem[] = [];
    for (const item of items) {
      const i = item as Record<string, unknown>;

      const pubDate = new Date(
        String(i.pubDate ?? i.published ?? i.updated ?? "")
      );
      if (isNaN(pubDate.getTime()) || pubDate < since) continue;

      // Title — can be a string or an object with #text
      const title =
        typeof i.title === "string"
          ? i.title
          : (i.title as Record<string, string>)?.["#text"] ?? "";

      // Link — RSS has a string, Atom has an object with @_href
      const rawLink = i.link ?? i.url ?? "";
      const url =
        typeof rawLink === "string"
          ? rawLink
          : (rawLink as Record<string, string>)?.["@_href"] ?? "";

      // Summary — strip HTML tags
      const raw =
        String(
          i.description ??
          i.summary ??
          (i as Record<string, unknown>)["content:encoded"] ??
          (i.content as Record<string, string>)?.["#text"] ??
          ""
        )
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const summary = raw.slice(0, 350);

      if (!title || !url) continue;
      results.push({ title, url, summary, source: feedTitle, topic });
    }

    console.log(`${label}: ${results.length} items`);
    return results;
  } catch (err) {
    console.log(`Feed error (${label}):`, err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── YouTube Fetching ──────────────────────────────────────────────────────────
async function fetchYouTube(since: Date): Promise<VideoItem[]> {
  const seen = new Set<string>();
  const videos: VideoItem[] = [];

  for (const q of YOUTUBE_QUERIES) {
    try {
      const params = new URLSearchParams({
        part: "snippet",
        q: q.query,
        type: "video",
        order: "date",
        publishedAfter: since.toISOString(),
        maxResults: "5",
        key: YOUTUBE_API_KEY,
      });

      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?${params}`,
        { signal: AbortSignal.timeout(12000) }
      );

      if (!res.ok) {
        console.log(`YouTube API error for "${q.query}": ${res.status}`);
        continue;
      }

      const data = (await res.json()) as {
        items?: Array<{
          id: { videoId: string };
          snippet: {
            title: string;
            channelTitle: string;
            description: string;
            publishedAt: string;
          };
        }>;
      };

      for (const item of data.items ?? []) {
        const videoId = item.id?.videoId;
        if (!videoId || seen.has(videoId)) continue;
        seen.add(videoId);
        videos.push({
          title: item.snippet.title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          channel: item.snippet.channelTitle,
          description: item.snippet.description?.slice(0, 200) ?? "",
          topic: q.topic,
        });
      }

      console.log(`YouTube "${q.label}": ${data.items?.length ?? 0} results`);
    } catch (err) {
      console.log(`YouTube error for "${q.query}":`, err instanceof Error ? err.message : err);
    }
  }

  return videos;
}

// ─── Digest Generation (Claude Haiku) ─────────────────────────────────────────
async function generateDigest(
  news: NewsItem[],
  videos: VideoItem[],
  dateLabel: string
): Promise<string> {
  const aiNews = news.filter((i) => i.topic === "AI");
  const msNews = news.filter((i) => i.topic === "Microsoft");
  const aiVideos = videos.filter((v) => v.topic === "AI");
  const msVideos = videos.filter((v) => v.topic === "Microsoft");

  const formatNews = (items: NewsItem[]) =>
    items.length === 0
      ? "(none)"
      : items
          .map((i) => `TITLE: ${i.title}\nURL: ${i.url}\nSOURCE: ${i.source}\nSUMMARY: ${i.summary}`)
          .join("\n\n");

  const formatVideos = (items: VideoItem[]) =>
    items.length === 0
      ? "(none)"
      : items
          .map((v) => `TITLE: ${v.title}\nURL: ${v.url}\nCHANNEL: ${v.channel}\nDESCRIPTION: ${v.description}`)
          .join("\n\n");

  const prompt = `You are writing a daily AI & tech news digest email for ${dateLabel}.

Write a clean HTML email body (no <html>/<head> tags — just the body content) with inline styles.
Use a white background, max-width 700px, readable font (Arial/sans-serif), font-size 15px, line-height 1.6.

Structure:
1. A header bar with dark background (#1a1a2e), white text: "AI & Microsoft Daily Digest" + the date
2. A short intro paragraph (1-2 sentences, conversational)
3. Section: "🤖 AI & Claude / Anthropic" — top stories, max 7
4. Section: "🏢 Microsoft Fabric & Dataverse" — top stories, max 5
5. Section: "▶️ YouTube: Worth Watching" — top videos, max 5 (combine AI + Microsoft)
6. A small footer: "Delivered by your Trigger.dev automation"

For each article/video:
- Title as a bold <a href="URL"> link (color #1a56db, no underline)
- 1-2 sentence plain-English summary
- Source in small gray text (#888), font-size 12px

If a section has no items, write "No major updates in the last 24 hours." in gray italic.
Return ONLY the HTML — no markdown fences, no explanation.

=== AI NEWS (${aiNews.length} items) ===
${formatNews(aiNews)}

=== MICROSOFT NEWS (${msNews.length} items) ===
${formatNews(msNews)}

=== YOUTUBE AI (${aiVideos.length} items) ===
${formatVideos(aiVideos)}

=== YOUTUBE MICROSOFT (${msVideos.length} items) ===
${formatVideos(msVideos)}`;

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const content = message.content[0];
  if (content.type !== "text") throw new Error("Unexpected Claude response type");
  return content.text;
}

// ─── Scheduled Task ────────────────────────────────────────────────────────────
export const dailyAIDigest = schedules.task({
  id: "daily-ai-digest",

  // 9am Eastern Daylight Time (EDT = UTC-4) = 13:00 UTC
  // In winter (EST = UTC-5), change to: "0 14 * * *"
  cron: "0 13 * * *",

  run: async () => {
    // 25-hour lookback — slightly wider than 24h to avoid missing items at daily boundaries
    const since = new Date(Date.now() - 25 * 60 * 60 * 1000);

    const dateLabel = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    });

    console.log(`Gathering content since: ${since.toISOString()}`);

    // Fetch all RSS feeds in parallel — individual failures are swallowed inside fetchFeed
    const feedResults = await Promise.allSettled(
      RSS_FEEDS.map((f) => fetchFeed(f.url, f.label, f.topic, since))
    );
    const news = feedResults.flatMap((r) =>
      r.status === "fulfilled" ? r.value : []
    );

    // Fetch YouTube
    const videos = await fetchYouTube(since);

    console.log(`Total gathered: ${news.length} articles, ${videos.length} videos`);

    if (news.length === 0 && videos.length === 0) {
      console.log("No content found — sending digest anyway (will say no updates)");
    }

    // Generate HTML digest via Claude Haiku
    const emailHtml = await generateDigest(news, videos, dateLabel);

    // Send via Resend
    const { data, error } = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: RECIPIENT_EMAIL,
      subject: `AI & Microsoft Daily Digest — ${dateLabel}`,
      html: emailHtml,
    });

    if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);

    console.log(`Email delivered! Resend ID: ${data?.id}`);

    return {
      emailId: data?.id,
      articlesGathered: news.length,
      videosGathered: videos.length,
      dateLabel,
    };
  },
});
