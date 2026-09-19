import { IConfigSource } from "./interfaces/config-source.interface.ts";
import { DbConfigSource } from "./sources/db-config.source.ts";
import { EnvConfigSource } from "./sources/env-config.source.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg),
  warn: (msg: string) => console.warn(msg),
  debug: (msg: string) => console.debug(msg)
};

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
}

export class ConfigManager {
  private static instance: ConfigManager;
  private config: Record<string, any> = {};
  private configSources: IConfigSource[] = [];
  private defaultRetryOptions: RetryOptions = {
    maxAttempts: 3,
    delayMs: 1000,
  };

  private constructor() {}

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  public async initialize(): Promise<void> {
    await this.initDefaultConfigSources();
  }

  public addSource(source: IConfigSource): void {
    this.configSources.push(source);
    this.configSources.sort((a, b) => a.priority - b.priority);
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async getWithRetry<T>(
    source: IConfigSource,
    key: string,
    options: RetryOptions,
  ): Promise<T | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      try {
        const value = await source.get<T>(key);
        return value;
      } catch (error) {
        lastError = error as Error;
        if (attempt < options.maxAttempts) {
          await this.delay(options.delayMs);
        }
      }
    }

    // 在测试环境中不输出警告
    if (Deno.env.get("DENO_ENV") !== "test") {
      logger.warn(
        `Failed to get config "${key}" after ${options.maxAttempts} attempts. Last error: ${lastError?.message}`,
      );
    }
    return null;
  }

  public async initDefaultConfigSources(): Promise<void> {
    this.addSource(new EnvConfigSource());
    const enableDb = await this.get<string>("ENABLE_DB");
    if (enableDb === "true") {
      logger.info("DB enabled");
      this.addSource(new DbConfigSource());
    }
  }

  public async get<T>(
    key: string,
    retryOptions?: Partial<RetryOptions>,
  ): Promise<T> {
    const options = { ...this.defaultRetryOptions, ...retryOptions };

    for (const source of this.configSources) {
      const value = await this.getWithRetry<T>(source, key, options);
      if (value !== null) {
        return value;
      }
    }

    throw new ConfigurationError(
      `Configuration key "${key}" not found in any source after ${options.maxAttempts} attempts`,
    );
  }

  public getSources(): IConfigSource[] {
    return [...this.configSources];
  }

  public clearSources(): void {
    this.configSources = [];
  }


}
