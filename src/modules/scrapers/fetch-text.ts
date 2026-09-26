/**
 * 采集器共用的 HTTP 取文本工具。
 *
 * 为什么不复用 `utils/http/http-client.ts`：那个类强制 `Content-Type: application/json`
 * 并在 `request()` 里直接 `.json()`，取不了 feed/网页正文；
 * 且它失败时只抛 "HTTP error! status: xxx"，把「403 反爬」和「404 地址写错」
 * 混成同一句话，界面上没法给出可操作的提示。
 */

import { snippet } from "./text-utils.ts";

/** 常见的浏览器 UA：不少站点对空 UA 直接返回 403 或挑战页。 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class HttpRequestError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message: string) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
    this.url = url;
  }
}

export interface FetchTextOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface FetchTextResult {
  status: number;
  contentType: string;
  text: string;
}

export const fetchText = async (
  url: string,
  options: FetchTextOptions = {},
): Promise<FetchTextResult> => {
  const timeoutMs = options.timeoutMs ?? 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        ...options.headers,
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpRequestError(
        response.status,
        url,
        `HTTP ${response.status}${
          response.statusText ? ` ${response.statusText}` : ""
        }｜${snippet(text, 120)}`,
      );
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
    };
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    const reason = error instanceof Error && error.name === "AbortError"
      ? `请求超时（${timeoutMs}ms）`
      : (error instanceof Error ? error.message : String(error));
    throw new Error(`请求失败 ${url}｜${reason}`);
  } finally {
    clearTimeout(timer);
  }
};

/** 取 JSON 并顺手处理非 JSON 响应，错误里带上响应开头，便于判断是不是被反爬拦了。 */
export const fetchJson = async <T>(
  url: string,
  options: FetchTextOptions = {},
): Promise<T> => {
  const { text } = await fetchText(url, {
    ...options,
    headers: {
      Accept: "application/json, text/plain, */*",
      ...options.headers,
    },
  });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`响应不是 JSON（可能被反爬拦截）｜${snippet(text, 120)}`);
  }
};
