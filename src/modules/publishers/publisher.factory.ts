import { IPublisher } from "./interfaces/publisher.interface.ts";
import { WeChatPublisher } from "./publishers/wechat.publisher.ts";
import { ZhihuPublisher } from "./publishers/zhihu.publisher.ts";
import { XiaohongshuPublisher } from "./publishers/xiaohongshu.publisher.ts";

export class PublisherFactory {
  private static instance: PublisherFactory;
  private publishers: Map<string, IPublisher> = new Map();

  private constructor() {
    this.registerDefaultPublishers();
  }

  public static getInstance(): PublisherFactory {
    if (!PublisherFactory.instance) {
      PublisherFactory.instance = new PublisherFactory();
    }
    return PublisherFactory.instance;
  }

  private registerDefaultPublishers(): void {
    this.publishers.set("WECHAT", new WeChatPublisher());
    this.publishers.set("ZHIHU", new ZhihuPublisher());
    this.publishers.set("XIAOHONGSHU", new XiaohongshuPublisher());
    
  }

  public async getPublisher(name: string): Promise<IPublisher> {
    const publisher = this.publishers.get(name);
    if (!publisher) {
      throw new Error(`发布平台 "${name}" 不存在`);
    }
    return publisher;
  }

  public registerPublisher(name: string, publisher: IPublisher): void {
    this.publishers.set(name, publisher);
  }
}