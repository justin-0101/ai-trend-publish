export interface GenerateOptions {
  maxItems?: number;
  categories?: string[];
  tags?: string[];
  templateType?: string;
}

export interface GeneratedContent {
  title: string;
  content: string;
  summary?: string;
  sources: string[];
  timestamp: Date;
}

export interface IContentGenerator {
  generate(options?: GenerateOptions): Promise<GeneratedContent>;
  validate(): Promise<boolean>;
}