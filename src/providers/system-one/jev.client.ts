/**
 * Jev（TypeSafe System One）HTTP 客户端。
 *
 * **刻意不复用 `src/utils/http/http-client.ts`**，两个已核对过的原因：
 *   1. HttpClient 是单例，`setDefaultHeader` 改的是实例级 defaultHeaders，
 *      而 `OpenAICompatibleLLM.refresh()` 会用它设 `Bearer ${apiKey}` ——
 *      Jev 要是也调它，会把大模型的 key 覆盖掉。这里按请求传 header。
 *   2. HttpClient.retryFetch 对**任何**非 2xx 都重试 3 次且忽略 `retry-after`：
 *      401/402（余额不足）会被白重试，429 不会按服务端要求等待；而且它把错误
 *      包成不含 status 的 Error，调用方没法分流。这里自带状态码分流。
 *
 * 因此 `RetryUtil` 也不适用（它对 4xx 一样会重试）—— 除了
 * `WorkflowTerminateError` 那条早退分支，而把 Jev 的 401 抛成
 * WorkflowTerminateError 会连带终止整条出稿流程，正是要避免的事。
 *
 * **重试白名单**：只重试 408 / 409 / 429 / 5xx。Jev 按输入 token 计费，
 * 请求体里带的是正文，且没有幂等键；对「可能已被处理」的失败重发就是重复计费。
 * 所以超时、连接重置等网络层歧义失败一律不重试，直接失败交给排序器的回落。
 */
import {
  SystemOneModelMetadata,
  SystemOneRequest,
  SystemOneResponse,
} from "../interfaces/system-one.interface.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

/** Jev 请求失败。`retryable` 由状态码决定，调用方不必再看 status。 */
export class JevHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { status: number; retryable: boolean; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "JevHttpError";
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface JevClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时，默认 15000ms */
  timeoutMs?: number;
  /** 额外重试次数上限，默认 3 */
  maxRetries?: number;
  /** 退避基数，默认 1000ms（指数退避：1s / 2s / 4s） */
  baseDelayMs?: number;
  /**
   * `retry-after` 超过该值就直接失败，不再等待。
   * 排序这一步的 step 超时是 5 分钟，等一个巨大的 retry-after 只会把整条流程拖死。
   */
  maxRetryAfterMs?: number;
  /** 测试接缝：注入 fetch */
  fetchImpl?: typeof fetch;
  /** 测试接缝：注入 sleep */
  sleep?: (ms: number) => Promise<void>;
}

