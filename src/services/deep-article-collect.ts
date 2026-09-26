import { getDataSources } from "../data-sources/getDataSources.ts";
import {
  ContentScraper,
  ScrapedContent,
} from "../modules/interfaces/scraper.interface.ts";
import { BarkNotifier } from "../modules/notify/bark.notify.ts";
import { FireCrawlScraper } from "../modules/scrapers/fireCrawl.scraper.ts";
import {
  TwitterCookieScraper,
  TwitterFrontendScraper,
  TwitterScraper,
} from "../modules/scrapers/twitter.scraper.ts";
import { XSearchScraper } from "../modules/scrapers/x-search.scraper.ts";
import { RssScraper } from "../modules/scrapers/rss.scraper.ts";
import { RedditScraper } from "../modules/scrapers/reddit.scraper.ts";
import { BilibiliScraper } from "../modules/scrapers/bilibili.scraper.ts";
import { ZhihuScraper } from "../modules/scrapers/zhihu.scraper.ts";
import { dedupeScrapedContents, DroppedAt } from "./content-dedup.ts";
import {
  DEFAULT_MAX_AGE_DAYS,
  ExpiredMaterial,
  filterByAgeWindow,
  parsePublishDate,
} from "@src/modules/deep-article/material-date.ts";
import { ConfigManager } from "@src/utils/config/config-manager.ts";
import { readOptionalConfig } from "@src/utils/config/optional-config.ts";
import { WorkflowTerminateError } from "../works/workflow-error.ts";
import {
  DEFAULT_MIN_TWEET_CHARS,
  filterShortXMaterials,
  prioritizeXArticles,
  ShortXMaterial,
} from "@src/modules/deep-article/x-material.ts";

/**
 * 深度文的素材采集。
 *
 * 从工作流里抽出来单独成模块，原因有三个：
 *   1. 采集结果要能**留档审计**——「拿什么素材在做判断」和「判断成什么样」同等重要，
 *      而原始素材以前只在内存里，跑完就没了；
 *   2. 采集可以脱离 13 步 LLM 链路单独跑（复现一次采集只花几十秒，不用重跑整条流程）；
 *   3. 采集是唯一会碰外部数据源的环节，单独一个模块才好测。
 *
 * 返回完整的过程记录：抓到什么、去重掉了什么、被排除词筛掉什么、最终送进去什么。
 */

export type DeepCollectSourceType =
  | "all"
  | "firecrawl"
  | "twitter"
  | "twitter-cookie"
  | "x-search"
  | "rss"
  | "reddit"
  | "bilibili"
  | "zhihu";

export interface DeepCollectParams {
  sourceType?: DeepCollectSourceType;
  includeKeywords?: string[];
  excludeKeywords?: string[];
  maxMaterials?: number;
  /** 素材时效窗口（天）。默认 180（约 6 个月），见 DEEP_ARTICLE_MAX_AGE_DAYS */
  maxAgeDays?: number;
  /** X 推文长度门槛（字符）。低于它的推文不入主题包，见 DEEP_ARTICLE_MIN_TWEET_CHARS */
  minTweetChars?: number;
}

export interface DeepCollectLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
}

const defaultLogger: DeepCollectLogger = {
  info: (message: string, ...args: unknown[]) => console.log(message, ...args),
  warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
  error: (message: string, ...args: unknown[]) =>
    console.error(message, ...args),
  debug: (message: string, ...args: unknown[]) =>
    console.debug(message, ...args),
};

/** 每条素材的来源，与 `raw` 按下标对齐。 */
export interface MaterialOrigin {
  source: string;
  scraper: string;
  identifier: string;
}

