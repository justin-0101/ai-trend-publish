import { getDataSources } from "../data-sources/getDataSources.ts";
import { ContentRanker } from "../modules/content-rank/ai.content-ranker.ts";
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
import { TwitterCookieScraper, TwitterFrontendScraper, TwitterScraper } from "../modules/scrapers/twitter.scraper.ts";
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
import { resolveCover } from "@src/utils/image/cover-fallback.ts";
import ProgressBar from "@deno-library/progress";

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
  debug: (msg: string, ...args: unknown[]) => console.debug(msg, ...args),
};

interface WeixinWorkflowEnv {
  name: string;
  draftWriter?: (draft: { title: string; html: string; workflowType: string }) => Promise<unknown>;
}

// 工作流参数类型定义
interface WeixinWorkflowParams {
  sourceType?: "all" | "firecrawl" | "twitter" | "twitter-cookie";
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
      const selectedFirecrawl = sourceType === "all" || sourceType === "firecrawl"
        ? sourceConfigs.firecrawl
        : [];
      const selectedTwitter = sourceType === "all" || sourceType === "twitter"
        ? sourceConfigs.twitter
        : [];
      const selectedTwitterCookie =
        sourceType === "all" || sourceType === "twitter-cookie"
          ? sourceConfigs["twitter-cookie"] || []
          : [];
      const totalSources = selectedFirecrawl.length + selectedTwitter.length +
        selectedTwitterCookie.length;

      if (totalSources === 0) {
        throw new WorkflowTerminateError("未配置任何数据源");
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

        for (const source of selectedTwitter) {
          const sourceContents = await this.scrapeSource(
            "Twitter",
            source,
            twitterScraper,
          );
          contents.push(...sourceContents);
          totalArticles += sourceContents.length;
          await scrapeProgress.render(++scrapeCompleted, {
            title:
              `抓取 Twitter: ${source.identifier} | 已获取文章: ${totalArticles}篇`,
          });
        }

        const twitterCookieScraper = this.scraper.get("twitter-cookie");
        if (!twitterCookieScraper) {
          throw new WorkflowTerminateError("TwitterCookieScraper not found");
        }
        const twitterFrontendScraper = this.scraper.get("twitter-frontend");
        if (!twitterFrontendScraper) {
          throw new WorkflowTerminateError("TwitterFrontendScraper not found");
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

        this.stats.contents = contents.length;
        if (this.stats.contents === 0) {
          throw new WorkflowTerminateError("未获取到任何内容，流程终止");
        }

        return contents;
      });

      const includeKeywords = Array.isArray(event.payload.includeKeywords)
        ? event.payload.includeKeywords.filter((x) => typeof x === "string")
          .map((x) => x.trim()).filter(Boolean)
        : [];
      const excludeKeywords = Array.isArray(event.payload.excludeKeywords)
        ? event.payload.excludeKeywords.filter((x) => typeof x === "string")
          .map((x) => x.trim()).filter(Boolean)
        : [];

      const filteredContents = allContents.filter((content) => {
        const text = `${content.title ?? ""}\n${content.content ?? ""}`.toLowerCase();
        if (excludeKeywords.length > 0) {
          const hit = excludeKeywords.some((k) => text.includes(k.toLowerCase()));
          if (hit) return false;
        }
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
        const ranked = await this.contentRanker.rankContents(filteredContents);
        if (ranked.length === 0) {
          throw new WorkflowTerminateError("内容排序失败，没有任何内容被评分");
        }
        // 先按分数排序
        ranked.sort((a, b) => b.score - a.score);
        logger.info("[内容排序] 内容排序完成");
        return ranked;
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
      if (publishMode === "draft") {
        const draftWriter = this.env.env.draftWriter;
        if (draftWriter) {
          await draftWriter({
            title: summaryTitle,
            html: renderedTemplate,
            workflowType: "weixin-article",
          });
        }
      }
      if (shouldPublish) {
        await step.do("publish-article", {
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
      } else {
        logger.info("[发布] 已跳过发布");
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
