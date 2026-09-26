import { getDataSources } from "../data-sources/getDataSources.ts";
import { ContentRanker } from "../modules/content-rank/ai.content-ranker.ts";
import { RankResult } from "../modules/interfaces/content-ranker.interface.ts";
import { ContentPublisher } from "../modules/interfaces/publisher.interface.ts";
import {
  ContentScraper,
  ScrapedContent,
} from "../modules/interfaces/scraper.interface.ts";
import { ContentSummarizer } from "../modules/interfaces/summarizer.interface.ts";
import { BarkNotifier } from "../modules/notify/bark.notify.ts";
import { WeixinPublisher } from "../modules/publishers/weixin.publisher.ts";
import { WeixinTemplate } from "../modules/render/interfaces/article.type.ts";
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
import { AISummarizer } from "../modules/summarizer/ai.summarizer.ts";
import { ImageGeneratorFactory } from "../providers/image-gen/image-generator-factory.ts";
import { WeixinArticleTemplateRenderer } from "../modules/render/article.renderer.ts";
import { ConfigManager } from "../utils/config/config-manager.ts";
import {
  WorkflowEntrypoint,
  WorkflowEnv,
  WorkflowEvent,
  WorkflowStep,
} from "../works/workflow.ts";
import { WorkflowTerminateError } from "../works/workflow-error.ts";
import {
  archiveDraft,
  markArchivedDraftPublished,
  readPublishFailure,
} from "./draft-archive.ts";
import { dedupeContents } from "./content-dedup.ts";
import { resolveCover } from "@src/utils/image/cover-fallback.ts";
import ProgressBar from "@deno-library/progress";

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
  debug: (msg: string, ...args: unknown[]) => console.debug(msg, ...args),
};

/**
 * 从「包含关键词」里拆出可用来判相关的检索词。
 *
 * 这几个词是 X 搜索表达式，不是纯词：
 *   `"generative engine optimization" OR 生成式引擎优化`
 * 整串拿去和正文做 includes 永远匹配不上（正文里不会同时出现引号和 OR），
 * 所以先按 OR 拆、去掉引号、丢掉过短的碎片。
 */