export interface JevRequestResult {
  response: SystemOneResponse;
  /** 实际发生的重试次数（0 = 一次成功） */
  attempts: number;
  durationMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 官方文档：Score 档位 2–10；OpenAPI 只写了 minItems 1，按文档取严的。 */
export const SCORE_LEVEL_MIN = 2;
export const SCORE_LEVEL_MAX = 10;

/**
 * 唯一允许重试的响应状态码。
 *
 * 依据（`jkudish/jev-mcp` 的 `src/provider.ts` 把同一套白名单写成显式契约）：
 *   408 = 服务端声明未处理；409 = 冲突；429 = 限速；5xx = 服务端错误。
 * 这几种能确认「没被处理」，重发安全；其余 4xx 重发无用，网络层歧义失败
 * 重发可能把一个付费调用算两次。
 */
export const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500;

export class JevClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: JevClientOptions) {
    if (!options.apiKey) {
      throw new Error("JevClient 需要 apiKey");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 30000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** `GET /v1/models`：连通性与鉴权自检，不发送任何素材内容。 */
  public async listModels(): Promise<SystemOneModelMetadata[]> {
    const res = await this.send("GET", "/v1/models");
    const body = await res.json() as { models?: SystemOneModelMetadata[] } | SystemOneModelMetadata[];
    return Array.isArray(body) ? body : (body.models ?? []);
  }

  /**
   * `POST /v1/systemone`。
   * 一次请求带多个问题（同一 state 并行判定），model 由实例配置，不给调用方改的机会。
   */
  public async evaluate(
    request: Omit<SystemOneRequest, "model">,
  ): Promise<JevRequestResult> {
    const startedAt = Date.now();
    const body = JSON.stringify({ ...request, model: this.model });

    let attempts = 0;
    for (;;) {
      try {
        const res = await this.send("POST", "/v1/systemone", body);
        const parsed = await this.parse(res);
        return { response: parsed, attempts, durationMs: Date.now() - startedAt };
      } catch (error) {
        const failure = this.classify(error);
        if (!failure.retryable || attempts >= this.maxRetries) {
          throw failure.error;
        }
        const delay = failure.retryAfterMs ??
          this.baseDelayMs * Math.pow(2, attempts);
        attempts++;
        logger.warn(
          `[Jev] ${failure.error.message}｜第 ${attempts}/${this.maxRetries} 次重试，等待 ${delay}ms`,
        );
        await this.sleep(delay);
      }
    }
  }

  // ------------------------------------------------------------------ 内部

  private classify(
    error: unknown,
  ): { retryable: boolean; error: JevHttpError; retryAfterMs?: number } {
    if (error instanceof JevHttpError) {
      return {
        retryable: error.retryable,
        error,
        retryAfterMs: error.retryAfterMs,
      };
    }
    // 网络层歧义失败（连接重置、TLS、DNS…）：**不重试**。
    // 没有幂等键时无法证明服务端没处理过这个请求，而 Jev 按输入 token 计费，
    // 重发就是为同一篇素材付两次钱。宁可让这一篇失败、走回落。
    const message = error instanceof Error ? error.message : String(error);
    return {
      retryable: false,
      error: new JevHttpError(
        `网络层请求失败（不重试，避免付费调用重复处理）: ${message}`,
        { status: 0, retryable: false },
      ),
    };
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        // 关键：Authorization 按请求传，绝不写进任何全局/单例对象
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      if (res.ok) return res;

      const status = res.status;
      const snippet = await this.readSnippet(res);
      const retryAfterMs = this.parseRetryAfter(res.headers.get("retry-after"));
      const { retryable, hint } = this.describeStatus(status);
      throw new JevHttpError(
        `Jev 返回 ${status}${hint}: ${snippet}`,
        { status, retryable, retryAfterMs },
      );
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        throw new JevHttpError(
          `请求超时（${this.timeoutMs}ms），不重试：超时属歧义失败，重发可能重复计费`,
          { status: 0, retryable: false },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private describeStatus(status: number): { retryable: boolean; hint: string } {
    switch (status) {
      case 408:
        return { retryable: true, hint: "（服务端声明未处理）" };
      case 409:
        return { retryable: true, hint: "（冲突）" };
      case 429:
        return { retryable: true, hint: "（限速）" };
      case 400:
        return { retryable: false, hint: "（请求体不合法，重试无用）" };
      case 401:
        return { retryable: false, hint: "（JEV_API_KEY 无效）" };
      case 402:
        return { retryable: false, hint: "（余额不足，重试无用）" };
      case 403:
        // 实测（2026-09-27 无 key 直连）：缺 key 时返回的是 403 而不是 401，
        // 响应体为 {"detail":{"error_type":"authentication_error",...}}。
        return {
          retryable: false,
          hint: "（鉴权失败：缺 JEV_API_KEY / key 无效 / 额度未开通）",
        };
      case 404:
        return { retryable: false, hint: "（地址或模型名不对）" };
      case 422:
        return { retryable: false, hint: "（字段校验失败）" };
      default:
        return {
          retryable: isRetryableStatus(status),
          hint: status >= 500 ? "（服务端错误）" : "",
        };
    }
  }

  private parseRetryAfter(header: string | null): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    if (!Number.isNaN(seconds)) {
      const ms = seconds * 1000;
      if (ms > this.maxRetryAfterMs) {
        throw new JevHttpError(
          `服务端要求等待 ${Math.round(ms / 1000)}s，超过上限 ${
            Math.round(this.maxRetryAfterMs / 1000)
          }s`,
          { status: 429, retryable: false },
        );
      }
      return ms;
    }
    const at = Date.parse(header);
    if (Number.isNaN(at)) return undefined;
    const ms = at - Date.now();
    return ms > 0 ? Math.min(ms, this.maxRetryAfterMs) : 0;
  }

  private async readSnippet(res: Response): Promise<string> {
    try {
      const text = await res.text();
      return text.replace(/\s+/g, " ").slice(0, 300);
    } catch {
      return "<无法读取响应体>";
    }
  }

  private async parse(res: Response): Promise<SystemOneResponse> {
    const text = await res.text();
    let parsed: SystemOneResponse;
    try {
      parsed = JSON.parse(text) as SystemOneResponse;
    } catch {
      throw new JevHttpError(
        `响应不是 JSON: ${text.slice(0, 200)}`,
        { status: 200, retryable: false },
      );
    }
    if (!parsed || typeof parsed !== "object" || !parsed.answers) {
      throw new JevHttpError(
        `响应缺少 answers 字段: ${text.slice(0, 200)}`,
        { status: 200, retryable: false },
      );
    }
    return parsed;
  }
}
