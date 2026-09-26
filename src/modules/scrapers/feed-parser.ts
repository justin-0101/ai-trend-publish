/**
 * 极简 RSS 2.0 / Atom 解析器（零依赖）。
 *
 * 为什么手写而不用库：这四个采集器只需要「标题 / 链接 / 正文 / 时间」四个字段，
 * 而引入 xml 解析库会给这个 Deno 项目再加一层 npm 依赖与供应链风险；
 * 现有仓库里所有抓取解析（github / hellogithub / twitter）也都是这样按字段取的。
 *
 * 边界说明：不做严格 XML 校验，不处理自定义命名空间（只按标签名匹配），
 * 但支持 CDATA、实体、Atom 的 `<link href>` 形式——这几样覆盖了实测的 9 个真实 feed。
 */

import { decodeEntities, stripCdata } from "./text-utils.ts";

export type FeedFormat = "rss" | "atom";

export interface FeedItem {
  title: string;
  link: string;
  /** 完整正文（RSS 的 content:encoded / Atom 的 content），可能为空 */
  contentHtml: string;
  /** 摘要（RSS 的 description / Atom 的 summary） */
  summaryHtml: string;
  /** 原始时间字符串，未做格式转换 */
  publishedAt: string;
  guid: string;
  author: string;
}

export interface ParsedFeed {
  format: FeedFormat;
  feedTitle: string;
  feedLink: string;
  items: FeedItem[];
}

const ITEM_PATTERN = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
const ENTRY_PATTERN = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;

/** 取第一个匹配标签的文本内容。标签名大小写不敏感，允许带属性。 */
const pickText = (block: string, names: string[]): string => {
  for (const name of names) {
    const pattern = new RegExp(
      `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,
      "i",
    );
    const match = block.match(pattern);
    if (match && match[1]) {
      const value = decodeEntities(stripCdata(match[1])).trim();
      if (value) return value;
    }
  }
  return "";
};

/** 取标签属性值，例如 Atom 的 `<link rel="alternate" href="...">`。 */
const pickAttr = (
  block: string,
  tag: string,
  attr: string,
): string => {
  const pattern = new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`, "i");
  const match = block.match(pattern);
  return match ? decodeEntities(match[1]).trim() : "";
};

/**
 * Atom 的链接优先取 `rel="alternate"`（正文页），
 * 直接取第一个 `<link>` 有时会拿到 `rel="self"`（feed 自身地址）。
 */
const atomLink = (block: string): string => {
  const alternate = block.match(
    /<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]*)"/i,
  ) ?? block.match(/<link\b[^>]*\bhref="([^"]*)"[^>]*\brel="alternate"/i);
  if (alternate) return decodeEntities(alternate[1]).trim();
  const any = pickAttr(block, "link", "href");
  return any;
};

const parseItems = (xml: string, format: FeedFormat): FeedItem[] => {
  const items: FeedItem[] = [];
  const pattern = format === "rss" ? ITEM_PATTERN : ENTRY_PATTERN;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const block = match[1];
    const title = pickText(block, ["title"]);
    const link = format === "rss"
      ? pickText(block, ["link"]) || pickAttr(block, "link", "href")
      : atomLink(block);
    const contentHtml = format === "rss"
      ? pickText(block, ["content:encoded", "content"])
      : pickText(block, ["content"]);
    const summaryHtml = format === "rss"
      ? pickText(block, ["description", "summary"])
      : pickText(block, ["summary", "description"]);
    const publishedAt = format === "rss"
      ? pickText(block, ["pubDate", "dc:date", "published", "updated"])
      : pickText(block, ["published", "updated", "pubDate"]);
    const guid = pickText(block, ["guid", "id"]) || link;
    const author = pickText(block, ["dc:creator", "author", "name"]);

    if (!title && !link) continue;
    items.push({
      title,
      link,
      contentHtml,
      summaryHtml,
      publishedAt,
      guid,
      author,
    });
  }
  return items;
};

/** 判断一份文本是不是 feed；不是就返回 null，由调用方给出可操作的报错。 */
export const detectFeedFormat = (xml: string): FeedFormat | null => {
  const head = String(xml ?? "").slice(0, 4000);
  if (/<rss[\s>]/i.test(head) || /<rdf:RDF[\s>]/i.test(head)) return "rss";
  if (/<feed[\s>]/i.test(head)) return "atom";
  // 少数站点省略了根标签大小写或带命名空间前缀，退回按 item/entry 判断
  if (/<item[\s>]/i.test(xml) && /<channel[\s>]/i.test(xml)) return "rss";
  if (/<entry[\s>]/i.test(xml)) return "atom";
  return null;
};

export const parseFeed = (xml: string, limit = 30): ParsedFeed => {
  const format = detectFeedFormat(xml);
  if (!format) {
    throw new Error("响应内容不是 RSS/Atom feed（可能是网页或反爬拦截页）");
  }
  const items = parseItems(xml, format);
  const head = xml.slice(0, Math.max(0, xml.search(/<(item|entry)(?:\s|>)/i)));
  const feedTitle = pickText(head || xml, ["title"]);
  const feedLink = format === "atom"
    ? atomLink(head || xml)
    : pickText(head || xml, ["link"]);
  return {
    format,
    feedTitle,
    feedLink,
    items: limit > 0 ? items.slice(0, limit) : items,
  };
};
