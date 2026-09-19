import { IDataSource, AITrendItem, DataSourceOptions } from "../interfaces/data-source.interface.ts";
import { ConfigManager } from "../../../utils/config/config-manager.ts";
import { Logger } from "../../../utils/logger/logger.ts";

export class GitHubDataSource implements IDataSource {
  name = "GITHUB";
  private token: string;
  private baseUrl = "https://api.github.com";
  private logger: Logger;
  private configManager: ConfigManager;

  constructor() {
    this.logger = Logger.getInstance();
    this.configManager = ConfigManager.getInstance();
    this.token = this.configManager.get<string>("GITHUB_TOKEN");
  }

  async fetchTrends(options?: DataSourceOptions): Promise<AITrendItem[]> {
    try {
      const query = "topic:ai language:zh stars:>100";
      const maxResults = options?.maxResults || 10;

      const response = await fetch(
        `${this.baseUrl}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${maxResults}`,
        {
          headers: {
            "Authorization": `token ${this.token}`,
            "Accept": "application/vnd.github.v3+json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.statusText}`);
      }

      const data = await response.json();
      return data.items.map((repo: any) => ({
        title: repo.name,
        content: repo.description || "",
        url: repo.html_url,
        timestamp: new Date(repo.updated_at),
        source: "GitHub",
        category: "开源项目",
        tags: [repo.language, ...repo.topics || []],
      }));
    } catch (error) {
      this.logger.error(`GitHub 数据获取失败: ${error instanceof Error ? error.message : "未知错误"}`);
      throw error;
    }
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/rate_limit`, {
        headers: {
          "Authorization": `token ${this.token}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}