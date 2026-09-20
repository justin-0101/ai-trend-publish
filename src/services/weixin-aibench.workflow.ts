import { LiveBenchAPI } from "@src/api/livebench.api.ts";
import { AIBenchTemplateRenderer } from "@src/modules/render/index.ts";
import { WeixinPublisher } from "@src/modules/publishers/weixin.publisher.ts";
import {
  CategoryData,
  ModelScore,
} from "@src/modules/render/interfaces/aibench.type.ts";
import { BarkNotifier } from "@src/modules/notify/bark.notify.ts";
import { ImageGeneratorFactory } from "@src/providers/image-gen/image-generator-factory.ts";
import { resolveCover } from "@src/utils/image/cover-fallback.ts";
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

const logger = Logger.getInstance();

interface WeixinAIBenchWorkflowEnv {
  name: string;
  draftWriter?: (draft: { title: string; html: string; workflowType: string }) => Promise<unknown>;
  draftStatusWriter?: (
    id: string,
    status: "draft" | "published",
  ) => Promise<unknown>;
}

interface WeixinAIBenchWorkflowParams {
  forcePublish?: boolean;
  publish?: boolean;
  publishMode?: "immediate" | "draft";
}

export class WeixinAIBenchWorkflow extends WorkflowEntrypoint<
  WeixinAIBenchWorkflowEnv,
  WeixinAIBenchWorkflowParams
> {
  private liveBenchAPI: LiveBenchAPI;
  private renderer: AIBenchTemplateRenderer;
  private notify: BarkNotifier;
  private publisher: WeixinPublisher;

  constructor(env: WorkflowEnv<WeixinAIBenchWorkflowEnv>) {
    super(env);
    this.liveBenchAPI = new LiveBenchAPI();
    this.renderer = new AIBenchTemplateRenderer();
    this.notify = new BarkNotifier();
    this.publisher = new WeixinPublisher();
  }

  async generateCoverImage(title: string): Promise<string> {
    // 生成封面图并获取URL
    const imageGenerator = await ImageGeneratorFactory.getInstance()
      .getGenerator("PDD920_LOGO");
    const imageResult = await imageGenerator.generate({
      t: "@AISPACE科技空间",
      text: title,
      type: "json",
    });

    // 由于type为json，imageResult一定是包含url的对象
    return imageResult as string;
  }

  async run(
    event: WorkflowEvent<WeixinAIBenchWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    try {
      logger.info(
        `[工作流开始] 开始执行AI Benchmark数据处理, 当前工作流实例ID: ${this.env.id} 触发事件ID: ${event.id}`,
      );

      // 1. 获取模型性能数据
      const modelData = await step.do("fetch-model-data", {
        retries: { limit: 3, delay: "10 second", backoff: "exponential" },
        timeout: "5 minutes",
      }, async () => {
        logger.info("[数据获取] 开始获取模型性能数据");
        const data = await this.liveBenchAPI.getModelPerformance();
        if (!data || Object.keys(data).length === 0) {
          throw new WorkflowTerminateError("未获取到任何模型性能数据");
        }
        return data;
      });

      logger.debug(`[数据获取] 模型性能数据: ${JSON.stringify(modelData)}`);

      // 2. 找出性能最好的模型
      const topModel = await step.do("analyze-top-model", async () => {
        const sorted = Object.entries(modelData)
          .sort((a, b) =>
            b[1].metrics["Global Average"] - a[1].metrics["Global Average"]
          );
        if (sorted.length === 0) {
          throw new WorkflowTerminateError("无法确定排名最高的模型");
        }
        return sorted[0];
      });

      const topModelName = topModel[0];
      const topModelOrg = topModel[1].organization || "未知机构";

      // 3. 准备模板数据
      const templateData = await step.do("prepare-template-data", async () => {
        const data = {
          title: `${topModelName}领跑！AI模型性能榜单 - ${
            new Date().toLocaleDateString()
          }`,
          updateTime: new Date().toISOString(),
          categories: [] as CategoryData[],
          globalTop10: [] as ModelScore[],
        };

        // 转换数据格式
        const formattedData = this.renderer.transformData(modelData);
        data.categories = formattedData.categories;
        data.globalTop10 = formattedData.globalTop10.slice(0, 10);

        return data;
      });

      // 4. 渲染内容
      const { title, imageTitle, htmlContent } = await step.do(
        "generate-content",
        {
          retries: { limit: 2, delay: "5 second", backoff: "exponential" },
          timeout: "5 minutes",
        },
        async () => {
          const title = `${topModelName}领跑！${
            new Date().toLocaleDateString()
          } AI模型性能榜单`;
          const imageTitle = `本周大模型排行 ${topModelOrg}旗下大模型登顶`;
          const html = await this.renderer.render(templateData);

          return { title, imageTitle, htmlContent: html };
        },
      );

      // 5. 生成并上传封面图
      const mediaId = await step.do("generate-cover", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "5 minutes",
      }, async () => {
        // 封面失败不应拖垮整条工作流：降级策略见 COVER_FALLBACK_MODE
        const cover = await resolveCover({
          label: "aibench:generate-cover",
          upload: (source) => this.publisher.uploadThumb(source),
          placeholder: { width: 1200, height: 630 },
          generate: () => this.generateCoverImage(imageTitle),
        });
        return cover.mediaId;
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
        { title, html: htmlContent, workflowType: "weixin-aibench" },
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
            title: `${title}`,
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

      // 7. 完成报告
      logger.info(`[工作流] 工作流执行完成`);
      logger.info(`[发布] 发布结果: ${JSON.stringify(publishResult)}`);
      await this.notify.success(
        "AI Benchmark更新完成",
        `已生成最新的AI模型性能榜单\n发布状态: ${publishResult.status}`,
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
