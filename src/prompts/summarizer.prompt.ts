interface SummaryPromptOptions {
  content: string;
  language?: string;
  minLength?: number;
  maxLength?: number;
}

export function getSummarizerSystemPrompt(): string {
  return `你是一个专业的内容摘要助手。请根据提供的内容生成简洁、准确的摘要。
输出格式为 JSON，包含以下字段：
{
  "title": "文章标题",
  "content": "文章摘要",
  "keywords": ["关键词1", "关键词2", ...],
  "topics": ["主题1", "主题2", ...]
}`;
}

export function getSummarizerUserPrompt(options: SummaryPromptOptions): string {
  const {
    content,
    language = "zh",
    minLength = 100,
    maxLength = 500,
  } = options;

  return `请生成一个${minLength}-${maxLength}字的${
    language === "zh" ? "中文" : "英文"
  }摘要：\n\n${content}`;
}

export function getTitleSystemPrompt(): string {
  return "你是一个专业的标题生成助手。请为提供的内容生成一个吸引人的标题。";
}

export function getTitleUserPrompt(options: Pick<SummaryPromptOptions, "content" | "language">): string {
  const { content, language = "zh" } = options;
  return `请为以下内容生成一个${
    language === "zh" ? "中文" : "英文"
  }标题：\n\n${content}`;
}
