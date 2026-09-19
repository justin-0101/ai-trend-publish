import { ConfigManager } from "../config/config-manager.ts";

interface RequestOptions extends RequestInit {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export class HttpClient {
  private static instance: HttpClient;
  private defaultHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  private configManager: ConfigManager;

  private constructor() {
    this.configManager = ConfigManager.getInstance();
  }

  public static getInstance(): HttpClient {
    if (!HttpClient.instance) {
      HttpClient.instance = new HttpClient();
    }
    return HttpClient.instance;
  }

  public setDefaultHeader(key: string, value: string): void {
    this.defaultHeaders[key] = value;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const { timeout = 30000, ...fetchOptions } = options;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      throw error;
    }
  }

  private async retryFetch(
    url: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const { retries = 3, retryDelay = 1000, ...fetchOptions } = options;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, fetchOptions);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        return response;
      } catch (error) {
        lastError = error as Error;
        console.warn(`请求失败，尝试重试 ${attempt + 1}/${retries}:`, error);

        if (attempt < retries - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }

    throw new Error(`请求失败，已重试 ${retries} 次: ${lastError?.message}`);
  }

  public async request<T>(
    url: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const finalOptions = {
      ...options,
      headers: { ...this.defaultHeaders, ...options.headers },
    };

    try {
      const response = await this.retryFetch(url, finalOptions);
      const data = await response.json();
      return data as T;
    } catch (error) {
      throw new Error(`请求失败: ${(error as Error).message}`);
    }
  }

  public async get<T>(url: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(url, { ...options, method: "GET" });
  }

  public async post<T>(
    url: string,
    data: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    return this.request<T>(url, {
      ...options,
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  public async healthCheck(url: string): Promise<boolean> {
    try {
      await this.fetchWithTimeout(url, {
        method: "HEAD",
        timeout: 5000,
      });
      return true;
    } catch (error) {
      console.error(`健康检查失败: ${url}`, error);
      return false;
    }
  }
}
