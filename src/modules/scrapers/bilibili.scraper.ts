/**
 * B站采集源。
 *
 * 实测（2026-09，本机网络）：
 *   ✅ `x/web-interface/popular`（综合热门）           → code=0，字段齐全，时间为当天
 *   ✅ `x/web-interface/newlist?rid=`（分区最新）        → code=0，data.archives，时间为当天
 *   ❌ `x/web-interface/ranking/v2`                    → code=-352（风控）
 *   ❌ `x/web-interface/popular/series/one`（每周必看）  → code=-352（风控）
 *   ❌ `x/space/arc/search?mid=`（UP 主投稿）           → HTTP 412，必须 WBI 签名
 *   ❌ `x/web-interface/ranking/region?rid=`（分区排行）→ 实测虽然 code=0，
 *      但返回的是**陈旧缓存**：2026-09-27 抓到的条目 create="2025-03-31 20:00"，
 *      这种素材进链路会被时效窗口（默认 180 天）全部淘汰，等于配了就白配，
 *      所以这一类不提供（宁可不做，也不做一个“配了却永远出不了稿”的源）。
 *
 * UP 主订阅留到第二阶段：要先取 nav 接口的 wbi 密钥、按混排表算签名，
 * 且带签名后仍可能被 412 拦，不能凭猜就写进采集器。
 *
 * 注意两个接口的字段名**并不一致**：popular 的时间字段是 `pubdate`，
 * newlist 的同样是 `pubdate`，但正文/作者在 popular 是 `desc`/`owner.name`。这里逐个适配。
 */

import {
  ContentScraper,
  ScrapedContent,
  ScraperOptions,
} from "../interfaces/scraper.interface.ts";
import { fetchJson } from "./fetch-text.ts";
import { formatUnixSeconds, snippet, toText } from "./text-utils.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
};

const BILI_HEADERS = {
  Referer: "https://www.bilibili.com/",
  Origin: "https://www.bilibili.com",
};

/** 实测可用的分区 rid 名称（其余一律要求填数字，避免猜错分区）。 */
export const BILIBILI_PARTITIONS: Record<string, number> = {
  knowledge: 36,
  tech: 188,
  digital: 95,
};

export type BilibiliMode = "popular" | "newlist";

export interface NormalizedBilibiliSource {
  mode: BilibiliMode;
  rid: number;
}

const MODE_ALIASES: Record<string, BilibiliMode> = {
  popular: "popular",
  hot: "popular",
  newlist: "newlist",
  newest: "newlist",
  new: "newlist",
};

const parseRid = (value: string): number => {
  const named = BILIBILI_PARTITIONS[value.toLowerCase()];
  if (named) return named;
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(
      `无法识别的分区：${value}（用数字 rid，例如 newlist:36；或名称 ${
        Object.keys(BILIBILI_PARTITIONS).join("/")
      }）`,
    );
  }
  return numeric;
};

/**
 * 接受这些写法：
 *   popular（综合热门）
 *   https://www.bilibili.com/v/popular/all
 *   newlist:188 / new:tech（分区最新）
 */