export const keywordTerms = (keywords: string[]): string[] => {
  const terms = new Set<string>();
  for (const raw of keywords) {
    for (const piece of String(raw).split(/\s+OR\s+/i)) {
      const term = piece.replace(/["'“”‘’()]/g, "").trim().toLowerCase();
      if (term.length >= 2) terms.add(term);
    }
  }
  return [...terms];
};

/**
 * 由检索词生成匹配器。
 *
 * 只按全称短语匹配会漏一大半：中文社区写「GEO」远多于写「生成式引擎优化」，
 * 实测同一批 30 条里，全称命中 10 条，加上缩写命中 20 条。
 * 所以多词英文短语额外用首字母缩写（generative engine optimization → GEO，
 * search engine optimization → SEO）按词边界匹配；这里不写死 GEO——
 * 写死一个词，换个话题就失效，而且 GEO 与 Geometry 这类词也得分得开。
 */
export const keywordMatchers = (
  terms: string[],
): Array<(text: string) => boolean> => {
  const matchers: Array<(text: string) => boolean> = [];
  const acronyms = new Set<string>();
  for (const term of terms) {
    matchers.push((text) => text.toLowerCase().includes(term));
    const words = term.split(/\s+/).filter((w) => /^[a-z]+$/.test(w));
    if (words.length >= 2) {
      acronyms.add(words.map((w) => w[0]).join("").toUpperCase());
    }
  }
  for (const acronym of acronyms) {
    if (acronym.length < 2) continue;
    const pattern = new RegExp(`(?<![A-Za-z])${acronym}(?![a-z])`);
    matchers.push((text) => pattern.test(text));
  }
  return matchers;
};

/**
 * 把「正文命中关键词」的条目排到前面，其余按原分数跟在后面补位。
 *
 * 为什么必须有这一步：排序分只看创新性/实用度/热度，**不含主题贴合度**。
 * 实测同一批采集（原始精度 82%），成稿 10 条里只有 2 条在题上——
 * 高热度的泛 AI 内容（AI 制药、Web3、Luma 教程…）把主题内容挤出了前 10。
 *
 * 是「先出相关的」，不是「只出相关的」：命中的不够 10 条时，仍用其余条目补满，
 * 否则等于把 x-search「宽匹配」这个前提又推翻了。
 */
export const prioritizeByKeywordRelevance = (
  ranked: RankResult[],
  contents: ScrapedContent[],
  terms: string[],
): RankResult[] => {
  const matchers = keywordMatchers(terms);
  if (matchers.length === 0) return ranked;
  const byId = new Map(contents.map((c) => [String(c.id), c]));
  const hitsKeyword = (item: RankResult): boolean => {
    const content = byId.get(String(item.id));
    if (!content) return false;
    const text = `${content.title ?? ""}\n${content.content ?? ""}`;
    return matchers.some((match) => match(text));
  };
  const relevant: RankResult[] = [];
  const others: RankResult[] = [];
  for (const item of ranked) {
    (hitsKeyword(item) ? relevant : others).push(item);
  }
  logger.info(
    `[排序] 关键词相关优先：命中 ${relevant.length} 条，未命中 ${others.length} 条（检索词: ${
      terms.join(" | ")
    }）`,
  );
  return [...relevant, ...others];
};

interface WeixinWorkflowEnv {
  name: string;
  draftWriter?: (
    draft: { title: string; html: string; workflowType: string },
  ) => Promise<unknown>;
  draftStatusWriter?: (
    id: string,
    status: "draft" | "published",
  ) => Promise<unknown>;
}

// 工作流参数类型定义
interface WeixinWorkflowParams {
  // x-search：X 关键词全网搜索，走浏览器自动化（skill: x-search-collector）。
  // 与 twitter/twitter-cookie（固定账号时间线）是两种不同的数据源，不能用关键词互相替代。
  sourceType?:
    | "all"
    | "firecrawl"
    | "twitter"
    | "twitter-cookie"
    | "x-search"
    | "rss"
    | "reddit"
    | "bilibili"
    | "zhihu";
  maxArticles?: number;
  forcePublish?: boolean;
  publish?: boolean;
  publishMode?: "immediate" | "draft";
  includeKeywords?: string[];
  excludeKeywords?: string[];
}

export class WeixinArticleWorkflow
  extends WorkflowEntrypoint<WeixinWorkflowEnv, WeixinWorkflowParams> {
  private scraper: Map<string, ContentScraper>;
  private summarizer: ContentSummarizer;
  private publisher: ContentPublisher;
  private notifier: BarkNotifier;
  private renderer: WeixinArticleTemplateRenderer;
  private contentRanker: ContentRanker;
  private stats = {
    success: 0,
    failed: 0,
    contents: 0,
  };

  constructor(env: WorkflowEnv<WeixinWorkflowEnv>) {
    super(env);
    this.scraper = new Map<string, ContentScraper>();
    this.scraper.set("fireCrawl", new FireCrawlScraper());
    this.scraper.set("twitter", new TwitterScraper());
    this.scraper.set("twitter-cookie", new TwitterCookieScraper());
    this.scraper.set("twitter-frontend", new TwitterFrontendScraper());
    this.scraper.set("x-search", new XSearchScraper());
    this.scraper.set("rss", new RssScraper());
    this.scraper.set("reddit", new RedditScraper());
    this.scraper.set("bilibili", new BilibiliScraper());
    this.scraper.set("zhihu", new ZhihuScraper());
    this.summarizer = new AISummarizer();
    this.publisher = new WeixinPublisher();
    this.notifier = new BarkNotifier();
    this.renderer = new WeixinArticleTemplateRenderer();
    this.contentRanker = new ContentRanker();
  }

  public getWorkflowStats(eventId: string) {
    return this.metricsCollector.getWorkflowEventMetrics(this.env.id, eventId);
  }

  async run(
    event: WorkflowEvent<WeixinWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    try {
      logger.info(
        `[工作流开始] 开始执行微信工作流, 当前工作流实例ID: ${this.env.id} 触发事件ID: ${event.id}`,
      );
      await this.notifier.info("工作流开始", "开始执行内容抓取和处理");

      // 获取数据源
      const sourceConfigs = await step.do("fetch-sources", async () => {
        const configs = await getDataSources();
        if (!configs.firecrawl) {
          throw new WorkflowTerminateError("未找到firecrawl数据源配置");
        }
        if (!configs.twitter && !configs["twitter-cookie"]) {
          throw new WorkflowTerminateError("未找到twitter数据源配置");
        }
        return configs;
      });

      const sourceType = event.payload.sourceType ?? "all";

      // 关键词必须在选源之前解析：x-search 源的关键词不是「事后过滤器」，而是「搜什么」本身。
      const includeKeywords = Array.isArray(event.payload.includeKeywords)
        ? event.payload.includeKeywords.filter((x) => typeof x === "string")
          .map((x) => x.trim()).filter(Boolean)
        : [];
      const excludeKeywords = Array.isArray(event.payload.excludeKeywords)
        ? event.payload.excludeKeywords.filter((x) => typeof x === "string")
          .map((x) => x.trim()).filter(Boolean)
        : [];

      const selectedFirecrawl =
        sourceType === "all" || sourceType === "firecrawl"
          ? sourceConfigs.firecrawl
          : [];
      const selectedTwitter = sourceType === "all" || sourceType === "twitter"
        ? sourceConfigs.twitter
        : [];
      const selectedTwitterCookie =
        sourceType === "all" || sourceType === "twitter-cookie"
          ? sourceConfigs["twitter-cookie"] || []
          : [];
      // x-search 不进 all：它要开着 Chrome、靠本机代理、单次约 1 分钟，
      // 把它塞进 all 会让每次「全量跑」都变成一次浏览器自动化，且失败时拖垮整条流程。
      // 要它就显式选。
      const selectedXSearch = sourceType === "x-search"
        ? includeKeywords.map((query) => ({ identifier: query }))
        : [];

      // 新增的四个预置类型，与 deep-article 采集链路保持完全一致的选源约定：
      // rss / bilibili / zhihu 进 all（都是秒级纯 HTTP）；reddit 不进 all（同 IP 严格限速，必 429）。
      const selectedRss = sourceType === "all" || sourceType === "rss"
        ? sourceConfigs.rss || []
        : [];
      const selectedBilibili = sourceType === "all" || sourceType === "bilibili"
        ? sourceConfigs.bilibili || []
        : [];
      const selectedZhihu = sourceType === "all" || sourceType === "zhihu"
        ? sourceConfigs.zhihu || []
        : [];
      const selectedReddit = sourceType === "reddit"
        ? sourceConfigs.reddit || []
        : [];
      const totalSources = selectedFirecrawl.length + selectedTwitter.length +
        selectedTwitterCookie.length + selectedXSearch.length +
        selectedRss.length + selectedReddit.length + selectedBilibili.length +
        selectedZhihu.length;

      if (totalSources === 0) {
        throw new WorkflowTerminateError(
          sourceType === "x-search"
            ? "X 关键词搜索需要至少一个关键词（搜索词取自「包含关键词」）"
            : "未配置任何数据源",
        );
      }

      logger.info(`[数据源] 发现 ${totalSources} 个数据源`);

      // 3. 抓取内容
      const allContents = await step.do("scrape-contents", {
        retries: { limit: 3, delay: "10 second", backoff: "exponential" },
        timeout: "10 minutes",
      }, async () => {
        const contents: ScrapedContent[] = [];

        // 创建抓取进度条
        const scrapeProgress = new ProgressBar({
          title: "内容抓取进度",
          total: totalSources,
          clear: true, // 完成后清除进度条
          display: ":title | :percent | :completed/:total | :time \n",
        });
        let scrapeCompleted = 0;
        let totalArticles = 0;

        // FireCrawl sources
        const fireCrawlScraper = this.scraper.get("fireCrawl");
        if (!fireCrawlScraper) {
          throw new WorkflowTerminateError("FireCrawlScraper not found");
        }

        for (const source of selectedFirecrawl) {
          const sourceContents = await this.scrapeSource(
            "FireCrawl",
            source,
            fireCrawlScraper,
          );
          contents.push(...sourceContents);
          totalArticles += sourceContents.length;
          await scrapeProgress.render(++scrapeCompleted, {
            title:
              `抓取 FireCrawl: ${source.identifier}  | 已获取文章: ${totalArticles}篇`,
          });
        }

        // Twitter sources
        const twitterScraper = this.scraper.get("twitter");
        if (!twitterScraper) {
          throw new WorkflowTerminateError("TwitterScraper not found");
        }
        const twitterCookieScraper = this.scraper.get("twitter-cookie");
        if (!twitterCookieScraper) {
          throw new WorkflowTerminateError("TwitterCookieScraper not found");
        }
        const twitterFrontendScraper = this.scraper.get("twitter-frontend");
        if (!twitterFrontendScraper) {
          throw new WorkflowTerminateError("TwitterFrontendScraper not found");
        }
        const xSearchScraper = this.scraper.get("x-search");
        if (!xSearchScraper) {
          throw new WorkflowTerminateError("XSearchScraper not found");
        }
        const rssScraper = this.scraper.get("rss");
        if (!rssScraper) {
          throw new WorkflowTerminateError("RssScraper not found");
        }
        const redditScraper = this.scraper.get("reddit");
        if (!redditScraper) {
          throw new WorkflowTerminateError("RedditScraper not found");
        }
        const bilibiliScraper = this.scraper.get("bilibili");
        if (!bilibiliScraper) {
          throw new WorkflowTerminateError("BilibiliScraper not found");
        }
        const zhihuScraper = this.scraper.get("zhihu");
        if (!zhihuScraper) {
          throw new WorkflowTerminateError("ZhihuScraper not found");
        }

        // 新增四个类型的抓取。都走 scrapeSource（吞错 + 通知 + 计数），
        // 因为它们都有明确的错误信息（feed 不是 feed、限速、分区写错），
        // 单源失败不应该让整条文章流程终止。
        for (const source of selectedRss) {
          const sourceContents = await this.scrapeSource(
            "RSS",
            source,
            rssScraper,
          );
          contents.push(...sourceContents);
          totalArticles += sourceContents.length;
          await scrapeProgress.render(++scrapeCompleted, {
            title:
              `抓取 RSS: ${source.identifier} | 已获取文章: ${totalArticles}篇`,
          });
        }

        for (const source of selectedReddit) {
          const sourceContents = await this.scrapeSource(
            "Reddit",
            source,
            redditScraper,
          );
          contents.push(...sourceContents);
          totalArticles += sourceContents.length;
          await scrapeProgress.render(++scrapeCompleted, {
            title:
              `抓取 Reddit: ${source.identifier} | 已获取文章: ${totalArticles}篇`,
          });
        }

        for (const source of selectedBilibili) {
          const sourceContents = await this.scrapeSource(
            "B站",
            source,
            bilibiliScraper,
          );
          contents.push(...sourceContents);
          totalArticles += sourceContents.length;
          await scrapeProgress.render(++scrapeCompleted, {
            title:
              `抓取 B站: ${source.identifier} | 已获取文章: ${totalArticles}篇`,
          });
        }

        for (const source of selectedZhihu) {
          const sourceContents = await this.scrapeSource(
            "知乎",
            source,
            zhihuScraper,
          );
          contents.push(...sourceContents);
          totalArticles += sourceContents.length;
          await scrapeProgress.render(++scrapeCompleted, {
            title:
              `抓取 知乎: ${source.identifier} | 已获取文章: ${totalArticles}篇`,
          });
        }

        for (const source of selectedTwitter) {
          // twitterapi.io 欠费(402)或没配 key 时，不能让整条流程直接空手而归：
          // 回退到的 syndication 时间线是免密钥的，能保证有稿可出。
          const sourceContents = await this.scrapeSourceWithFallback(
            "Twitter",
            source,
            twitterScraper,
            "Twitter Frontend",
            twitterFrontendScraper,
          );
          contents.push(...sourceContents);
          totalArticles += sourceContents.length;
          await scrapeProgress.render(++scrapeCompleted, {
            title:
              `抓取 Twitter: ${source.identifier} | 已获取文章: ${totalArticles}篇`,
          });
        }

        for (const source of selectedTwitterCookie) {
          const sourceContents = await this.scrapeSourceWithFallback(
            "Twitter Cookie",
            source,
            twitterCookieScraper,
            "Twitter Frontend",
            twitterFrontendScraper,
          );
          contents.push(...sourceContents);
          totalArticles += sourceContents.length;
          await scrapeProgress.render(++scrapeCompleted, {
            title:
              `抓取 Twitter Cookie: ${source.identifier} | 已获取文章: ${totalArticles}篇`,
          });
        }

        // X 关键词全网搜索：调用 skill x-search-collector（浏览器自动化）。
        // 这里故意不走 scrapeSource/scrapeSourceWithFallback：
        //   1. 没有等价回退源 —— fallback 到账号时间线会给出「与关键词无关的内容」却当成功，
        //      比直接失败更坏；
        //   2. 不能吞错 —— 用户是显式选的这个源，失败时必须把「代理没开 / 扩展离线 /
        //      未登录 X」这类可操作原因原样抛出，而不是退化成一个“未获取到任何内容”。
        for (const source of selectedXSearch) {
          logger.debug(`[X搜索] 抓取: ${source.identifier}`);
          try {
            const sourceContents = await xSearchScraper.scrape(
              source.identifier,
            );
            this.stats.success++;
            contents.push(...sourceContents);
            totalArticles += sourceContents.length;
            await scrapeProgress.render(++scrapeCompleted, {
              title:
                `X搜索: ${source.identifier} | 已获取文章: ${totalArticles}篇`,
            });
          } catch (error) {
            this.stats.failed++;
            const message = error instanceof Error
              ? error.message
              : String(error);
            logger.error(`[X搜索] ${source.identifier} 抓取失败:`, message);
            await this.notifier.warning(
              "X搜索抓取失败",
              `关键词: ${source.identifier}\n${message}`,
            );
            throw new WorkflowTerminateError(
              `X 搜索采集失败（关键词: ${source.identifier}）：${message}`,
            );
          }
        }

        // twitter 与 twitter-cookie 两个源现在都可能落到同一条 syndication 时间线，
        // 不按 id 去重会把同一条推文重复写进同一篇文章。
        const seenIds = new Set<string>();
        const deduped = contents.filter((content) => {
          const key = String(content.id || content.url || "").trim();
          if (!key) return true;
          if (seenIds.has(key)) return false;
          seenIds.add(key);
          return true;
        });
        if (deduped.length !== contents.length) {
          logger.info(`[去重] ${contents.length} → ${deduped.length}`);
        }

        this.stats.contents = deduped.length;
        if (this.stats.contents === 0) {
          throw new WorkflowTerminateError("未获取到任何内容，流程终止");
        }

        return deduped;
      });

      // 关键词过滤只对「按时间线/站点抓来的内容」有意义，对 x-search 不适用：
      // x-search 的关键词是搜索请求本身，X 的检索是宽匹配——用同一个词再筛一遍正文，
      // 会把「搜到了但正文没字面命中」的内容全剔掉，最后报「过滤后无可用内容」。
      // 这正是之前「设了 GEO 却一条都没有」的假故障成因。
      const filteredContents = allContents.filter((content) => {
        const text = `${content.title ?? ""}\n${content.content ?? ""}`
          .toLowerCase();
        if (excludeKeywords.length > 0) {
          const hit = excludeKeywords.some((k) =>
            text.includes(k.toLowerCase())
          );
          if (hit) return false;
        }
        if (content.metadata?.platform === "x-search") return true;
        if (includeKeywords.length > 0) {
          return includeKeywords.some((k) => text.includes(k.toLowerCase()));
        }
        return true;
      });

      if (filteredContents.length !== allContents.length) {
        logger.info(
          `[过滤] ${allContents.length} → ${filteredContents.length}（包含: ${includeKeywords.length}，排除: ${excludeKeywords.length}）`,
        );
      }
      if (filteredContents.length === 0) {
        throw new WorkflowTerminateError("过滤后无可用内容，流程终止");
      }

      // 4. 内容排序
      const rankedContents = await step.do("rank-contents", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "5 minutes",
      }, async () => {
        logger.info(`[内容排序] 开始排序 ${filteredContents.length} 条内容`);
        // 关键词要传进排序：不传时 LLM 只能按「AI 热度」打分，
        // 结果就是主题内容被泛 AI 热点挤掉（实测成稿 10 条只剩 2 条在题上）。
        const ranked = await this.contentRanker.rankContents(
          filteredContents,
          includeKeywords,
        );
        if (ranked.length === 0) {
          throw new WorkflowTerminateError("内容排序失败，没有任何内容被评分");
        }
        // LLM 漏评的条目按 0 分补在末尾：不补等于被悄悄丢掉。
        // 提示词已要求它返回全部（去重已改由代码做），这里兜的是「没听劝」的情况。
        const scoredIds = new Set(ranked.map((item) => String(item.id)));
        const skipped = filteredContents.filter(
          (content) => !scoredIds.has(String(content.id)),
        );
        if (skipped.length > 0) {
          logger.info(
            `[排序] LLM 漏评 ${skipped.length} 条（共 ${filteredContents.length} 条），按 0 分补在末尾`,
          );
          ranked.push(...skipped.map((content) => ({
            id: String(content.id),
            score: 0,
          })));
        }
        // 先按分数排序
        ranked.sort((a, b) => b.score - a.score);
        // 再让「正文命中关键词」的排到前面：分数里没有主题贴合度这一维，
        // 不重排的话高热度泛 AI 内容会稳定挤掉主题内容。
        const ordered = prioritizeByKeywordRelevance(
          ranked,
          filteredContents,
          keywordTerms(includeKeywords),
        );
        // 去重放最后一步：此处顺序已是「关键词命中在前、同组内按分数降序」，
        // 「保留先出现的」就等于「留下最相关、分最高的那条」，不需要再写一遍关键词逻辑。
        // 更重要的是：去重不再交给 LLM —— 它之前会顺手把「同主题、不同事件」的内容
        // 也合并掉（30 条常只回来 17~29 条），丢哪条不可控、也无法审计。
        const { kept, dropped } = dedupeContents(ordered, filteredContents);
        if (dropped.length > 0) {
          const detail = dropped
            .map((d) =>
              `${d.reason}:${d.id}→${d.duplicateOf}${
                d.similarity === undefined ? "" : `(${d.similarity})`
              }`
            )
            .slice(0, 5)
            .join(", ");
          logger.info(
            `[去重] 输入 ${ordered.length} → 保留 ${kept.length}｜${detail}${
              dropped.length > 5 ? " …" : ""
            }`,
          );
        } else {
          // 0 合并也要留一行：否则「去重到底跑没跑」在日志里看不出来
          logger.info(
            `[去重] 输入 ${ordered.length} → 保留 ${kept.length}（无重复）`,
          );
        }
        logger.info("[内容排序] 内容排序完成");
        return kept;
      });

      // 5. 处理排序后的内容
      const processedContents = await step.do("process-contents", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "15 minutes",
      }, async () => {
        // 根据排名顺序获取对应的文章内容
        const topContents: ScrapedContent[] = [];
        const maxArticles = event.payload.maxArticles ||
          await ConfigManager.getInstance().get("ARTICLE_NUM");

        for (const ranked of rankedContents.slice(0, maxArticles)) {
          const content = filteredContents.find((c) => c.id === ranked.id);
          if (content) {
            content.metadata.score = ranked.score;
            content.metadata.wordCount = content.content.length;
            content.metadata.readTime = Math.ceil(
              content.metadata.wordCount / 275,
            );
            topContents.push(content);
          }
        }

        logger.debug(
          "[内容处理] 取出的文章（润色前）：",
          JSON.stringify(topContents, null, 2),
        );

        // 创建内容处理进度条
        const processProgress = new ProgressBar({
          title: "内容处理进度",
          total: topContents.length,
          clear: true,
          display: ":title | :percent | :completed/:total | :time \n",
        });
        let processCompleted = 0;

        // 并发处理所有内容
        await Promise.all(topContents.map(async (content, _) => {
          await this.processContent(content);
          await processProgress.render(++processCompleted, {
            title: `已处理: ${content.title?.slice(0, 5) || "无标题"}...`,
          });
        }));

        logger.debug(
          "[内容处理] 处理后的内容",
          JSON.stringify(topContents, null, 2),
        );
        return topContents;
      });

      // 6. 生成文章
      const { summaryTitle, mediaId, renderedTemplate } = await step.do(
        "generate-article",
        {
          retries: { limit: 2, delay: "5 second", backoff: "exponential" },
          timeout: "10 minutes",
        },
        async () => {
          // 准备模板数据
          const templateData: WeixinTemplate[] = processedContents.map(
            (content) => ({
              id: content.id,
              title: content.title,
              content: content.content,
              url: content.url,
              publishDate: content.publishDate,
              metadata: content.metadata,
              keywords: content.metadata.keywords,
              media: content.media,
            }),
          );

          // 生成总标题
          const title = await this.summarizer.generateTitle(
            processedContents.map((c) => c.title).join(" | "),
          ).then((t) => {
            t = `${new Date().toLocaleDateString()} AI速递 | ${t}`;
            return t.slice(0, 64);
          });

          // 生成封面图 + 上传成素材（thumb_media_id）：失败时按 COVER_FALLBACK_MODE 降级，
          // 不再让第三方图片服务（欠费/限额）把整条出稿流程卡死。
          const cover = await resolveCover({
            label: "article:generate-article",
            upload: (source) => this.publisher.uploadThumb(source),
            placeholder: { width: 1200, height: 400 },
            generate: async () => {
              const imageGenerator = await ImageGeneratorFactory.getInstance()
                .getGenerator("ALIWANX_POSTER");
              return await imageGenerator.generate({
                title: title.split(" | ")[1].trim().slice(0, 30),
                sub_title: new Date().toLocaleDateString() + " AI速递",
                prompt_text_zh: `科技前沿资讯 | 人工智能新闻 | 每日AI快报 - ${
                  title.split(" | ")[1].trim().slice(0, 30)
                }`,
                generate_mode: "generate",
                generate_num: 1,
              }) as string;
            },
          });
          const media = cover.mediaId;

          // 渲染模板
          const template = await this.renderer.render(templateData);

          return {
            summaryTitle: title,
            mediaId: media,
            renderedTemplate: template,
          };
        },
      );

      const publishMode = event.payload.publishMode;
      const shouldPublish = publishMode === "draft"
        ? false
        : event.payload.forcePublish
        ? true
        : (event.payload.publish ?? true);

      // 「真发 + 归档」：不论哪种发布方式都先落一份本地草稿，再决定要不要发。
      // 顺序不能反——反过来的话，发布一旦失败（IP 白名单/限流/网络），
      // 文章连本地都不剩，整轮白跑。
      const archivedDraftId = await archiveDraft(
        this.env.env,
        {
          title: summaryTitle,
          html: renderedTemplate,
          workflowType: "weixin-article",
        },
        logger,
      );

      if (shouldPublish) {
        const publishResult = await step.do("publish-article", {
          retries: { limit: 3, delay: "10 second", backoff: "exponential" },
          timeout: "5 minutes",
        }, async () => {
          logger.info("[发布] 发布到微信公众号");
          // 封面与标题必须通过 options 传，位置参数会被当成 options（草稿标题/封面会丢）
          return await this.publisher.publish(renderedTemplate, {
            title: summaryTitle,
            thumbMediaId: mediaId,
          });
        });

        // publish() 用返回值报错、不抛异常：不查 success 就会出现
        // 「工作流显示成功、实际什么都没发出去」。本地草稿已在上一步存好，
        // 所以这里直接失败是安全的——内容不会丢。
        const failure = readPublishFailure(publishResult);
        if (failure) {
          throw new WorkflowTerminateError(
            `发布失败（内容已归档到本地草稿箱）：${failure}`,
          );
        }
        await markArchivedDraftPublished(this.env.env, archivedDraftId, logger);
      } else {
        logger.info("[发布] 已跳过发布（存档模式）");
      }

      // 8. 完成报告
      const summary = `
        工作流执行完成
        - 数据源: ${totalSources} 个
        - 成功: ${this.stats.success} 个
        - 失败: ${this.stats.failed} 个
        - 内容: ${this.stats.contents} 条
        - 发布: 成功`.trim();

      logger.info(`[工作流完成] ${summary}`);

      if (this.stats.failed > 0) {
        await this.notifier.warning("工作流完成(部分失败)", summary);
      } else {
        await this.notifier.success("工作流完成", summary);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // 如果是终止错误，发送通知后直接抛出
      if (error instanceof WorkflowTerminateError) {
        await this.notifier.warning("工作流终止", message);
        throw error;
      }

      logger.error("[工作流] 执行失败:", message);
      await this.notifier.error("工作流失败", message);
      throw error;
    }
  }

  private async scrapeSource(
    type: string,
    source: { identifier: string },
    scraper: ContentScraper,
  ): Promise<ScrapedContent[]> {
    try {
      logger.debug(`[${type}] 抓取: ${source.identifier}`);
      const contents = await scraper.scrape(source.identifier);
      this.stats.success++;
      return contents;
    } catch (error) {
      this.stats.failed++;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${type}] ${source.identifier} 抓取失败:`, message);
      await this.notifier.warning(
        `${type}抓取失败`,
        `源: ${source.identifier}\n错误: ${message}`,
      );
      return [];
    }
  }

  private async scrapeSourceWithFallback(
    type: string,
    source: { identifier: string },
    primary: ContentScraper,
    fallbackType: string,
    fallback: ContentScraper,
  ): Promise<ScrapedContent[]> {
    try {
      logger.debug(`[${type}] 抓取: ${source.identifier}`);
      const contents = await primary.scrape(source.identifier);
      this.stats.success++;
      return contents;
    } catch (error) {
      this.stats.failed++;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${type}] ${source.identifier} 抓取失败:`, message);
      await this.notifier.warning(
        `${type}抓取失败`,
        `源: ${source.identifier}\n错误: ${message}\n将尝试备用方案`,
      );
    }
    try {
      logger.debug(`[${fallbackType}] 抓取: ${source.identifier}`);
      const contents = await fallback.scrape(source.identifier);
      this.stats.success++;
      return contents;
    } catch (error) {
      this.stats.failed++;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${fallbackType}] ${source.identifier} 抓取失败:`, message);
      await this.notifier.warning(
        `${fallbackType}抓取失败`,
        `源: ${source.identifier}\n错误: ${message}`,
      );
      return [];
    }
  }

  private async processContent(content: ScrapedContent): Promise<void> {
    try {
      const summary = await this.summarizer.summarize(JSON.stringify(content));
      content.title = summary.title;
      content.content = summary.content;
      content.metadata.keywords = summary.keywords;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[内容处理] ${content.id} 处理失败:`, message);
      await this.notifier.warning(
        "内容处理失败",
        `ID: ${content.id}\n保留原始内容`,
      );
      content.title = content.title || "无标题";
      content.content = content.content || "内容处理失败";
      content.metadata.keywords = content.metadata.keywords || [];
    }
  }
}
