import { IContentGenerator, GenerateOptions, GeneratedContent } from "../interfaces/content-generator.interface.ts";
import { DataSourceFactory } from "../../data-sources/data-source.factory.ts";
import { ConfigManager } from "../../../utils/config/config-manager.ts";
import { Logger } from "../../../utils/logger/logger.ts";
import { LLMFactory } from "../../llm/llm.factory.ts";

export class HelloGitHubContentGenerator implements IContentGenerator {
  private logger: Logger;
  private configManager: ConfigManager;
  private dataSourceFactory: DataSourceFactory;
  private llmFactory: LLMFactory;

  constructor() {
    this.logger = Logger.getInstance();
    this.configManager = ConfigManager.getInstance();
    this.dataSourceFactory = DataSourceFactory.getInstance();
    this.llmFactory = LLMFactory.getInstance();
  }

  async generate(options?: GenerateOptions): Promise<GeneratedContent> {
    try {
      const source = await this.dataSourceFactory.getDataSource("HELLOGITHUB");
      const items = await source.fetchTrends(options);

      const rankedItems = await this.rankProjects(items);
      const article = await this.generateProjectReview(rankedItems, options?.templateType);
      const summary = await this.generateSummary(article.content);

      return {
        title: article.title,
        content: article.content,
        summary,
        sources: items.map(item => item.url),
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(`HelloGitHub 内容生成失败: ${error instanceof Error ? error.message : "未知错误"}`);
      throw error;
    }
  }

  private async rankProjects(items: any[]): Promise<any[]> {
    const llm = await this.llmFactory.getLLM(
      this.configManager.get<string>("AI_CONTENT_RANKER_LLM_PROVIDER")
    );

    const prompt = `作为开源项目评估专家，请对以下AI相关开源项目进行分析和排序：
    1. 评估维度：
       - 项目创新性（1-10分）
       - 实用价值（1-10分）
       - 代码质量（1-10分）
       - 社区活跃度（1-10分）
    2. 分类维度：
       - 基础框架类
       - 应用工具类
       - 模型开发类
       - 数据处理类
    3. 返回JSON格式：
    {
      "categories": [
        {
          "name": "分类名称",
          "projects": [
            {
              "title": "项目名称",
              "scores": {
                "innovation": 分数,
                "practical": 分数,
                "codeQuality": 分数,
                "community": 分数
              },
              "highlight": "项目亮点",
              "content": "原始内容"
            }
          ]
        }
      ]
    }

    项目列表：${JSON.stringify(items, null, 2)}`;

    let retries = 3;
    while (retries > 0) {
      try {
        const result = await llm.chat(prompt);
        return JSON.parse(result);
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error("项目排序失败");
  }

  private async generateProjectReview(items: any[], templateType = "weixin"): Promise<{ title: string; content: string }> {
    const llm = await this.llmFactory.getLLM(
      this.configManager.get<string>("DEFAULT_LLM_PROVIDER")
    );

    const prompt = `作为开源项目推荐专家，请根据以下项目生成一篇精彩的推荐文章：
    1. 文章结构：
       - 开篇：介绍本期精选主题和亮点
       - 项目推荐：按分类详细介绍每个项目
         * 项目简介
         * 技术特点
         * 应用场景
         * 上手难度
         * 项目亮点
       - 总结：技术趋势洞察
    2. 写作要求：
       - 标题要突出精选和价值
       - 介绍要生动有趣
       - 突出实用价值
       - 适合微信公众号阅读
    3. 返回格式：
    {
      "title": "文章标题",
      "content": "文章内容（Markdown格式）"
    }

    项目数据：${JSON.stringify(items, null, 2)}`;

    let retries = 3;
    while (retries > 0) {
      try {
        const result = await llm.chat(prompt);
        return JSON.parse(result);
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error("项目推荐文章生成失败");
  }

  private async generateSummary(content: string): Promise<string> {
    const llm = await this.llmFactory.getLLM(
      this.configManager.get<string>("AI_SUMMARIZER_LLM_PROVIDER")
    );

    const prompt = `请为以下开源项目推荐文章生成一个吸引人的导读：
    1. 突出本期精选的价值
    2. 概括主要项目类型
    3. 适合分享和引流
    4. 限制在100字以内

    文章内容：${content}`;

    return await llm.chat(prompt);
  }

  async validate(): Promise<boolean> {
    try {
      const llm = await this.llmFactory.getLLM(
        this.configManager.get<string>("DEFAULT_LLM_PROVIDER")
      );
      return await llm.validate();
    } catch {
      return false;
    }
  }
}