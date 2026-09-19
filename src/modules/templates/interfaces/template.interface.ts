export interface TemplateData {
  title: string;
  items: Array<{
    title: string;
    content: string;
    url?: string;
    author?: string;
    tags?: string[];
  }>;
  metadata?: Record<string, any>;
}

export interface Template {
  name: string;
  render(data: TemplateData): Promise<string>;
}