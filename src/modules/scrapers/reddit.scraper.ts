/**
 * Reddit 采集源（子版块）。
 *
 * 走 `.rss`（Atom）而不是官方 JSON 接口，原因是实测结论：
 *   - `www.reddit.com/r/X/hot.json` → 403（无 OAuth 一律拒）；
 *   - `www.reddit.com/r/X/hot/.rss` → 200，25 条，字段齐全（标题/正文/时间/链接）。
 * `.rss` 无需 key、无需登录，是唯一在本机网络上真实可用的口子。
 *
 * 两条硬约束（都是实测踩出来的）：
 *   1. **必须串行 + 限速**：连续请求会返回 429（Too Many Requests），
 *      所以模块级做最小请求间隔，命中 429 时退避重试；
 *   2. `old.reddit.com` 虽然返回 200，但 feed 是空的（0 条），所以只认 www 域名。
 */

import {
  ContentScraper,
  ScrapedContent,
  ScraperOptions,
} from "../interfaces/scraper.interface.ts";
import { fetchText, HttpRequestError } from "./fetch-text.ts";
import { parseFeed } from "./feed-parser.ts";
import {
  decodeEntities,
  htmlToPlainText,
  safeFormatDate,
  toText,
} from "./text-utils.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
};

/** Reddit 不认浏览器 UA 的伪装，但要求 UA 能标识调用方，否则更容易 403/429。 */
export const REDDIT_USER_AGENT =
  "windows:trendpublish:v1.0 (by /u/trendpublish)";

const REDDIT_SORTS = [
  "hot",
  "new",
  "top",
  "rising",
  "controversial",
  "best",
] as const;

export type RedditSort = typeof REDDIT_SORTS[number];

export interface NormalizedRedditSource {
  subreddit: string;
  sort: RedditSort;
}

const SUBREDDIT_NAME = /^[A-Za-z0-9_]{2,21}$/;

const isSort = (value: string): value is RedditSort =>
  (REDDIT_SORTS as readonly string[]).includes(value);

/**
 * 接受这些写法（用户从浏览器复制什么就能填什么）：
 *   OpenAI / r/OpenAI / r/OpenAI/new
 *   https://www.reddit.com/r/OpenAI
 *   https://www.reddit.com/r/OpenAI/top/.rss
 *   https://old.reddit.com/r/OpenAI/new
 */
export const normalizeRedditSource = (
  sourceId: string,
): NormalizedRedditSource => {
  const raw = toText(sourceId);
  if (!raw) throw new Error("Reddit 源为空");

  let path = raw;
  // 只有 http(s) 开头才当 URL 解析：
  // `new URL("r/OpenAI")` 会抛错（能走到下一条），但 `new URL("r:OpenAI")` 这类
  // 带冒号的写法会“解析成功”并把子版块名吃掉，所以先按前缀拦一道。
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (!/(^|\.)reddit\.com$/i.test(url.hostname)) {
      throw new Error(`Reddit 源域名不是 reddit.com：${url.hostname}`);
    }
    path = url.pathname;
  }

  const segments = path.split("/").map((part) => part.trim()).filter(Boolean);
  const rIndex = segments.findIndex((part) => part.toLowerCase() === "r");
  const afterR = rIndex >= 0 ? segments.slice(rIndex + 1) : segments;
  const subreddit = afterR[0] ?? "";
  const sortCandidate = afterR
    .slice(1)
    .find((part) => part !== ".rss" && !part.startsWith("?"));

  if (!SUBREDDIT_NAME.test(subreddit)) {
    throw new Error(`识别不出子版块名（示例：r/OpenAI）：${raw}`);
  }
  const sort = sortCandidate && isSort(sortCandidate.toLowerCase())
    ? sortCandidate.toLowerCase() as RedditSort
    : "hot";
  return { subreddit, sort };
};

export const buildRedditFeedUrl = (source: NormalizedRedditSource): string =>
  `https://www.reddit.com/r/${source.subreddit}/${source.sort}/.rss`;

/** 模块级最小请求间隔：连着抓多个子版块时，第二个必然是 429。 */
const MIN_REQUEST_INTERVAL_MS = 3000;
let lastRequestAt = 0;

const waitForRequestSlot = async (): Promise<void> => {
  const elapsed = Date.now() - lastRequestAt;
  if (lastRequestAt > 0 && elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed)
    );
  }
  lastRequestAt = Date.now();
};

const RETRY_DELAYS_MS = [6000, 15000];

