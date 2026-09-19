import { IDataSource, AITrendItem, DataSourceOptions } from "../interfaces/data-source.interface.ts";
import { Logger } from "../../../utils/logger/logger.ts";

export class HelloGitHubDataSource implements IDataSource {
  name = "HELLOGITHUB";
  private baseUrl = "https://hellogithub.com";
  private logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
  }

  async fetchTrends(options?: DataSourceOptions): Promise<AITrendItem[]> {
    try {
      const response = await fetch(`${this.baseUrl}/periodical/category/AI`);
      if (!response.ok) {
        throw new Error(`获取 HelloGitHub 页面失败: ${response.statusText}`);
      }

      const html = await response.text();
      const items: AITrendItem[] = [];
      
      const projectPattern = /<article[^>]*>([\s\S]*?)<\/article>/g;
      const titlePattern = /<h2[^>]*>([\s\S]*?)<\/h2>/;
      const descPattern = /<div class="summary"[^>]*>([\s\S]*?)<\/div>/;
      const urlPattern = /href="([^"]*?)"/;

      let match;
      while ((match = projectPattern.exec(html)) !== null && items.length < (options?.maxResults || 10)) {
        const articleContent = match[1];
        const titleMatch = titlePattern.exec(articleContent);
        const descMatch = descPattern.exec(articleContent);
        const urlMatch = urlPattern.exec(articleContent); // 修复变量名错误

        if (titleMatch && descMatch) {
          items.push({
            title: this.cleanText(titleMatch[1]),
            content: this.cleanText(descMatch[1]),
            url: urlMatch ? `${this.baseUrl}${urlMatch[1]}` : this.baseUrl,
            timestamp: new Date(),
            source: "HelloGitHub",
            category: "开源精选",
            tags: ["AI", "开源"]
          });
        }
      }

      return items;
    } catch (error) {
      this.logger.error(`HelloGitHub 数据获取失败: ${error instanceof Error ? error.message : "未知错误"}`);
      throw error;
    }
  }

  private cleanText(text: string): string {
    return text
      .replace(/<[^>]+>/g, '') // 移除HTML标签
      .replace(/&[^;]+;/g, '') // 移除HTML实体
      .trim();
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl);
      return response.ok;
    } catch {
      return false;
    }
  }
}