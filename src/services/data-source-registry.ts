import { dirname, join } from "https://deno.land/std/path/mod.ts";

export const DATA_SOURCE_PLATFORMS = [
  "firecrawl",
  "twitter",
  "twitter-cookie",
  "github",
  "hellogithub",
  "weixin",
  "rss",
  "reddit",
  "bilibili",
  "zhihu",
] as const;

export type DataSourcePlatform = typeof DATA_SOURCE_PLATFORMS[number];

export type DataSourceEntry = {
  platform: string;
  identifier: string;
};

export type DataSourcePreferences = {
  /**
   * 自定义源。**界面已不再写入**（采集源改为固定预置，不做手动添加），
   * 但读入路径保留：早期版本可能在 ui-config.json 里留下过条目，
   * 直接忽略会让那些源凭空消失。
   */
  customDataSources?: DataSourceEntry[];
  /** 被删除（隐藏）的源；用户自己删一下对应项即可恢复 */
  deletedDataSources?: string[];
};

type UiConfigRecord = DataSourcePreferences & {
  sourceRules?: Record<string, unknown>;
  [key: string]: unknown;
};

const defaultConfigPath = () => join(Deno.cwd(), "logs", "ui-config.json");

export const makeDataSourceKey = (
  platform: string,
  identifier: string,
): string => `${platform.trim().toLowerCase()}::${identifier.trim()}`;

/**
 * identifier 必须是可直接抓取的 http(s) 地址的类型。
 */
const URL_ONLY_PLATFORMS = new Set<string>([
  "firecrawl",
  "twitter",
  "twitter-cookie",
  "github",
  "hellogithub",
  "weixin",
  "rss",
]);

/**
 * 允许「关键字式」标识的类型：
 *   reddit   → r/OpenAI、r/OpenAI/new、https://www.reddit.com/r/OpenAI
 *   bilibili → popular、newlist:188
 *   zhihu    → hot、daily
 * 这几类的采集器自己会把关键字拼成接口地址，强迫用户填 URL 反而写不出这些源。
 */
const KEYWORD_PLATFORMS = new Set<string>(["reddit", "bilibili", "zhihu"]);

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/** 关键字标识只做字符集与长度约束（不能有空格、控制字符），不做语义校验。 */
const isKeywordIdentifier = (value: string): boolean =>
  /^[A-Za-z0-9_:/.-]{1,200}$/.test(value);

export interface DataSourceValidation {
  source: DataSourceEntry | null;
  /** 校验失败的可读原因；成功时为空串 */
  reason: string;
}

/**
 * 带原因的校验。API 层用它把「平台名错」和「地址格式错」分开提示，
 * 否则用户只能得到一句 “Invalid platform or source URL”，不知道该改哪个字段。
 */
export const validateDataSource = (
  platform: unknown,
  identifier: unknown,
): DataSourceValidation => {
  if (typeof platform !== "string" || !platform.trim()) {
    return { source: null, reason: "未选择采集类型" };
  }
  if (typeof identifier !== "string" || !identifier.trim()) {
    return { source: null, reason: "采集源地址为空" };
  }
  const normalizedPlatform = platform.trim().toLowerCase();
  const normalizedIdentifier = identifier.trim();
  if (
    !DATA_SOURCE_PLATFORMS.includes(normalizedPlatform as DataSourcePlatform)
  ) {
    return { source: null, reason: `不支持的采集类型：${platform}` };
  }
  if (normalizedIdentifier.length > 2048) {
    return { source: null, reason: "采集源地址过长" };
  }
  if (URL_ONLY_PLATFORMS.has(normalizedPlatform)) {
    if (!isHttpUrl(normalizedIdentifier)) {
      return {
        source: null,
        reason:
          `${normalizedPlatform} 需要 http/https 地址（当前填的是：${normalizedIdentifier}）`,
      };
    }
  } else if (KEYWORD_PLATFORMS.has(normalizedPlatform)) {
    if (
      !isHttpUrl(normalizedIdentifier) &&
      !isKeywordIdentifier(normalizedIdentifier)
    ) {
      return {
        source: null,
        reason:
          `${normalizedPlatform} 需要 http/https 地址或关键字标识（不能带空格）：${normalizedIdentifier}`,
      };
    }
  } else if (!isHttpUrl(normalizedIdentifier)) {
    // 未来新增的平台默认按地址处理：宁可要求过严，也不让不明格式渗进下游采集器
    return { source: null, reason: "采集源地址必须是 http/https 地址" };
  }
  return {
    source: { platform: normalizedPlatform, identifier: normalizedIdentifier },
    reason: "",
  };
};

export const normalizeDataSource = (
  platform: unknown,
  identifier: unknown,
): DataSourceEntry | null => validateDataSource(platform, identifier).source;

const readUiConfig = async (path: string): Promise<UiConfigRecord> => {
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as UiConfigRecord : {};
  } catch {
    return {};
  }
};

const writeUiConfig = async (
  path: string,
  config: UiConfigRecord,
): Promise<void> => {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(config));
};

export const readDataSourcePreferences = async (
  path = defaultConfigPath(),
): Promise<DataSourcePreferences> => {
  const config = await readUiConfig(path);
  return {
    customDataSources: Array.isArray(config.customDataSources)
      ? config.customDataSources
      : [],
    deletedDataSources: Array.isArray(config.deletedDataSources)
      ? config.deletedDataSources.filter((key) => typeof key === "string")
      : [],
  };
};

export const applyDataSourcePreferences = (
  config: Record<string, Array<{ identifier: string }>>,
  preferences: DataSourcePreferences,
): Record<string, Array<{ identifier: string }>> => {
  const deleted = new Set(preferences.deletedDataSources ?? []);
  const result: Record<string, Array<{ identifier: string }>> = {};

  for (const [platform, items] of Object.entries(config)) {
    result[platform] = items.filter((item) =>
      !deleted.has(makeDataSourceKey(platform, item.identifier))
    );
  }

  for (const item of preferences.customDataSources ?? []) {
    const normalized = normalizeDataSource(item.platform, item.identifier);
    if (!normalized) continue;
    const key = makeDataSourceKey(normalized.platform, normalized.identifier);
    if (deleted.has(key)) continue;
    const items = result[normalized.platform] ??
      (result[normalized.platform] = []);
    if (!items.some((entry) => entry.identifier === normalized.identifier)) {
      items.push({ identifier: normalized.identifier });
    }
  }

  return result;
};

export const deleteDataSourcePreference = async (
  source: DataSourceEntry,
  path = defaultConfigPath(),
): Promise<void> => {
  const normalized = normalizeDataSource(source.platform, source.identifier);
  if (!normalized) throw new Error("Invalid data source");

  const config = await readUiConfig(path);
  const key = makeDataSourceKey(normalized.platform, normalized.identifier);
  config.customDataSources = Array.isArray(config.customDataSources)
    ? config.customDataSources.filter((item) => {
      if (
        !item || typeof item.platform !== "string" ||
        typeof item.identifier !== "string"
      ) {
        return false;
      }
      return makeDataSourceKey(item.platform, item.identifier) !== key;
    })
    : [];
  const deleted = new Set(
    Array.isArray(config.deletedDataSources) ? config.deletedDataSources : [],
  );
  deleted.add(key);
  config.deletedDataSources = [...deleted];
  if (config.sourceRules && typeof config.sourceRules === "object") {
    delete config.sourceRules[key];
  }
  await writeUiConfig(path, config);
};