export const normalizeBilibiliSource = (
  sourceId: string,
): NormalizedBilibiliSource => {
  const raw = toText(sourceId);
  if (!raw) throw new Error("B站源为空");

  const [headRaw, tailRaw = ""] = raw.split(":");
  const head = headRaw.trim().toLowerCase();
  const mode = MODE_ALIASES[head];
  if (mode) {
    if (mode === "popular") return { mode, rid: 0 };
    const tail = tailRaw.trim();
    if (!tail) {
      throw new Error(`${mode} 需要指定分区，例如 ${mode}:36 或 ${mode}:tech`);
    }
    return { mode, rid: parseRid(tail) };
  }

  // 只有 http(s) 开头才当 URL：`new URL("ranking:36")` 会**解析成功**
  // （协议 ranking:、路径 36），继续走下去会报出“域名不是 bilibili.com”这种误导性错误。
  let url: URL;
  try {
    if (!/^https?:\/\//i.test(raw)) throw new Error("not-a-url");
    url = new URL(raw);
  } catch {
    throw new Error(
      `识别不出 B站源（示例：popular / newlist:188）：${raw}`,
    );
  }
  if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) {
    throw new Error(`B站源域名不是 bilibili.com：${url.hostname}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.includes("popular")) return { mode: "popular", rid: 0 };
  throw new Error(
    `识别不出 B站源类型：${raw}（示例：popular / newlist:188）`,
  );
};

export const buildBilibiliApiUrl = (
  source: NormalizedBilibiliSource,
  limit: number,
): string => {
  const ps = Math.min(Math.max(limit, 1), 50);
  switch (source.mode) {
    case "popular":
      return `https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=1`;
    case "newlist":
      return `https://api.bilibili.com/x/web-interface/newlist?rid=${source.rid}&ps=${ps}&pn=1`;
  }
};

interface BilibiliApiResponse<T> {
  code?: number;
  message?: string;
  data?: T;
}
/** 拼一段可读的素材正文：只有标题的话，后面 13 步 LLM 判断会用不上信息。 */
const composeBody = (parts: {
  title: string;
  desc: string;
  uploader: string;
  partition: string;
  stats: string;
}): string => {
  const lines = [parts.title];
  const meta = [
    parts.uploader && `UP主：${parts.uploader}`,
    parts.partition && `分区：${parts.partition}`,
    parts.stats && `数据：${parts.stats}`,
  ]
    .filter(Boolean)
    .join("｜");
  if (meta) lines.push("", meta);
  if (parts.desc && parts.desc !== "undefined") lines.push("", parts.desc);
  return lines.join("\n").trim();
};

const formatCount = (value: unknown): string => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "";
  if (num >= 10000) return `${(num / 10000).toFixed(1)} 万`;
  return String(num);
};

export class BilibiliScraper implements ContentScraper {
  /** 记录本次 mode，只为写进 metadata 便于溯源（popular/newlist 的正文结构相同） */
  private mode: BilibiliMode = "popular";

  async scrape(
    sourceId: string,
    options?: ScraperOptions,
  ): Promise<ScrapedContent[]> {
    const source = normalizeBilibiliSource(sourceId);
    this.mode = source.mode;
    const limit = options?.limit && options.limit > 0
      ? Math.min(options.limit, 50)
      : 20;
    const apiUrl = buildBilibiliApiUrl(source, limit);

    const payload = await fetchJson<
      BilibiliApiResponse<{
        list?: BilibiliVideo[];
        archives?: BilibiliVideo[];
      }>
    >(apiUrl, { headers: BILI_HEADERS });

    if (payload.code !== 0) {
      throw new Error(
        `B站接口返回 code=${payload.code}（${
          payload.message || "风控或参数错误"
        }）｜${snippet(apiUrl, 80)}`,
      );
    }

    const data = payload.data ?? {};
    const items = this.mapVideoItems(data.list ?? data.archives ?? []);

    if (items.length === 0) {
      throw new Error(
        `B站 ${source.mode} 返回 0 条（分区 rid=${source.rid} 可能有误）`,
      );
    }
    logger.info(
      `[B站] ${source.mode}${
        source.rid ? ` rid=${source.rid}` : ""
      }｜${items.length} 条`,
    );
    return items.slice(0, limit);
  }

  private mapVideoItems(list: BilibiliVideo[]): ScrapedContent[] {
    return list.map((item) => {
      const bvid = toText(item.bvid);
      return {
        id: bvid || String(item.aid ?? ""),
        title: toText(item.title) || bvid,
        content: composeBody({
          title: toText(item.title),
          desc: toText(item.desc),
          uploader: toText(item.owner?.name),
          partition: toText(item.tname),
          stats: item.stat?.view ? `播放 ${formatCount(item.stat.view)}` : "",
        }),
        url: bvid ? `https://www.bilibili.com/video/${bvid}` : "",
        publishDate: formatUnixSeconds(item.pubdate),
        metadata: {
          source: "bilibili",
          bvid,
          aid: item.aid,
          mode: this.mode,
          view: item.stat?.view,
        },
      } satisfies ScrapedContent;
    });
  }
}

interface BilibiliVideo {
  aid?: number;
  bvid?: string;
  title?: string;
  desc?: string;
  pubdate?: number;
  tname?: string;
  owner?: { mid?: number; name?: string };
  stat?: { view?: number };
}
