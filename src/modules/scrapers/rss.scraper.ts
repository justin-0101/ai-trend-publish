/**
 * RSS / Atom 订阅采集源。
 *
 * 为什么加这一类：现有 firecrawl 抓的是「网页列表页」，靠 LLM 从页面里抽新闻，
 * 一次调用有成本且有幻觉风险；而 feed 是站点自己给出的结构化接口，
 * 没有 key、没有浏览器、没有模型调用，稳定性和成本都远好于页面抽取。
 *
 * 实测（本机网络，2026-09）：少数派 / 量子位 / InfoQ / Solidot / IT之家 /
 * 极客公园 / 阮一峰 / OpenAI / HN 均为 200 且是合法 feed；
 * 36氪、机器之心的 `/feed`、`/rss` 返回的是 HTML 挑战页——这种必须在报错里说清，
 * 不能让用户以为「加了源但抓不到」是自己的配置问题。
 */

import {
  ContentScraper,
  ScrapedContent,
  ScraperOptions,
} from "../interfaces/scraper.interface.ts";
import { fetchText } from "./fetch-text.ts";
import { parseFeed } from "./feed-parser.ts";
import {
  htmlToPlainText,
  safeFormatDate,
  snippet,
  toText,
} from "./text-utils.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
};

const DEFAULT_LIMIT = 30;
const MAX_CONTENT_CHARS = 8000;

export const normalizeFeedUrl = (sourceId: string): string => {
  const raw = toText(sourceId);
  if (!raw) throw new Error("feed 地址为空");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`feed 地址不是合法 URL：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`feed 只支持 http/https：${raw}`);
  }
  return url.toString();
};

/** 用摘要兜底正文：不少 feed 只给 description，不补的话下游没有素材可读。 */
const pickBody = (contentHtml: string, summaryHtml: string): string => {
  const full = htmlToPlainText(contentHtml);
  if (full.length >= 120) return full.slice(0, MAX_CONTENT_CHARS);
  const summary = htmlToPlainText(summaryHtml);
  const merged = summary.length > full.length ? summary : full;
  return merged.slice(0, MAX_CONTENT_CHARS);
};

export class RssScraper implements ContentScraper {
  async scrape(
    sourceId: string,
    options?: ScraperOptions,
  ): Promise<ScrapedContent[]> {
    const url = normalizeFeedUrl(sourceId);
    const limit = options?.limit && options.limit > 0
      ? Math.min(options.limit, 100)
      : DEFAULT_LIMIT;

    const { text, contentType } = await fetchText(url, {
      headers: {
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
    });

    let feed;
    try {
      feed = parseFeed(text, limit);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${reason}｜content-type=${contentType || "未知"}｜开头：${
          snippet(text, 100)
        }`,
      );
    }

    logger.info(
      `[RSS] ${feed.feedTitle || url}｜${feed.format}｜${feed.items.length} 条`,
    );

    return feed.items
      .filter((item) => item.link || item.title)
      .map((item) => {
        const body = pickBody(item.contentHtml, item.summaryHtml);
        return {
          id: item.guid || item.link,
          title: item.title || item.link,
          content: body,
          url: item.link || url,
          publishDate: safeFormatDate(item.publishedAt),
          metadata: {
            source: "rss",
            feedUrl: url,
            feedTitle: feed.feedTitle,
            feedFormat: feed.format,
            author: item.author,
          },
        } satisfies ScrapedContent;
      });
  }
}
