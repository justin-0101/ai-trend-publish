export interface DataSourceOptions {
  limit?: number;
  startDate?: string;
  endDate?: string;
  keywords?: string[];
  categories?: string[];
}

export interface DataItem {
  id: string;
  title: string;
  content: string;
  url?: string;
  author?: string;
  publishDate?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface DataSource {
  name: string;
  initialize(): Promise<void>;
  fetch(options?: DataSourceOptions): Promise<DataItem[]>;
  validate?(): Promise<boolean>;
}