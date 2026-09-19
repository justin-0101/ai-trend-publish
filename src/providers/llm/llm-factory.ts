import { ConfigManager } from "../../utils/config/config-manager.ts";
import { LLMProvider } from "../interfaces/llm.interface.ts";
import { OpenAICompatibleLLM } from "./openai-compatible-llm.ts";
import { XunfeiLLM } from "./xunfei-llm.ts";

export class LLMFactory {
  private static instance: LLMFactory;
  private providers: Map<string, LLMProvider> = new Map();
  private configManager: ConfigManager;

  private constructor() {
    this.configManager = ConfigManager.getInstance();
  }

  public static getInstance(): LLMFactory {
    if (!LLMFactory.instance) {
      LLMFactory.instance = new LLMFactory();
    }
    return LLMFactory.instance;
  }

  public async getLLMProvider(providerName: string): Promise<LLMProvider> {
    // 解析 PROVIDER:model 格式
    const { provider, model } = this.parseProviderString(providerName);
    const cacheKey = providerName; // 使用完整的字符串作为缓存键

    if (this.providers.has(cacheKey)) {
      return this.providers.get(cacheKey)!;
    }

    const llmProvider = await this.createProvider(provider, model);
    await llmProvider.initialize();
    this.providers.set(cacheKey, llmProvider);
    return llmProvider;
  }

  private parseProviderString(providerName: string): { provider: string; model?: string } {
    if (providerName.includes(':')) {
      const [provider, model] = providerName.split(':');
      return { provider: provider.trim(), model: model.trim() };
    }
    return { provider: providerName.trim() };
  }

  private async createProvider(providerName: string, specificModel?: string): Promise<LLMProvider> {
    switch (providerName) {
      case "DEEPSEEK":
      case "QWEN":
      case "TOGETHER":
      case "OPENAI":
      case "CUSTOM":
        const provider = new OpenAICompatibleLLM(providerName);
        if (specificModel) {
          // 如果指定了特定模型，设置该模型
          await provider.initialize();
          provider.setModel(specificModel);
        }
        return provider;
      case "XUNFEI":
        return new XunfeiLLM();
      default:
        throw new Error(`不支持的 LLM 提供商: ${providerName}`);
    }
  }
}