export interface CollectOutcome {
  /** 与 `raw` 下标对齐的来源表：第 i 条来自哪里 */
  origin: MaterialOrigin[];
  /** 抓到的全部（去重之前） */
  raw: ScrapedContent[];
  /** 去重后 */
  deduped: ScrapedContent[];
  /** 被去重掉的，带在 raw 里的下标 */
  droppedDuplicates: DroppedAt[];
  /** 超出时效窗口被筛掉的 */
  expired: ExpiredMaterial[];
  /** 日期缺失或无法解析而被保留的 */
  undated: ScrapedContent[];
  /** 超出 maxMaterials 被截掉的 */
  truncated: ScrapedContent[];
  /** X 推文过短被筛掉的（几十个字的回复/转发没有可核验信息） */
  shortDropped: ShortXMaterial[];
  /** 命中排除词被筛掉的 */
  excluded: Array<{ content: ScrapedContent; word: string }>;
  /** 最终送入主题包提炼的 */
  materials: ScrapedContent[];
  /** 每个源的成功/失败，失败原因原样保留 */
  sourceResults: Array<{
    type: string;
    identifier: string;
    ok: boolean;
    count: number;
    error?: string;
  }>;
  maxMaterials: number;
  maxAgeDays: number;
  /** 本次生效的 X 推文长度门槛 */
  minTweetChars: number;
}

export interface DeepCollectDeps {
  scrapers?: Map<string, ContentScraper>;
  notifier?: Pick<BarkNotifier, "warning">;
  logger?: DeepCollectLogger;
}

/** 默认采集器集合。工作流与复现脚本共用，避免两边装的源不一致。 */
export const buildDeepArticleScrapers = (): Map<string, ContentScraper> => {
  const map = new Map<string, ContentScraper>();
  map.set("fireCrawl", new FireCrawlScraper());
  map.set("twitter", new TwitterScraper());
  map.set("twitter-cookie", new TwitterCookieScraper());
  map.set("twitter-frontend", new TwitterFrontendScraper());
  map.set("x-search", new XSearchScraper());
  map.set("rss", new RssScraper());
  map.set("reddit", new RedditScraper());
  map.set("bilibili", new BilibiliScraper());
  map.set("zhihu", new ZhihuScraper());
  return map;
};

const readMaxAgeDays = async (): Promise<number> => {
  const raw = await readOptionalConfig("DEEP_ARTICLE_MAX_AGE_DAYS");
  if (raw === null) return DEFAULT_MAX_AGE_DAYS;
  const value = typeof raw === "number"
    ? raw
    : Number.parseInt(String(raw), 10);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_AGE_DAYS;
};

const readMaxMaterials = async (): Promise<number> => {
  try {
    const configured = await ConfigManager.getInstance().get<number | string>(
      "DEEP_ARTICLE_MAX_ARTICLES",
    );
    const value = typeof configured === "number"
      ? configured
      : Number.parseInt(String(configured), 10);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  } catch {
    // 未配置时用默认值
  }
  return 60;
};

const readMinTweetChars = async (): Promise<number> => {
  const raw = await readOptionalConfig("DEEP_ARTICLE_MIN_TWEET_CHARS");
  if (raw === null) return DEFAULT_MIN_TWEET_CHARS;
  const value = typeof raw === "number"
    ? raw
    : Number.parseInt(String(raw), 10);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MIN_TWEET_CHARS;
};

