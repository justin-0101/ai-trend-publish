import {
  ContentSummarizer,
  Summary,
} from "../interfaces/summarizer.interface.ts";
import {
  getSummarizerSystemPrompt,
  getSummarizerUserPrompt,
  getTitleSystemPrompt,
  getTitleUserPrompt,
} from "../../prompts/summarizer.prompt.ts";
import { LLMFactory } from "../../providers/llm/llm-factory.ts";
import { ConfigManager } from "../../utils/config/config-manager.ts";
import { readOptionalConfig } from "../../utils/config/optional-config.ts";
import { RetryUtil } from "../../utils/retry.util.ts";

enum SummarizerSetting {
  AI_SUMMARIZER_LLM_PROVIDER = "AI_SUMMARIZER_LLM_PROVIDER",
  AI_SUMMARIZER_TITLE_MAX_TOKENS = "AI_SUMMARIZER_TITLE_MAX_TOKENS",
}

// generateTitle 的默认 token 预算。
// 推理模型（如 deepseek-reasoner）会先把预算花在 reasoning token 上，
// 预算太小（例如 100）会得到 finish_reason=length 且 content 为空。
const DEFAULT_TITLE_MAX_TOKENS = 1200;

const resolveTitleMaxTokens = async (): Promise<number> => {
  // 可选键：缺失时不报错也不打 warn（见 readOptionalConfig 注释），非法值回落默认值。
  const raw = await readOptionalConfig(
    SummarizerSetting.AI_SUMMARIZER_TITLE_MAX_TOKENS,
  );
  if (raw === null) {
    return DEFAULT_TITLE_MAX_TOKENS;
  }
  const value = typeof raw === "number"
    ? raw
    : Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TITLE_MAX_TOKENS;
};

// content 为空时把上游返回的关键字段带进错误信息，避免只剩一句无法定位的提示。
// 取不到的字段直接省略，不编造。
const describeEmptyTitle = (response: unknown, maxTokens: number): string => {
  const res = response as {
    choices?: Array<{ finish_reason?: string }>;
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  } | null | undefined;

  const parts: string[] = [];
  const finishReason = res?.choices?.[0]?.finish_reason;
  if (finishReason) {
    parts.push(`finish_reason=${finishReason}`);
  }
  const reasoningTokens = res?.usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoningTokens === "number") {
    parts.push(`reasoning_tokens=${reasoningTokens}`);
  }
  parts.push(`max_tokens=${maxTokens}`);
  return `未获取到有效的标题（${parts.join(", ")}）`;
};

export class AISummarizer implements ContentSummarizer {
  private llmFactory: LLMFactory;
  private configInstance: ConfigManager;

  constructor() {
    this.llmFactory = LLMFactory.getInstance();
    this.configInstance = ConfigManager.getInstance();
  }

  async summarize(
    content: string,
    options?: Record<string, any>,
  ): Promise<Summary> {
    if (!content) {
      throw new Error("Content is required for summarization");
    }

    return RetryUtil.retryOperation(async () => {
      const llm = await this.llmFactory.getLLMProvider(
        await this.configInstance.get(SummarizerSetting.AI_SUMMARIZER_LLM_PROVIDER),
      );
      const response = await llm.createChatCompletion([
        {
          role: "system",
          content: getSummarizerSystemPrompt(),
        },
        {
          role: "user",
          content: getSummarizerUserPrompt({
            content,
            language: options?.language,
            minLength: options?.minLength,
            maxLength: options?.maxLength,
          }),
        },
      ], {
        temperature: 0.7,
        response_format: { type: "json_object" },
      });

      const completion = response.choices[0]?.message?.content;
      if (!completion) {
        throw new Error("未获取到有效的摘要结果");
      }

      try {
        const summary = JSON.parse(completion) as Summary;
        if (!summary.title || !summary.content) {
          throw new Error("摘要结果格式不正确");
        }
        return summary;
      } catch (error) {
        throw new Error(
          `解析摘要结果失败: ${error instanceof Error ? error.message : "未知错误"}`,
        );
      }
    });
  }

  async generateTitle(content: string, options?: Record<string, any>): Promise<string> {
    const maxTokens = await resolveTitleMaxTokens();
    return RetryUtil.retryOperation(async () => {
      const llm = await this.llmFactory.getLLMProvider(
        await this.configInstance.get(SummarizerSetting.AI_SUMMARIZER_LLM_PROVIDER),
      );
      const response = await llm.createChatCompletion([
        {
          role: "system",
          content: getTitleSystemPrompt(),
        },
        {
          role: "user",
          content: getTitleUserPrompt({
            content,
            language: options?.language,
          }),
        },
      ], {
        temperature: 0.7,
        max_tokens: maxTokens,
      });

      const title = response?.choices?.[0]?.message?.content;
      if (!title) {
        throw new Error(describeEmptyTitle(response, maxTokens));
      }
      return title;
    });
  }
}
