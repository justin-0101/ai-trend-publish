/**
 * 新采集器共用的文本处理工具。
 *
 * 为什么单独一个文件：RSS / Reddit / B站 / 知乎 四个采集器都要做
 * 「XML 实体解码」「HTML 转纯文本」「日期容错」这三件事，
 * 各写一份必然漂移（本项目已经有 5 份各自不同的 logger 就是这么来的）。
 */

import { formatDate } from "../../utils/common.ts";

/** 日志或错误信息里的短摘录，避免把整页 HTML 塞进日志。 */
export const snippet = (text: string, max = 160): string =>
  String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const fromCodePoint = (code: number): string => {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
};

/**
 * 解码 XML/HTML 实体。
 *
 * `&amp;` 必须最后处理：先处理它会把 `&amp;lt;` 二次解码成 `<`，
 * 把本来安全的文本变成标签，正文就丢了。
 */
export const decodeEntities = (text: string): string =>
  String(text ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "-")
    .replace(/&hellip;/g, "…")
    .replace(/&amp;/g, "&");

const CDATA_PATTERN = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

/** 去掉 `<![CDATA[...]]>` 外壳，保留内容原样（内容里可能还有 HTML）。 */
export const stripCdata = (text: string): string => {
  const match = String(text ?? "").match(CDATA_PATTERN);
  return match ? match[1] : String(text ?? "");
};

/**
 * HTML 转纯文本。
 *
 * 不引入解析库：这四个采集器只需要「能读的一段文字」，
 * 而正文的完整渲染交给下游的 renderer，采集层保持零依赖更好维护。
 */
export const htmlToPlainText = (html: string): string => {
  let text = String(html ?? "");
  // script/style 里的内容不是正文，去掉整块（而不是只去标签，否则 JS 代码会变成正文）
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return text
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
};

/**
 * 宽松的日期格式化。
 *
 * 不能用 `formatDate` 直接包一层就算：它遇到解析不了的日期会 **抛错**
 * （见 utils/common.ts），一个字段格式怪异的 feed 就能让整个源抓取失败。
 * 这里解析不了就返回空串——深度文链路把「无日期」当未知保留，而不是当过期丢掉。
 */
export const safeFormatDate = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "";
  try {
    const formatted = formatDate(String(value));
    return formatted;
  } catch {
    return "";
  }
};

/** Unix 秒级时间戳转统一的 publishDate 格式。 */
export const formatUnixSeconds = (seconds: unknown): string => {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  return safeFormatDate(new Date(value * 1000).toISOString());
};

/** 把任意输入收成去除首尾空格的非空字符串，否则返回 ""。 */
export const toText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
