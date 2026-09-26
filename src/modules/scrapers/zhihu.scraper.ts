/**
 * 知乎采集源。
 *
 * 实测（2026-09，本机网络）：
 *   ✅ `api.zhihu.com/topstory/hot-list`（热榜）        → 200，30 条，含标题/链接/摘要/热度
 *   ✅ `news-at.zhihu.com/api/4/news/latest`（日报）     → 200，含 stories + top_stories
 *   ✅ `news-at.zhihu.com/api/4/news/{id}`（日报正文）    → 200，body 是完整 HTML
 *   ❌ `www.zhihu.com/api/v3/feed/topstory/hot-lists/total` → 401
 *   ❌ `www.zhihu.com/hot`（网页）                        → 403
 *
 * 关键差异：`api.zhihu.com` 与 `news-at.zhihu.com` 两个域名**不需要登录态**，
 * 而 `www.zhihu.com` 的网页与 v3 接口已全面要求鉴权。
 * 因此热榜走 api.zhihu.com，日报走 news-at.zhihu.com，都不依赖 cookie。
 */

import {
  ContentScraper,
  ScrapedContent,
  ScraperOptions,
} from "../interfaces/scraper.interface.ts";
import { fetchJson } from "./fetch-text.ts";
import {
  formatUnixSeconds,
  htmlToPlainText,
  safeFormatDate,
  snippet,
  toText,
} from "./text-utils.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
};

export type ZhihuMode = "hot" | "daily";

export interface NormalizedZhihuSource {
  mode: ZhihuMode;
}

const MODE_ALIASES: Record<string, ZhihuMode> = {
  hot: "hot",
  billboard: "hot",
  hotlist: "hot",
  daily: "daily",
  dailynews: "daily",
};

/**
 * 接受这些写法：
 *   hot / https://www.zhihu.com/hot / https://api.zhihu.com/topstory/hot-list
 *   daily / https://daily.zhihu.com/
 */
export const normalizeZhihuSource = (
  sourceId: string,
): NormalizedZhihuSource => {
  const raw = toText(sourceId);
  if (!raw) throw new Error("知乎源为空");
  const head = raw.split(":")[0].trim().toLowerCase();
  const alias = MODE_ALIASES[head];
  if (alias) return { mode: alias };

  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    throw new Error(`识别不出知乎源（示例：hot / daily）：${raw}`);
  }
  if (host.endsWith("daily.zhihu.com")) return { mode: "daily" };
  if (host.endsWith("zhihu.com")) return { mode: "hot" };
  throw new Error(`知乎源域名不是 zhihu.com：${host}`);
};

export const buildZhihuApiUrl = (
  source: NormalizedZhihuSource,
  limit: number,
): string => {
  if (source.mode === "hot") {
    const size = Math.min(Math.max(limit, 1), 50);
    return `https://api.zhihu.com/topstory/hot-list?limit=${size}`;
  }
  return "https://news-at.zhihu.com/api/4/news/latest";
};

/**
 * 热榜项的 url 是**绝对地址但指向 api.zhihu.com**（实测：
 * `https://api.zhihu.com/questions/2087138028443668724`），
 * 用户点不开也没法对外引用，统一改回站内地址。
 */
const absoluteZhihuUrl = (value: string): string => {
  const url = toText(value);
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) {
    return url.replace(/^https?:\/\/api\.zhihu\.com/i, "https://www.zhihu.com");
  }
  return `https://www.zhihu.com${url.startsWith("/") ? "" : "/"}${url}`;
};

/**
 * `card_label` 是**对象**（`{type,icon,night_icon}`），直接拼进模板会变成 "[object Object]"。
 * 它目前只用来标记“沸腾/热门”这类状态，取值文案不稳定，所以只映射确定存在的类型，
 * 其余（含未来新增的 type）一律不渲染——宁可不显示，也不给素材里塞乱码。
 */
const CARD_LABEL_TEXT: Record<string, string> = {
  boiling: "沸腾",
  hot: "热门",
};

const cardLabelText = (value: unknown): string => {
  if (!value || typeof value !== "object") return "";
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return "";
  return CARD_LABEL_TEXT[type.toLowerCase()] ?? "";
};

const dailyDateToIso = (value: string): string => {
  const raw = toText(value);
  if (!/^\d{8}$/.test(raw)) return "";
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
};

interface ZhihuHotResponse {
  data?: Array<{
    id?: string;
    card_id?: string;
    card_label?: string;
    detail_text?: string;
    target?: {
      id?: string;
      title?: string;
      url?: string;
      excerpt?: string;
      created?: number;
      answer_count?: number;
      follower_count?: number;
      author?: { name?: string };
    };
  }>;
}

