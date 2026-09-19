import { IDataSource, AITrendItem, DataSourceOptions } from '../interfaces/data-source.interface.ts';
import { ConfigManager } from '../../../utils/config/config-manager.ts';
import { Logger } from '../../../utils/logger/logger.ts';

export class WeixinDataSource implements IDataSource {
  name = 'WEIXIN';
  private configManager: ConfigManager;
  private appId: string;
  private appSecret: string;
  private logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
    this.configManager = ConfigManager.getInstance();
    this.appId = this.configManager.get<string>('WEIXIN_APP_ID');
    this.appSecret = this.configManager.get<string>('WEIXIN_APP_SECRET');
  }

  async fetchTrends(options?: DataSourceOptions): Promise<AITrendItem[]> {
    try {
      const accessToken = await this.getAccessToken();
      const maxResults = options?.maxResults || 10;

      const response = await fetch(
        `https://api.weixin.qq.com/cgi-bin/material/batchget_material?access_token=${accessToken}`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'news',
            offset: 0,
            count: maxResults
          })
        }
      );

      if (!response.ok) {
        throw new Error(`微信API请求失败: ${response.statusText}`);
      }

      const data = await response.json();
      return data.item.map((item: any) => ({
        title: item.content.news_item[0]?.title || '未命名文章',
        content: item.content.news_item[0]?.digest || '',
        url: item.content.news_item[0]?.url || '',
        timestamp: new Date(item.update_time * 1000),
        source: '微信公众号',
        tags: [],
        category: '社交媒体'
      }));
    } catch (error) {
      this.logger.error(`微信数据获取失败: ${error instanceof Error ? error.message : '未知错误'}`);
      throw error;
    }
  }

  private async getAccessToken(): Promise<string> {
    const response = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`
    );
    const data = await response.json();
    return data.access_token;
  }

  async validate(): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      return !!token;
    } catch {
      return false;
    }
  }
}