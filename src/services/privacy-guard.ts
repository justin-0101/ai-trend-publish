import { readOptionalConfig } from "@src/utils/config/optional-config.ts";
import {
  formatPrivacyHits,
  PrivacyHit,
  PrivacyScanResult,
  scanAndJudge,
} from "@src/modules/deep-article/privacy.ts";

/**
 * 隐私闸门的 IO 层：负责凑齐敏感名单，纯模式匹配在 `modules/deep-article/privacy.ts`。
 *
 * 名单来源，按优先级：
 *   1. `DEEP_ARTICLE_PRIVACY_NAMES`（逗号分隔）——显式配置，权威；
 *   2. 本地已维护的推送守卫名单 `.prepush-blocklist.local.txt` 与
 *      `scripts/prepush-blocklist.txt` 里的 `block:` 条目。
 *
 * 为什么复用推送守卫名单：那份名单本来就是「绝不入库的真实姓名与单位」，
 * 已经在维护、已经 gitignore。新写一份等于多一个会漂移的真相。
 *
 * 为什么过滤短词：名单里可能有「<单位简称>」这类两字词，直接做字面量匹配会命中
 * 某些正常词组，把合格稿子拦下来。闸门误报多了就会被人关掉，
 * 那样等于没有闸门，所以名单来源取 3 字及以上；两字词请在
 * `DEEP_ARTICLE_PRIVACY_NAMES` 里显式声明，明确承担误报风险。
 */
const MIN_BLOCKLIST_TERM_LENGTH = 3;

const BLOCKLIST_FILES = [
  ".prepush-blocklist.local.txt",
  "scripts/prepush-blocklist.txt",
];

export type PrivacyGuardLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

const defaultLogger: PrivacyGuardLogger = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
};

const splitList = (raw: string | number | null): string[] => {
  if (typeof raw !== "string") return [];
  return raw.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
};

const readBlocklistTerms = async (): Promise<string[]> => {
  const terms: string[] = [];
  for (const file of BLOCKLIST_FILES) {
    try {
      const text = await Deno.readTextFile(`${Deno.cwd()}/${file}`);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = trimmed.match(/^block:\s*(.+)$/);
        if (!match) continue;
        terms.push(match[1].trim());
      }
    } catch {
      // 文件不存在是可接受的：名单本来就可能只在某台机器上有
      continue;
    }
  }
  return terms;
};

export interface BlockedTerms {
  terms: string[];
  source: string;
  fromBlocklist: string[];
  fromConfig: string[];
}

let cached: BlockedTerms | null = null;

export const resetPrivacyTermsCache = (): void => {
  cached = null;
};

/** 当前生效的敏感名单与来源说明，落盘审计用。 */
export const loadBlockedTerms = async (): Promise<BlockedTerms> => {
  if (cached) return cached;

  const fromConfig = splitList(
    await readOptionalConfig("DEEP_ARTICLE_PRIVACY_NAMES"),
  );
  const allow = new Set(
    splitList(await readOptionalConfig("DEEP_ARTICLE_PRIVACY_ALLOW")),
  );

  const rawBlocklist = await readBlocklistTerms();
  const fromBlocklist = rawBlocklist.filter((term) =>
    term.length >= MIN_BLOCKLIST_TERM_LENGTH && !allow.has(term)
  );

  const terms = [...new Set([...fromConfig, ...fromBlocklist])].filter(
    (term) => !allow.has(term),
  );

  const source = fromConfig.length > 0
    ? "DEEP_ARTICLE_PRIVACY_NAMES + 推送守卫名单"
    : (fromBlocklist.length > 0 ? "推送守卫名单" : "未配置");

  const result: BlockedTerms = { terms, source, fromBlocklist, fromConfig };
  cached = result;
  return result;
};

export interface PrivacyCheckOutcome extends PrivacyScanResult {
  /** 生效名单与来源，写进审稿报告 */
  terms: string[];
  termSource: string;
  formatted: string;
}

/**
 * 对外成稿的统一入口：正文、标题、副标题、封面文案都走这里。
 * 命中 block 级即 passed=false，调用方必须阻断发布。
 */
export const checkContentPrivacy = async (
  text: string,
  logger: PrivacyGuardLogger = defaultLogger,
): Promise<PrivacyCheckOutcome> => {
  const { terms, source } = await loadBlockedTerms();
  if (terms.length === 0) {
    logger.warn(
      "[隐私闸门] 敏感名单为空：本次只有关系词模式生效，姓名与单位不会被拦截。" +
        "请在 .env 配置 DEEP_ARTICLE_PRIVACY_NAMES，或确认推送守卫名单存在。",
    );
  }
  const result = scanAndJudge(text, { blockedTerms: terms });
  return {
    ...result,
    terms,
    termSource: source,
    formatted: formatPrivacyHits(result.hits),
  };
};

/** 把正文与全部标题合成待检文本，避免只查正文漏掉标题。 */
export const joinForPrivacyScan = (
  content: string,
  titles: string[] = [],
): string => [content, ...titles].filter(Boolean).join("\n");

export type { PrivacyHit };
