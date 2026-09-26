/**
 * 深度文工作流共用的 LLM JSON 解析与数值兜底。
 *
 * 为什么单独放一个文件：这些步骤全部要求模型输出 JSON，而模型经常
 * 加 markdown 代码围栏、前后带一句说明，或者把分值写成超范围的值。
 * 逐处写一遍 try/catch + clamp 会漏，集中在这里一处收口。
 */

export class LlmJsonError extends Error {}

const FENCE_PATTERN = /^\s*```(?:json|JSON)?\s*\n?|\n?\s*```\s*$/g;

/**
 * 宽松解析：剥掉代码围栏，取第一个 JSON 对象/数组到最后一个闭合符号之间的内容。
 * 失败时抛出的错误里带原文前 300 字，便于定位是模型跑偏还是确实不是 JSON。
 */
export const parseLooseJson = <T>(raw: string, label = "LLM 输出"): T => {
  const text = String(raw ?? "").replace(FENCE_PATTERN, "").trim();
  if (!text) {
    throw new LlmJsonError(`${label}为空`);
  }

  const candidates: string[] = [text];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1));
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw new LlmJsonError(
    `${label}不是合法 JSON（${
      lastError instanceof Error ? lastError.message : String(lastError)
    }）：${text.slice(0, 300)}`,
  );
};

/**
 * 把分值夹到 [0, max] 并对非数字兜底为 0。
 * 模型会把 25 分的维度写成 30、40，或者在总分项上自己加总出错，
 * 所以分值一律由代码夹取、总分一律由代码相加。
 */
export const clampScore = (value: unknown, max: number): number => {
  const num = typeof value === "number"
    ? value
    : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(num)) return 0;
  return Math.min(max, Math.max(0, Math.round(num * 10) / 10));
};

/** 把模型返回的任意值收成去空字符串的字符串数组。 */
export const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
};

/**
 * 去空字符串；缺字段时用兜底值。
 *
 * 只接受 string/number/boolean：模型返回对象或数组时直接走兜底。
 * 不这样做的后果是 `String({}) === "[object Object]"`，非空，于是
 * 「一句 [object Object] 当正文」这种坏稿会活着走到归档与发布。
 */
export const toText = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
};

/**
 * 把模型输出收成普通对象。步骤边界统一用它收口，
 * 避免后面写着 `x.y.z` 时碰上 undefined / 字符串 / 数组而抛 TypeError。
 */
export const asRecord = (value: unknown): Record<string, unknown> => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

/** 安全取数组：不是数组就返回空数组，绝不把非数组当数组用。 */
export const asArray = <T = unknown>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

/** 对象是否至少有一个非空字段（用来拦「模型返回 {}」的空卡）。 */
export const hasContent = (record: Record<string, unknown>): boolean =>
  Object.values(record).some((value) => {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return hasContent(value as Record<string, unknown>);
    return true;
  });