const fetchRedditFeed = async (url: string): Promise<string> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await waitForRequestSlot();
    try {
      const { text } = await fetchText(url, {
        headers: {
          "User-Agent": REDDIT_USER_AGENT,
          Accept: "application/atom+xml, application/xml, text/xml;q=0.9",
        },
      });
      return text;
    } catch (error) {
      lastError = error;
      const isRateLimited = error instanceof HttpRequestError &&
        error.status === 429;
      if (!isRateLimited || attempt === RETRY_DELAYS_MS.length) break;
      const delay = RETRY_DELAYS_MS[attempt];
      logger.warn(
        `[Reddit] 触发限速(429)，${delay}ms 后重试（第 ${attempt + 1} 次）`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  if (lastError instanceof HttpRequestError && lastError.status === 429) {
    throw new Error(
      "Reddit 限速（429）：同一 IP 短时间请求过多，请减少子版块数量或降低抓取频率",
    );
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "Reddit 抓取失败"));
};

/**
 * Reddit 的 Atom 正文是它自己的一小段 HTML 模板，不是文章正文：
 * 实测长这样（链接帖）：
 *   <table><tr><td><a href="https://www.reddit.com/r/OpenAI/comments/xxx/">…图片…</a></td>
 *   <td> submitted by /u/MatricesRL <br/> <span><a href="https://openai.com/index/…">[link]</a></span>
 *   <span><a href="…/comments/xxx/">[comments]</a></span></td></tr></table>
 * 所以「清掉噪音」剩下的是 "[留言]" 这种空壳，**必须把外链抽出来**，
 * 否则素材里只有一句话的消息，深度的第一步就没东西可用。
 * 文字帖（self post）的正文就在同一段 HTML 里，一并保留。
 */
const REDDIT_HOST = /(^|\.)reddit\.com$/i;
const IMAGE_OR_MEDIA = /\.(jpe?g|png|gif|webp|mp4|webm)(\?|$)/i;

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export const extractRedditPost = (
  html: string,
): { body: string; externalUrl: string } => {
  const raw = String(html ?? "");
  // href 里的 &amp; 要解码，否则拼进正文的链接是坏的
  const hrefs = [...raw.matchAll(/href="([^"]+)"/gi)].map((match) =>
    decodeEntities(match[1])
  );
  const externalUrl = hrefs.find((href) => {
    if (!/^https?:\/\//i.test(href)) return false;
    const host = hostOf(href);
    if (!host) return false;
    if (REDDIT_HOST.test(host)) return false;
    if (host.endsWith("redd.it")) return false; // 预览图 CDN，不是原文
    if (IMAGE_OR_MEDIA.test(href)) return false;
    return true;
  }) ?? "";

  const body = htmlToPlainText(raw)
    .replace(/\[(link|comments|\u7559\u8a00|\u94fe\u63a5)\]/gi, " ")
    .replace(/submitted by\s*\/u\/\S+/gi, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  return { body, externalUrl };
};

const composeRedditContent = (html: string, fallbackTitle: string): string => {
  const { body, externalUrl } = extractRedditPost(html);
  // 正文跟标题重复时不再重复一遍（链接帖的“正文”往往就是标题本身）
  const lines: string[] = [];
  if (body && body !== fallbackTitle) lines.push(body);
  if (externalUrl) lines.push(`原文链接：${externalUrl}`);
  return lines.join("\n").trim();
};

export class RedditScraper implements ContentScraper {
  async scrape(
    sourceId: string,
    options?: ScraperOptions,
  ): Promise<ScrapedContent[]> {
    const source = normalizeRedditSource(sourceId);
    const url = buildRedditFeedUrl(source);
    const limit = options?.limit && options.limit > 0
      ? Math.min(options.limit, 100)
      : 25;

    const xml = await fetchRedditFeed(url);
    const feed = parseFeed(xml, limit);
    if (feed.items.length === 0) {
      throw new Error(
        `r/${source.subreddit} 的 ${source.sort} feed 返回 0 条（版块可能不存在或已被封禁）`,
      );
    }

    logger.info(
      `[Reddit] r/${source.subreddit}/${source.sort}｜${feed.items.length} 条`,
    );

    return feed.items.map((item) => {
      const title = item.title || item.link;
      return {
        id: item.guid || item.link,
        title,
        content: composeRedditContent(
          item.contentHtml || item.summaryHtml,
          title,
        ),
        url: item.link || url,
        publishDate: safeFormatDate(item.publishedAt),
        metadata: {
          source: "reddit",
          subreddit: source.subreddit,
          sort: source.sort,
          author: item.author,
        },
      } satisfies ScrapedContent;
    });
  }
}
