export interface AITrendItem {
  title: string;
  content: string;
  url: string;
  timestamp: Date;
  source: string;
  category?: string;
  tags?: string[];
}

export interface DataSourceOptions {
  maxResults?: number;
  startDate?: Date;
  endDate?: Date;
  categories?: string[];
  tags?: string[];
}

export interface IDataSource {
  name: string;
  fetchTrends(options?: DataSourceOptions): Promise<AITrendItem[]>;
  validate(): Promise<boolean>;
}