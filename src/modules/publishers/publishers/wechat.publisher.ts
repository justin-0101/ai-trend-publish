import { IPublisher, PublishOptions, PublishResult } from "../interfaces/publisher.interface.ts";
import { ConfigManager } from "../../../utils/config/config-manager.ts";
import { Logger } from "../../../utils/logger/logger.ts";

export class WeChatPublisher implements IPublisher {
  name = "WECHAT";
  private accessToken: string | null = null;
  private tokenExpireTime: number = 0;
  private logger: Logger;
  private configManager: ConfigManager;

  constructor() {
    this.logger = Logger.getInstance();
    this.configManager = ConfigManager.getInstance();
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpireTime) {
      return this.accessToken;
    }

    const appId = this.configManager.get<string>("WEIXIN_APP_ID");
    const appSecret = this.configManager.get<string>("WEIXIN_APP_SECRET");
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("获取微信访问令牌失败");
    }

    const data = await response.json();
    if (data.errcode) {
      throw new Error(`微信API错误: ${data.errmsg}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpireTime = Date.now() + (data.expires_in * 1000);
    return this.accessToken;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    try {
      const token = await this.getAccessToken();
      const url = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          articles: [{
            title: options.title,
            author: options.author || this.configManager.get<string>("AUTHOR"),
            content: options.content,
            digest: options.digest || options.content.substring(0, 120),
            thumb_media_id: options.thumbMediaId,
            need_open_comment: options.needOpenComment || this.configManager.get<boolean>("NEED_OPEN_COMMENT"),
            only_fans_can_comment: options.onlyFansCanComment || this.configManager.get<boolean>("ONLY_FANS_CAN_COMMENT"),
          }],
        }),
      });

      if (!response.ok) {
        throw new Error(`发布失败: ${response.statusText}`);
      }

      const result = await response.json();
      if (result.errcode) {
        throw new Error(`微信API错误: ${result.errmsg}`);
      }

      return {
        success: true,
        articleId: result.media_id,
      };
    } catch (error) {
      this.logger.error(`微信发布失败: ${error instanceof Error ? error.message : "未知错误"}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      };
    }
  }

  async validate(): Promise<boolean> {
    try {
      await this.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }
}