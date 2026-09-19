import { IContentGenerator, GenerateOptions, GeneratedContent } from "../interfaces/content-generator.interface.ts";
import { DataSourceFactory } from "../../data-sources/data-source.factory.ts";
import { ConfigManager } from "../../../utils/config/config-manager.ts";
import { Logger } from "../../../utils/logger/logger.ts";
import { LLMFactory } from "../../llm/llm.factory.ts";

export class DefaultContentGenerator implements IContentGenerator {
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
      // 1. 收集所有数据源的内容
      const items = await this.collectContent(options);

      // 2. 使用 LLM 对内容进行排序
      const rankedItems = await this.rankContent(items);

      // 3. 生成文章标题和内容
      const article = await this.generateArticle(rankedItems, options?.templateType);

      // 4. 生成摘要
      const summary = await this.generateSummary(article.content);

      return {
        title: article.title,
        content: article.content,
        summary,
        sources: items.map(item => item.url),
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(`内容生成失败: ${error instanceof Error ? error.message : "未知错误"}`);
      throw error;
    }
  }

  private async collectContent(options?: GenerateOptions): Promise<any[]> {
    const sources = ["GITHUB", "HELLOGITHUB", "TWITTER"];
    const items = [];

    for (const sourceName of sources) {
      const source = await this.dataSourceFactory.getDataSource(sourceName);
      const sourceItems = await source.fetchTrends(options);
      items.push(...sourceItems);
    }

    return items;
  }

  private async rankContent(items: any[]): Promise<any[]> {
    const llm = await this.llmFactory.getLLM(
      this.configManager.get<string>("AI_CONTENT_RANKER_LLM_PROVIDER")
    );

    const prompt = `作为AI趋势分析专家，请对以下内容进行分析和排序：
    1. 按照内容的创新性、影响力和实用价值进行评分（1-10分）
    2. 对相似主题的内容进行分组
    3. 返回JSON格式，包含分数、分组和排序后的内容
    
    内容列表：${JSON.stringify(items, null, 2)}`;

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
    throw new Error("内容排序失败");
  }

  private async generateArticle(items: any[], templateType = "default"): Promise<{ title: string; content: string }> {
    const llm = await this.llmFactory.getLLM(
      this.configManager.get<string>("DEFAULT_LLM_PROVIDER")
    );

    const prompt = `作为AI趋势分析师，请根据以下内容生成一篇专业的趋势分析文章：
    1. 文章结构：
       - 引言：概述当前AI发展趋势
       - 主体：按主题分类讨论重要进展
       - 总结：对未来发展的思考
    2. 要求：
       - 标题要吸引人且准确
       - 内容要专业且易懂
       - 适当引用数据和案例
       - 加入个人专业见解
    3. 返回格式：
    {
      "title": "文章标题",
      "content": "文章内容（支持Markdown格式）"
    }

    内容素材：${JSON.stringify(items, null, 2)}`;

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
    throw new Error("文章生成失败");
  }

  private async generateSummary(content: string): Promise<string> {
    const llm = await this.llmFactory.getLLM(
      this.configManager.get<string>("AI_SUMMARIZER_LLM_PROVIDER")
    );

    const prompt = `请对以下文章内容生成一个简短的摘要：\n${content}`;
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