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
    // 网络错误 / 超时 / 读体失败：当作可重试
    const message = error instanceof Error ? error.message : String(error);
    return {
      retryable: true,
      error: new JevHttpError(`请求异常: ${message}`, {
        status: 0,
        retryable: true,
      }),
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
        throw new JevHttpError(`请求超时（${this.timeoutMs}ms）`, {
          status: 0,
          retryable: true,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private describeStatus(status: number): { retryable: boolean; hint: string } {
    switch (status) {
      case 429:
        return { retryable: true, hint: "（限速）" };
      case 400:
        return { retryable: false, hint: "（请求体不合法，重试无用）" };
      case 401:
        return { retryable: false, hint: "（JEV_API_KEY 无效）" };
      case 402:
        return { retryable: false, hint: "（余额不足，重试无用）" };
      case 403:
        return { retryable: false, hint: "（无权限）" };
      case 404:
        return { retryable: false, hint: "（地址或模型名不对）" };
      case 422:
        return { retryable: false, hint: "（字段校验失败）" };
      default:
        return {
          retryable: status >= 500,
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
