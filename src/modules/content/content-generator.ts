import { DataSourceFactory } from "../data-sources/data-source.factory.ts";
import { AISummarizer } from "../summarizer/ai.summarizer.ts";
import { PublisherFactory } from "../publishers/publisher.factory.ts";
import { TemplateFactory } from "../templates/template.factory.ts";
import { DataItem } from "../interfaces/data-source.interface.ts";
import { TemplateData } from "../templates/interfaces/template.interface.ts";
import { ConfigManager } from "../../utils/config/config-manager.ts";

export class ContentGenerator {
  private dataSourceFactory: DataSourceFactory;
  private summarizer: AISummarizer;
  private publisherFactory: PublisherFactory;
  private templateFactory: TemplateFactory;
  private configManager: ConfigManager;

  constructor() {
    this.dataSourceFactory = DataSourceFactory.getInstance();
    this.summarizer = new AISummarizer();
    this.publisherFactory = PublisherFactory.getInstance();
    this.templateFactory = TemplateFactory.getInstance();
    this.configManager = ConfigManager.getInstance();
  }

  async generateAndPublish(
    sourceName: string,
    publisherName: string,
    options: Record<string, any> = {},
  ) {
    // 获取数据
    const dataSource = await this.dataSourceFactory.getDataSource(sourceName);
    const items = await dataSource.fetch(options);

    // 过滤和排序数据
    const filteredItems = this.filterItems(items);

    // 生成内容
    const content = await this.generateContent(filteredItems, options);

    // 发布内容
    const publisher = await this.publisherFactory.getPublisher(publisherName);
    return await publisher.publish(content, options);
  }

  private filterItems(items: DataItem[]): DataItem[] {
    return items.sort((a, b) => {
      const dateA = a.publishDate ? new Date(a.publishDate).getTime() : 0;
      const dateB = b.publishDate ? new Date(b.publishDate).getTime() : 0;
      return dateB - dateA;
    });
  }

  private async generateContent(
    items: DataItem[],
    options: Record<string, any>,
  ): Promise<string> {
    const summaries = await Promise.all(
      items.map(item => this.summarizer.summarize(item.content)),
    );

    const templateData: TemplateData = {
      title: options.title || "AI 技术趋势周报",
      items: summaries.map((summary, index) => ({
        title: summary.title,
        content: summary.content,
        url: items[index].url,
        author: items[index].author,
        tags: [...(summary.keywords || []), ...(items[index].tags || [])],
      })),
      metadata: {
        footer: options.footer || "由 AI Trend Publisher 自动生成",
      },
    };

    const template = this.templateFactory.getTemplate("EJS");
    return await template.render(templateData);
  }
}