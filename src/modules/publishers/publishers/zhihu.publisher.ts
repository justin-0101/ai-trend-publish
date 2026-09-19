import { IPublisher, PublishOptions, PublishResult } from "../interfaces/publisher.interface.ts";
import { ConfigManager } from "../../../utils/config/config-manager.ts";
import { Logger } from "../../../utils/logger/logger.ts";

export class ZhihuPublisher implements IPublisher {
  name = "ZHIHU";
  private cookie: string;
  private logger: Logger;
  private configManager: ConfigManager;

  constructor() {
    this.logger = Logger.getInstance();
    this.configManager = ConfigManager.getInstance();
    this.cookie = this.configManager.get<string>("ZHIHU_COOKIE");
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    try {
      // 1. 创建文章草稿
      const draftResponse = await fetch("https://zhuanlan.zhihu.com/api/articles/drafts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": this.cookie,
          "x-requested-with": "Fetch",
        },
        body: JSON.stringify({
          title: options.title,
          content: options.content,
          titleImage: "",
          column: "",
          topics: ["人工智能", "AI", "技术趋势"],
        }),
      });

      if (!draftResponse.ok) {
        throw new Error(`创建草稿失败: ${draftResponse.statusText}`);
      }

      const draft = await draftResponse.json();

      // 2. 发布文章
      const publishResponse = await fetch(`https://zhuanlan.zhihu.com/api/articles/${draft.id}/publish`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Cookie": this.cookie,
          "x-requested-with": "Fetch",
        },
      });

      if (!publishResponse.ok) {
        throw new Error(`发布失败: ${publishResponse.statusText}`);
      }

      const result = await publishResponse.json();

      return {
        success: true,
        articleId: result.id,
        url: `https://zhuanlan.zhihu.com/p/${result.id}`,
      };
    } catch (error) {
      this.logger.error(`知乎发布失败: ${error instanceof Error ? error.message : "未知错误"}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      };
    }
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch("https://www.zhihu.com/api/v4/me", {
        headers: {
          "Cookie": this.cookie,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}