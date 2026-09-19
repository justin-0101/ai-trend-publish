export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  temperature?: number;
  max_tokens?: number;
  response_format?: {
    type: string;
  };
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LLMProvider {
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  createChatCompletion(
    messages: ChatMessage[],
    options?: ChatCompletionOptions,
  ): Promise<ChatCompletionResponse>;
}

/**
 * LLM提供者类型
 */
export type LLMProviderType =
  | "OPENAI"
  | "DEEPSEEK"
  | "XUNFEI"
  | "CUSTOM"
  | "QWEN";

/**
 * LLM提供者类型映射
 */
export interface LLMProviderTypeMap {
  "OPENAI": import("../llm/openai-compatible-llm.ts").OpenAICompatibleLLM;
  "DEEPSEEK": import("../llm/openai-compatible-llm.ts").OpenAICompatibleLLM;
  "XUNFEI": import("../llm/xunfei-llm.ts").XunfeiLLM;
  "QWEN": import("../llm/openai-compatible-llm.ts").OpenAICompatibleLLM;
  "CUSTOM": import("../llm/openai-compatible-llm.ts").OpenAICompatibleLLM;
}