export const collectDeepArticleMaterials = async (
  params: DeepCollectParams,
  deps: DeepCollectDeps = {},
): Promise<CollectOutcome> => {
  const log = deps.logger ?? defaultLogger;
  const notifier = deps.notifier ?? new BarkNotifier();
  const scrapers = deps.scrapers ?? buildDeepArticleScrapers();
  const includeKeywords = (params.includeKeywords ?? []).filter(Boolean);
  const excludeKeywords = (params.excludeKeywords ?? []).filter(Boolean);

  const configs = await getDataSources();
  // 默认 all 而不是 x-search：定时任务的 payload 是空的，
  // 默认走 x-search 会因为「没有关键词」直接终止，让这条链路在 cron 下必然跑不通。
  const sourceType = params.sourceType ?? "all";

  const selectedFirecrawl = sourceType === "all" || sourceType === "firecrawl"
    ? (configs.firecrawl ?? [])
    : [];
  const selectedTwitter = sourceType === "all" || sourceType === "twitter"
    ? (configs.twitter ?? [])
    : [];
  const selectedTwitterCookie =
    sourceType === "all" || sourceType === "twitter-cookie"
      ? (configs["twitter-cookie"] ?? [])
      : [];
  // x-search 不进 all：它要开着 Chrome、靠本机代理、单次约 1 分钟，
  // 混进「全量跑」会变成一次意料之外的浏览器自动化，失败时还会拖垮整条流程。
  // 与文章工作流保持同一个约定：要它就显式选。
  const selectedXSearch = sourceType === "x-search"
    ? includeKeywords.map((query) => ({ identifier: query }))
    : [];

  // 新增的四个预置类型。
  // 进 all 的：rss / bilibili / zhihu —— 都是一次纯 HTTP 请求，秒级返回，失败也不拖垮流程。
  // 不进 all 的：reddit —— Reddit 对同一 IP 严格限速（连续请求必 429），
  // 混进定时任务的「全量跑」只会多出一个随机失败的源；与 x-search 同一约定：要它就显式选。
  const selectedRss = sourceType === "all" || sourceType === "rss"
    ? (configs.rss ?? [])
    : [];
  const selectedBilibili = sourceType === "all" || sourceType === "bilibili"
    ? (configs.bilibili ?? [])
    : [];
  const selectedZhihu = sourceType === "all" || sourceType === "zhihu"
    ? (configs.zhihu ?? [])
    : [];
  const selectedReddit = sourceType === "reddit" ? (configs.reddit ?? []) : [];

  const totalSources = selectedFirecrawl.length + selectedTwitter.length +
    selectedTwitterCookie.length + selectedXSearch.length +
    selectedRss.length + selectedReddit.length + selectedBilibili.length +
    selectedZhihu.length;
  if (totalSources === 0) {
    throw new WorkflowTerminateError(
      sourceType === "x-search"
        ? "x-search 需要至少一个关键词（取自 includeKeywords）"
        : "未配置任何数据源",
    );
  }

  const origin: MaterialOrigin[] = [];
  const sourceResults: CollectOutcome["sourceResults"] = [];
  const raw: ScrapedContent[] = [];

  const runScraper = async (
    type: string,
    scraperName: string,
    identifier: string,
    scraper: ContentScraper | undefined,
  ): Promise<ScrapedContent[]> => {
    if (!scraper) {
      sourceResults.push({
        type,
        identifier,
        ok: false,
        count: 0,
        error: `缺少 ${scraperName} 采集器`,
      });
      return [];
    }
    try {
      const items = await scraper.scrape(identifier);
      sourceResults.push({ type, identifier, ok: true, count: items.length });
      for (const _ of items) {
        origin.push({ source: type, scraper: scraperName, identifier });
      }
      raw.push(...items);
      return items;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sourceResults.push({
        type,
        identifier,
        ok: false,
        count: 0,
        error: message,
      });
      log.error(`[深度文][${type}] ${identifier} 抓取失败:`, message);
      await notifier.warning(`${type}抓取失败`, `${identifier}\n${message}`);
      return [];
    }
  };

  for (const source of selectedFirecrawl) {
    await runScraper(
      "FireCrawl",
      "FireCrawl",
      source.identifier,
      scrapers.get("fireCrawl"),
    );
  }
  for (const source of selectedTwitter) {
    const primary = await runScraper(
      "Twitter",
      "Twitter",
      source.identifier,
      scrapers.get("twitter"),
    );
    if (primary.length === 0) {
      // 免费回退：twitterapi.io 欠费(402)或没配 key 时保证仍有素材
      await runScraper(
        "Twitter Frontend",
        "Twitter Frontend",
        source.identifier,
        scrapers.get("twitter-frontend"),
      );
    }
  }
  for (const source of selectedTwitterCookie) {
    const primary = await runScraper(
      "Twitter Cookie",
      "Twitter Cookie",
      source.identifier,
      scrapers.get("twitter-cookie"),
    );
    if (primary.length === 0) {
      await runScraper(
        "Twitter Frontend",
        "Twitter Frontend",
        source.identifier,
        scrapers.get("twitter-frontend"),
      );
    }
  }
  for (const source of selectedReddit) {
    await runScraper(
      "Reddit",
      "Reddit",
      source.identifier,
      scrapers.get("reddit"),
    );
  }

  for (const source of selectedRss) {
    await runScraper(
      "RSS",
      "RSS",
      source.identifier,
      scrapers.get("rss"),
    );
  }

  for (const source of selectedBilibili) {
    await runScraper(
      "B站",
      "B站",
      source.identifier,
      scrapers.get("bilibili"),
    );
  }

  for (const source of selectedZhihu) {
    await runScraper(
      "知乎",
      "知乎",
      source.identifier,
      scrapers.get("zhihu"),
    );
  }

  for (const source of selectedXSearch) {
    // x-search 不吞错：用户显式选了这个源，失败必须把可操作原因原样抛出来
    const scraper = scrapers.get("x-search");
    if (!scraper) throw new WorkflowTerminateError("缺少 x-search 采集器");
    const items = await scraper.scrape(source.identifier);
    sourceResults.push({
      type: "X 搜索",
      identifier: source.identifier,
      ok: true,
      count: items.length,
    });
    for (const _ of items) {
      origin.push({
        source: "X 搜索",
        scraper: "x-search",
        identifier: source.identifier,
      });
    }
    raw.push(...items);
  }

  // 按位置去重，不按 id：同一条推文会被 twitter 与 twitter-cookie 两个源各抽一次，
  // id 取的就是 url，按 id 过滤存活项会把重复项全捞回来（真跑实测：保留 21 却送出 41）。
  const { kept: deduped, dropped } = dedupeScrapedContents(raw);
  if (dropped.length > 0) {
    log.info(
      `[深度文][去重] 输入 ${raw.length} → 保留 ${deduped.length}（${
        dropped.slice(0, 3).map((item) => item.reason).join(", ")
      }${dropped.length > 3 ? " …" : ""}）`,
    );
  } else {
    log.info(
      `[深度文][去重] 输入 ${raw.length} → 保留 ${deduped.length}（无重复）`,
    );
  }

  // 时效窗口放在条数上限**之前**：先滤掉过期素材，上限才作用在当期素材上。
  // 反过来的话，二十条三年前的推文会把当天的素材挤在截断线外。
  const maxAgeDays = params.maxAgeDays ?? await readMaxAgeDays();
  const aged = filterByAgeWindow(deduped, { maxAgeDays });
  if (aged.expired.length > 0) {
    log.info(
      `[深度文][时效] 窗口 ${maxAgeDays} 天：筛掉过期 ${aged.expired.length} 条，保留 ${aged.kept.length} 条（其中 ${aged.undated.length} 条无日期）`,
    );
  } else if (aged.undated.length > 0) {
    log.info(
      `[深度文][时效] 窗口 ${maxAgeDays} 天：无过期；${aged.undated.length} 条无日期按保留处理`,
    );
  }

  // X 短推文过滤插在时效与条数上限之间：条数上限必须作用在"够长的"素材上，
  // 否则二十条 20 字的回复会把真正的长帖挤在截断线外（与时效窗口同理）。
  const minTweetChars = params.minTweetChars ?? await readMinTweetChars();
  const lengthFiltered = filterShortXMaterials(aged.kept, {
    minChars: minTweetChars,
  });
  if (lengthFiltered.dropped.length > 0) {
    log.info(
      `[深度文][X短推文] 门槛 ${minTweetChars} 字：筛掉 ${lengthFiltered.dropped.length} 条，保留 ${lengthFiltered.kept.length} 条`,
    );
  }

  const maxMaterials = params.maxMaterials ?? await readMaxMaterials();
  const limit = Math.max(1, maxMaterials);
  const prioritized = prioritizeXArticles(lengthFiltered.kept);
  const articleCount =
    prioritized.filter((item) => item.metadata?.xArticle === true).length;
  if (articleCount > 0) {
    log.info(`[深度文][X Article] 识别 ${articleCount} 条，已排在普通推文之前`);
  }
  const limited = prioritized.slice(0, limit);
  const truncated = prioritized.slice(limit);

  const excluded: CollectOutcome["excluded"] = [];
  const materials = limited.filter((content) => {
    const text = `${content.title ?? ""}\n${content.content ?? ""}`
      .toLowerCase();
    const hit = excludeKeywords.find((word) =>
      text.includes(word.toLowerCase())
    );
    if (hit) {
      excluded.push({ content, word: hit });
      return false;
    }
    return true;
  });

  log.info(
    `[深度文] 素材：抓到 ${raw.length} 条 → 去重后 ${deduped.length} 条 → 时效内 ${aged.kept.length} 条 → 过短 X 推文筛后 ${lengthFiltered.kept.length} 条 → 取前 ${limited.length} 条 → 排除词过滤后 ${materials.length} 条`,
  );

  return {
    origin,
    raw,
    deduped,
    droppedDuplicates: dropped,
    expired: aged.expired,
    undated: aged.undated,
    truncated,
    shortDropped: lengthFiltered.dropped,
    excluded,
    materials,
    sourceResults,
    maxMaterials,
    maxAgeDays,
    minTweetChars,
  };
};