interface ZhihuDailyResponse {
  date?: string;
  stories?: Array<{ id?: number; title?: string; url?: string }>;
  top_stories?: Array<{ id?: number; title?: string; url?: string }>;
}

interface ZhihuDailyDetail {
  body?: string;
  title?: string;
  share_url?: string;
}

export class ZhihuScraper implements ContentScraper {
  async scrape(
    sourceId: string,
    options?: ScraperOptions,
  ): Promise<ScrapedContent[]> {
    const source = normalizeZhihuSource(sourceId);
    return source.mode === "hot"
      ? await this.scrapeHot(options)
      : await this.scrapeDaily(options);
  }

  private async scrapeHot(options?: ScraperOptions): Promise<ScrapedContent[]> {
    const limit = options?.limit && options.limit > 0
      ? Math.min(options.limit, 50)
      : 30;
    const url = buildZhihuApiUrl({ mode: "hot" }, limit);
    const payload = await fetchJson<ZhihuHotResponse>(url, {
      headers: { Referer: "https://www.zhihu.com/hot" },
    });
    const list = Array.isArray(payload.data) ? payload.data : [];
    if (list.length === 0) {
      throw new Error(
        `知乎热榜返回 0 条｜${snippet(JSON.stringify(payload), 120)}`,
      );
    }

    logger.info(`[知乎] 热榜｜${list.length} 条`);
    return list.map((item) => {
      const target = item.target ?? {};
      const title = toText(target.title);
      const link = absoluteZhihuUrl(toText(target.url));
      const heat = toText(item.detail_text);
      const excerpt = toText(target.excerpt);
      // 热榜的 author.name 常常是占位符“用户”（实测），写进素材是纯噪音
      const rawAuthor = toText(target.author?.name);
      const author = rawAuthor === "用户" ? "" : rawAuthor;
      const label = cardLabelText(item.card_label);
      const meta = [heat && `热度：${heat}`, author && `作者：${author}`, label]
        .filter(Boolean).join("｜");
      const body = [title, "", meta, excerpt]
        .filter(Boolean).join("\n").trim();

      return {
        id: toText(target.id) || toText(item.id) || toText(item.card_id) ||
          link,
        title: title || link,
        content: body,
        url: link,
        // 热榜没有"发布时间"这个概念，它衡量的是"此刻的热度"：
        // 用 created（首次上榜时间）会把它当成一条几天前的旧闻，用当前时间更贴近语义。
        publishDate: target.created
          ? formatUnixSeconds(target.created)
          : safeFormatDate(new Date().toISOString()),
        metadata: {
          source: "zhihu",
          mode: "hot",
          heat,
          label,
          answerCount: target.answer_count,
          followerCount: target.follower_count,
        },
      } satisfies ScrapedContent;
    });
  }

  private async scrapeDaily(
    options?: ScraperOptions,
  ): Promise<ScrapedContent[]> {
    // 日报每条都要再取一次正文，默认只取 10 条：30 条正文要 30 次请求，
    // 对站点不礼貌，而且深度文一次也用不到那么多素材。
    const limit = options?.limit && options.limit > 0
      ? Math.min(options.limit, 30)
      : 10;
    const url = buildZhihuApiUrl({ mode: "daily" }, limit);
    const payload = await fetchJson<ZhihuDailyResponse>(url);
    const stories = (payload.stories ?? []).slice(0, limit);
    if (stories.length === 0) {
      throw new Error(
        `知乎日报返回 0 条｜${snippet(JSON.stringify(payload), 120)}`,
      );
    }
    const publishDate = safeFormatDate(dailyDateToIso(payload.date ?? ""));

    const results: ScrapedContent[] = [];
    for (const story of stories) {
      const link = absoluteZhihuUrl(toText(story.url));
      let body = "";
      if (story.id) {
        try {
          const detail = await fetchJson<ZhihuDailyDetail>(
            `https://news-at.zhihu.com/api/4/news/${story.id}`,
          );
          body = htmlToPlainText(toText(detail.body));
        } catch (error) {
          // 单条正文取不到不该让整个源失败：标题本身就是有效素材线索
          logger.warn(
            `[知乎] 日报正文抓取失败（id=${story.id}）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      results.push(
        {
          id: String(story.id ?? link),
          title: toText(story.title) || link,
          content: body || toText(story.title),
          url: link,
          publishDate,
          metadata: {
            source: "zhihu",
            mode: "daily",
            hasBody: body.length > 0,
          },
        } satisfies ScrapedContent,
      );
    }

    logger.info(`[知乎] 日报｜${results.length} 条`);
    return results;
  }
}
