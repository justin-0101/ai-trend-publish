import { ConfigManager } from "../../utils/config/config-manager.ts";
import { HttpClient } from "../../utils/http/http-client.ts";
import {
  ChatCompletionOptions,
  ChatMessage,
  LLMProvider,
} from "../interfaces/llm.interface.ts";

export class OpenAICompatibleLLM implements LLMProvider {
  private baseURL!: string;
  private apiKey!: string;
  private model!: string;
  private httpClient: HttpClient;
  private configManager: ConfigManager;

  constructor(private provider: string) {
    this.httpClient = HttpClient.getInstance();
    this.configManager = ConfigManager.getInstance();
  }

  async initialize(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const [baseURL, apiKey, model] = await Promise.all([
      this.configManager.get<string>(`${this.provider}_BASE_URL`),
      this.configManager.get<string>(`${this.provider}_API_KEY`),
      this.configManager.get<string>(`${this.provider}_MODEL`),
    ]);

    this.baseURL = baseURL;
    this.apiKey = apiKey;
    this.model = model;

    this.httpClient.setDefaultHeader("Authorization", `Bearer ${this.apiKey}`);
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  async createChatCompletion(
    messages: ChatMessage[],
    options?: ChatCompletionOptions
  ): Promise<any> {
    const response = await this.httpClient.post(`${this.baseURL}/chat/completions`, {
      model: this.model,
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      ...options
    });
    return response;
  }
}