/** 把发布时间换算成「N 天前」，写进清单里让时效一眼可见。 */
const ageLabel = (publishDate: unknown): string => {
  const date = parsePublishDate(publishDate);
  if (!date) return "（无法解析）";
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 0) return "（日期在未来）";
  if (days <= 1) return "（今天/昨天）";
  return `（${days} 天前）`;
};

/** 来源查询：按素材在 raw 里的下标取来源。 */
export const originOf = (
  outcome: CollectOutcome,
  content: ScrapedContent,
): MaterialOrigin | undefined => {
  const index = outcome.raw.indexOf(content);
  return index >= 0 ? outcome.origin[index] : undefined;
};

/** 素材清单的 markdown 渲染。工作流与复现脚本共用，保证两边格式一致。 */
export const renderCollectOutcome = (
  outcome: CollectOutcome,
  options: { fullText?: boolean } = {},
): string => {
  const fullText = options.fullText ?? true;
  const lines: string[] = [
    "# 素材清单（原始采集结果）",
    "",
    "> 这份文件回答一件事：**工作流当时到底拿到了什么素材**。",
    "> 主题包、领域判断、正文全部建立在这批素材上，所以它必须可查。",
    "",
    "## 汇总",
    "",
    `- 抓到（去重前）：${outcome.raw.length} 条`,
    `- 去重后：${outcome.deduped.length} 条（去掉 ${outcome.droppedDuplicates.length} 条重复）`,
    `- **时效窗口：${outcome.maxAgeDays} 天**（筛掉过期 ${outcome.expired.length} 条；${outcome.undated.length} 条无日期按保留处理）`,
    `- **X 推文长度门槛：${outcome.minTweetChars} 字**（筛掉过短 X 推文 ${outcome.shortDropped.length} 条；非 X 来源不受此限）`,
    `- 条数上限：${outcome.maxMaterials}（因此截掉 ${outcome.truncated.length} 条）`,
    `- 命中排除词筛掉：${outcome.excluded.length} 条`,
    `- **实际送入主题包提炼：${outcome.materials.length} 条**`,
    "",
    "## 数据源结果",
    "",
    "| 源 | 标识 | 结果 | 条数 | 失败原因 |",
    "|---|---|---|---:|---|",
  ];

  for (const result of outcome.sourceResults) {
    lines.push(
      `| ${result.type} | ${result.identifier} | ${
        result.ok ? "成功" : "失败"
      } | ${result.count} | ${result.error ?? ""} |`,
    );
  }

  lines.push(
    "",
    `## 实际送入主题包提炼的素材（${outcome.materials.length} 条）`,
    "",
  );
  if (outcome.materials.length === 0) {
    lines.push("（无）");
  }
  outcome.materials.forEach((content, index) => {
    const from = originOf(outcome, content);
    lines.push(
      `### ${index + 1}. ${content.title || "（无标题）"}`,
      "",
      `- 来源：${from?.source ?? "未知"}（${from?.identifier ?? "-"}）`,
      `- 发布时间：${content.publishDate || "未知"}${
        ageLabel(content.publishDate)
      }`,
      `- 链接：${content.url || "无"}`,
      `- 正文长度：${(content.content ?? "").length} 字`,
      "",
    );
    if (fullText) {
      lines.push(
        "正文：",
        "",
        "```text",
        (content.content ?? "").trim() || "（空）",
        "```",
        "",
      );
    }
  });

  if (outcome.expired.length > 0) {
    lines.push(
      `## 超出时效窗口被筛掉的素材（窗口 ${outcome.maxAgeDays} 天）`,
      "",
      "> 这一节是深度文的时效闸门：超过窗口的素材不进入主题包提炼，",
      "> 否则会拿一年前的公告当今天的新闻写。",
      "",
    );
    outcome.expired
      .slice()
      .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))
      .forEach(({ content, ageDays }) => {
        lines.push(
          `- **${ageDays} 天前**（${content.publishDate || "无日期"}）｜${
            content.title || "（无标题）"
          }`,
        );
      });
    lines.push("");
  }

  if (outcome.undated.length > 0) {
    lines.push(
      "## 日期无法解析的素材（已保留）",
      "",
      "> 日期缺失时按保留处理：把未知当已知会把新素材误判成旧的，代价更大。",
      "",
    );
    outcome.undated.forEach((content) => {
      const from = originOf(outcome, content);
      lines.push(
        `- \`${content.id}\`｜${content.title || "（无标题）"}｜发布字段原值：${
          JSON.stringify(content.publishDate ?? null)
        }${from ? `｜来自 ${from.source}` : ""}`,
      );
    });
    lines.push("");
  }

  if (outcome.droppedDuplicates.length > 0) {
    lines.push("## 被去重掉的素材", "");
    for (const entry of outcome.droppedDuplicates) {
      const original = outcome.raw[entry.atIndex];
      const from = outcome.origin[entry.atIndex];
      lines.push(
        `- #${entry.atIndex + 1} ` +
          `\`${entry.id}\`（原因 ${entry.reason}${
            entry.similarity === undefined ? "" : `，相似度 ${entry.similarity}`
          }）← 与 #${
            entry.duplicateOfIndex + 1
          } \`${entry.duplicateOf}\` 重复` +
          `${from ? `｜来自 ${from.source}` : ""}${
            original?.title ? `｜标题：${original.title}` : ""
          }`,
      );
    }
    lines.push("");
  }

  if (outcome.truncated.length > 0) {
    lines.push("## 因条数上限被截掉的素材", "");
    outcome.truncated.forEach((content) => {
      const from = originOf(outcome, content);
      lines.push(
        `- \`${content.id}\`｜${content.title || "（无标题）"}${
          from ? `｜来自 ${from.source}` : ""
        }`,
      );
    });
    lines.push("");
  }

  if (outcome.shortDropped.length > 0) {
    lines.push(
      "## 因过短被筛掉的 X 推文",
      "",
      `> 门槛 ${outcome.minTweetChars} 字。几十个字的回复/转发/感叹没有可核验信息，`,
      "> 拿它聚主题只会让「素材充分度」看起来比实际高。",
      "",
    );
    outcome.shortDropped.forEach(({ content, chars }) => {
      const from = originOf(outcome, content);
      lines.push(
        `- ${chars} 字｜\`${content.id}\`｜${content.title || "（无标题）"}${
          from ? `｜来自 ${from.source}` : ""
        }`,
      );
    });
    lines.push("");
  }

  if (outcome.excluded.length > 0) {
    lines.push("## 命中排除词被筛掉的素材", "");
    outcome.excluded.forEach(({ content, word }) => {
      lines.push(`- 命中「${word}」：${content.title || "（无标题）"}`);
    });
    lines.push("");
  }

  return lines.join("\n");
};
