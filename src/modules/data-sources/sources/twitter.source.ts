import { IDataSource, AITrendItem, DataSourceOptions } from "../interfaces/data-source.interface.ts";
import { ConfigManager } from "../../../utils/config/config-manager.ts";
import { Logger } from "../../../utils/logger/logger.ts";

export class TwitterDataSource implements IDataSource {
  name = "TWITTER";
  private bearerToken: string;
  private baseUrl = "https://api.twitter.com/2";
  private logger: Logger;
  private configManager: ConfigManager;

  constructor() {
    this.logger = Logger.getInstance();
    this.configManager = ConfigManager.getInstance();
    this.bearerToken = this.configManager.get<string>("TWITTER_BEARER_TOKEN");
  }

  async fetchTrends(options?: DataSourceOptions): Promise<AITrendItem[]> {
    try {
      const query = "AI OR 人工智能 OR ChatGPT OR LLM lang:zh-cn";
      const maxResults = options?.maxResults || 10;

      const response = await fetch(
        `${this.baseUrl}/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${maxResults}&tweet.fields=created_at,public_metrics,entities`,
        {
          headers: {
            "Authorization": `Bearer ${this.bearerToken}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Twitter API error: ${response.statusText}`);
      }

      const data = await response.json();
      return data.data.map((tweet: any) => ({
        title: tweet.text.split('\n')[0] || tweet.text.substring(0, 50),
        content: tweet.text,
        url: `https://twitter.com/i/web/status/${tweet.id}`,
        timestamp: new Date(tweet.created_at),
        source: "Twitter",
        tags: tweet.entities?.hashtags?.map((tag: any) => tag.tag) || [],
        category: "社交媒体",
      }));
    } catch (error) {
      this.logger.error(`Twitter 数据获取失败: ${error instanceof Error ? error.message : "未知错误"}`);
      throw error;
    }
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/tweets/search/recent?query=test`, {
        headers: {
          "Authorization": `Bearer ${this.bearerToken}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}