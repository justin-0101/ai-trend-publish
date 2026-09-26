export interface ContentScraper {
  // 抓取指定数据源的内容
  scrape(sourceId: string, options?: ScraperOptions): Promise<ScrapedContent[]>;
  /**
   * 可选：直接读取一个具体页面的正文。
   * 列表/时间线采集器通常只实现 scrape；支持定向补料的采集器实现此方法。
   */
  scrapePage?(url: string): Promise<ScrapedContent | null>;
}

export interface ScraperOptions {
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  filters?: Record<string, any>;
}

export interface ScrapedContent {
  id: string;
  title: string;
  content: string;
  url: string;
  publishDate: string;
  media?: Media[];
  metadata: Record<string, any>;
}

export interface Media {
  url: string;
  type: string;
  size: Size;
}

export interface Size {
  width: number;
  height: number;
}
