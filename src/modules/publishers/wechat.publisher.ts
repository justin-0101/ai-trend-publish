import { ConfigManager } from "../../utils/config/config-manager.ts";
import { HttpClient } from "../../utils/http/http-client.ts";
import { Publisher, PublishResult } from "../interfaces/publisher.interface.ts";

export class WechatPublisher implements Publisher {
  name = "WeChat";
  private accessToken!: string;
  private appId!: string;
  private appSecret!: string;
  private baseUrl = "https://api.weixin.qq.com/cgi-bin";
  private httpClient: HttpClient;
  private configManager: ConfigManager;

  constructor() {
    this.httpClient = HttpClient.getInstance();
    this.configManager = ConfigManager.getInstance();
  }

  async initialize(): Promise<void> {
    this.appId = await this.configManager.get<string>("WEIXIN_APP_ID");
    this.appSecret = await this.configManager.get<string>("WEIXIN_APP_SECRET");
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    const response = await this.httpClient.get<{
      access_token: string;
      expires_in: number;
    }>(`${this.baseUrl}/token`, {
      params: {
        grant_type: "client_credential",
        appid: this.appId,
        secret: this.appSecret,
      },
    });

    this.accessToken = response.access_token;
  }

  async publish(content: string, options: Record<string, any> = {}): Promise<PublishResult> {
    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/draft/add?access_token=${this.accessToken}`,
        {
          articles: [{
            title: options.title || "未命名文章",
            author: options.author || "AI Trend Publisher",
            content: content,
            digest: options.summary || "",
            thumb_media_id: options.thumbMediaId,
            content_source_url: options.sourceUrl || "",
          }],
        },
      );

      if (response.errcode !== 0) {
        throw new Error(`发布失败: ${response.errmsg}`);
      }

      return {
        success: true,
        articleId: response.media_id,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      };
    }
  }

  async validate(): Promise<boolean> {
    try {
      await this.refreshAccessToken();
      return true;
    } catch {
      return false;
    }
  }
}