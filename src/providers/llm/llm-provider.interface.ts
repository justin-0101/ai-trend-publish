export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

export interface ChatCompletionResponse {
  choices: {
    message?: ChatMessage;
    content?: string;
  }[];
}

export interface LLMProvider {
  createChatCompletion(
    messages: ChatMessage[],
    options?: ChatCompletionOptions
  ): Promise<ChatCompletionResponse>;
}