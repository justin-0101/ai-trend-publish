import { AliWanX21ImageGenerator } from "@src/providers/image-gen/aliyun/aliwanx2.1.image.ts";
import { HelloGithubScraper } from "@src/modules/scrapers/hellogithub.scraper.ts";
import { WeixinPublisher } from "@src/modules/publishers/weixin.publisher.ts";
import { ImageGeneratorFactory } from "@src/providers/image-gen/image-generator-factory.ts";
import { resolveCover } from "@src/utils/image/cover-fallback.ts";
import { HelloGithubTemplateRenderer } from "@src/modules/render/hellogithub.renderer.ts";
import {
  WorkflowEntrypoint,
  WorkflowEnv,
  WorkflowEvent,
  WorkflowStep,
} from "@src/works/workflow.ts";
import { WorkflowTerminateError } from "@src/works/workflow-error.ts";
import {
  archiveDraft,
  markArchivedDraftPublished,
  readPublishFailure,
} from "./draft-archive.ts";
import { Logger } from "../utils/logger/logger.ts";
import { BarkNotifier } from "@src/modules/notify/bark.notify.ts";

const logger = Logger.getInstance();

interface WeixinHelloGithubWorkflowEnv {
  name: string;
  draftWriter?: (draft: { title: string; html: string; workflowType: string }) => Promise<unknown>;
  draftStatusWriter?: (
    id: string,
    status: "draft" | "published",
  ) => Promise<unknown>;
}

interface WeixinHelloGithubWorkflowParams {
  maxItems?: number;
  forcePublish?: boolean;
  publish?: boolean;
  publishMode?: "immediate" | "draft";
}

export class WeixinHelloGithubWorkflow extends WorkflowEntrypoint<
  WeixinHelloGithubWorkflowEnv,
  WeixinHelloGithubWorkflowParams
> {
  private scraper: HelloGithubScraper;
  private publisher: WeixinPublisher;
  private imageGenerator: AliWanX21ImageGenerator;
  private renderer: HelloGithubTemplateRenderer;
  private notify: BarkNotifier;

  constructor(env: WorkflowEnv<WeixinHelloGithubWorkflowEnv>) {
    super(env);
    this.scraper = new HelloGithubScraper();
    this.publisher = new WeixinPublisher();
    this.imageGenerator = new AliWanX21ImageGenerator();
    this.renderer = new HelloGithubTemplateRenderer();
    this.notify = new BarkNotifier();
  }

  /**
   * 刷新工作流所需的资源和配置
   */
  public async refresh(): Promise<void> {
    await this.publisher.refresh();
    await this.imageGenerator.refresh();
  }

  async run(
    event: WorkflowEvent<WeixinHelloGithubWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    try {
      logger.info(
        `[工作流开始] 开始执行HelloGithub数据处理, 当前工作流实例ID: ${this.env.id} 触发事件ID: ${event.id}`,
      );
      await this.notify.info("工作流开始", "开始执行HelloGithub数据处理");

      // 1. 获取热门项目数据
      const hotItems = await step.do("fetch-hot-items", {
        retries: { limit: 3, delay: "10 second", backoff: "exponential" },
        timeout: "5 minutes",
      }, async () => {
        logger.info("[数据获取] 开始获取热门项目数据");
        const items = await this.scraper.getHotItems(1);
        if (!items || items.length === 0) {
          throw new WorkflowTerminateError("未获取到任何热门项目数据");
        }
        return items;
      });

      // 2. 获取项目详情
      const items = await step.do("fetch-item-details", {
        retries: { limit: 3, delay: "10 second", backoff: "exponential" },
        timeout: "10 minutes",
      }, async () => {
        logger.info("[数据获取] 开始获取项目详情");
        const maxItems = event.payload.maxItems || 20;
        const details = await Promise.all(
          hotItems.slice(0, maxItems).map(async (item) => {
            logger.debug(`[项目详情] 获取项目: ${item.title}`);
            return await this.scraper.getItemDetail(item.itemId);
          }),
        );
        if (details.length === 0) {
          throw new WorkflowTerminateError("未获取到任何项目详情");
        }
        return details;
      });

      // 3. 生成封面图片
      const { imageUrl, mediaId } = await step.do("generate-cover", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "5 minutes",
      }, async () => {
        logger.info("[封面生成] 开始生成封面图片");
        const prompt =
          "GitHub AI 开源项目精选，展示代码和人工智能的融合，使用现代科技风格，蓝色和绿色为主色调";
        const cover = await resolveCover({
          label: "hellogithub:generate-cover",
          upload: (source) => this.publisher.uploadThumb(source),
          placeholder: { width: 1440, height: 768 },
          generate: async () => {
            const imageGenerator = await ImageGeneratorFactory.getInstance()
              .getGenerator("ALIWANX21");
            return await imageGenerator.generate({
              prompt,
              size: "1440*768",
            }) as string;
          },
        });
        if (cover.degraded) {
          logger.error("[封面降级] 本次运行未使用生成封面，继续出稿");
        }
        return { imageUrl: cover.imageUrl, mediaId: cover.mediaId };
      });

      // 4. 渲染内容
      const { title, htmlContent } = await step.do("generate-content", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "5 minutes",
      }, async () => {
        logger.info("[内容生成] 开始渲染内容");
        const firstItem = items[0];
        const title =
          `本期精选 GitHub 热门 AI 开源项目，第一名 ${firstItem.name} 项目备受瞩目，发现最新最酷的人工智能开源工具`;
        const html = await this.renderer.render(items);
        return { title, htmlContent: html };
      });

      const publishMode = event.payload.publishMode;
      const shouldPublish = publishMode === "draft"
        ? false
        : event.payload.forcePublish
        ? true
        : (event.payload.publish ?? true);

      // 先归档再发布：发布失败时内容不至于一起丢（详见 services/draft-archive.ts）
      const archivedDraftId = await archiveDraft(
        this.env.env,
        { title, html: htmlContent, workflowType: "weixin-hellogithub" },
        logger,
      );

      const publishResult = shouldPublish
        ? await step.do("publish-article", {
          retries: { limit: 3, delay: "10 second", backoff: "exponential" },
          timeout: "5 minutes",
        }, async () => {
          logger.info("[发布] 发布到微信公众号");
          // 标题与封面必须走 options：位置参数会被当成 options 丢掉
          return await this.publisher.publish(htmlContent, {
            title,
            thumbMediaId: mediaId,
          });
        })
        : { status: "skipped" };

      // publish() 失败时是返回 success:false，不抛异常，必须主动检查
      const failure = readPublishFailure(publishResult);
      if (failure) {
        throw new WorkflowTerminateError(
          `发布失败（内容已归档到本地草稿箱）：${failure}`,
        );
      }
      if (shouldPublish) {
        await markArchivedDraftPublished(this.env.env, archivedDraftId, logger);
      }

      // 6. 完成报告
      logger.info("[工作流] 工作流执行完成");
      logger.info(`[发布] 发布结果: ${JSON.stringify(publishResult)}`);
      await this.notify.success(
        "HelloGithub更新完成",
        `已生成最新的GitHub热门项目榜单\n发布状态: ${publishResult.status}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // 如果是终止错误，发送通知后直接抛出
      if (error instanceof WorkflowTerminateError) {
        await this.notify.warning("[工作流] 工作流终止", message);
        throw error;
      }

      logger.error(`[工作流] 执行失败: ${message}`);
      await this.notify.error("工作流失败", message);
      throw error;
    }
  }
}
