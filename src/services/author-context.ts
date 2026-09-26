import { readOptionalConfig } from "@src/utils/config/optional-config.ts";
import {
  PrivacyHit,
  redactTerms,
  sanitizeAuthorContext,
} from "@src/modules/deep-article/privacy.ts";
import {
  buildMemoryDigest,
  DEFAULT_MEMORY_ALLOW,
  DEFAULT_MEMORY_DENY,
  MemoryDigest,
} from "@src/modules/deep-article/memory-digest.ts";
import { loadBlockedTerms } from "@src/services/privacy-guard.ts";

/**
 * 作者背景的只读加载器。
 *
 * 用途：深度文采用观察者评论位，作者性来自「从哪个位置看这件事、会怎样取舍」。
 * 这部分信息不在本次采集素材里，而在作者自己的语料与档案里，所以需要读进来，
 * 生成一份**已脱敏**的背景摘要，注入 author-stance 步骤。
 *
 * 三条硬约束：
 *   1. 只读——本模块不写任何文件，也不修改语料目录；
 *   2. 不整包读——语料目录可能有几百个文件，按 mtime 取最新的若干个 + 每文件截断；
 *   3. 先脱敏再注入——金额、姓名、单位等在送进模型前整行删除，并记录删了什么。
 *
 * 路径不存在不是错误：换台机器、目录被移走都应降级成「本次没有作者背景」，
 * 而不是让整条工作流失败。
 */

export interface AuthorContextSource {
  path: string;
  chars: number;
}

export interface AuthorContextSkip {
  path: string;
  reason: string;
}

export interface AuthorContext {
  /** 已脱敏的背景摘要，可直接注入提示词 */
  summary: string;
  sources: AuthorContextSource[];
  skipped: AuthorContextSkip[];
  /** 脱敏删掉的行对应的命中，落盘审计用 */
  removed: PrivacyHit[];
  /** 生效的敏感名单来源 */
  privacyTermSource: string;
  /** 生效的敏感名单本身，供审计元数据脱敏用 */
  privacyTerms: string[];
  /** 是否拿到了任何可用背景 */
  available: boolean;
  /** 记忆包本地摘要：只含认知、观点、价值观、原则 */
  memory: MemoryDigest & {
    path: string;
    /** 脱敏从摘要里删掉的处数 */
    removedBySanitizer: number;
  };
}

export interface AuthorContextOptions {
  /** 覆盖默认语料目录，测试用 */
  roots?: string[];
  /** 覆盖默认文件清单，测试用 */
  files?: string[];
  /** 覆盖记忆包路径，测试用 */
  memoryPack?: string;
  memoryAllow?: string[];
  memoryDeny?: string[];
  memoryChars?: number;
  maxFiles?: number;
  perFileChars?: number;
  totalChars?: number;
}

export const DEFAULT_AUTHOR_CONTEXT_ROOTS = [
  "E:/agent_person_txt",
  "F:/CHC/agent_person/Agent个人档案-2020-2026",
];

/**
 * 记忆包目录。默认不写具体文件名——文件名带姓名拼音，源码里不该出现。
 * 在目录里找名字含 memory 的最新 .md，或在 .env 里用 DEEP_ARTICLE_MEMORY_PACK 指定。
 */
export const DEFAULT_MEMORY_DIR = "C:/Users/user/.pi/agent/memory";
const DEFAULT_MEMORY_CHARS = 5000;

const DEFAULT_MAX_FILES = 8;
const DEFAULT_PER_FILE_CHARS = 1500;
const DEFAULT_TOTAL_CHARS = 6000;

const TEXT_EXTENSIONS = [".md", ".txt", ".markdown"];

/** 宁可多给信号，也不要把索引/元数据文件当成正文——这些名字直接跳过 */
const NOISE_PATTERNS = [
  /^\./,
  /(^|[\\/])index\.(md|txt)$/i,
  /(^|[\\/])readme\.(md|txt)$/i,
  /(^|[\\/])changelog/i,
];

const splitList = (raw: string | number | null): string[] => {
  if (typeof raw !== "string") return [];
  return raw.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
};

const normalize = (path: string): string => path.replace(/\\/g, "/");

const readPositiveInt = async (
  key: string,
  fallback: number,
): Promise<number> => {
  const raw = await readOptionalConfig(key);
  if (raw === null) return fallback;
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

interface Candidate {
  path: string;
  modified: number;
}

/** 有界递归收集文本文件：深度与文件数都设上限，避免扫到大目录时卡住。 */
const collectCandidates = async (
  root: string,
  maxFiles: number,
  depth = 0,
): Promise<Candidate[]> => {
  if (depth > 3) return [];
  const found: Candidate[] = [];

  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > 3 || found.length >= maxFiles * 4) return;
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) entries.push(entry);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= maxFiles * 4) return;
      const full = normalize(`${dir}/${entry.name}`);
      if (entry.isDirectory) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        await walk(full, level + 1);
        continue;
      }
      if (!entry.isFile) continue;
      if (!TEXT_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        continue;
      }
      if (NOISE_PATTERNS.some((pattern) => pattern.test(full))) continue;
      try {
        const stat = await Deno.stat(full);
        found.push({ path: full, modified: stat.mtime?.getTime() ?? 0 });
      } catch {
        continue;
      }
    }
  };

  await walk(normalize(root), depth);
  return found;
};

export interface AuthorContextLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

const defaultLogger: AuthorContextLogger = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
};

const splitTerms = (raw: string | number | null): string[] =>
  splitList(raw).filter((item) => item !== "-");

/** 在记忆包目录里找名字含 memory 的最新 .md；找不到返回 null。 */
export const discoverMemoryPack = async (
  dir: string,
): Promise<string | null> => {
  const candidates: Candidate[] = [];
  try {
    for await (const entry of Deno.readDir(normalize(dir))) {
      if (!entry.isFile) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (!entry.name.toLowerCase().includes("memory")) continue;
      const full = normalize(`${dir}/${entry.name}`);
      try {
        const stat = await Deno.stat(full);
        candidates.push({ path: full, modified: stat.mtime?.getTime() ?? 0 });
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.modified - a.modified);
  return candidates[0].path;
};

/**
 * 装载记忆包并做本地摘要。任何一步失败都降级成「本次没有记忆包」，
 * 绝不回退到「把整包原文送出去」——那是这个函数存在的意义所在。
 */
export const loadMemoryDigest = async (
  options: AuthorContextOptions,
  logger: AuthorContextLogger,
  blockedTerms: string[],
): Promise<{ digest: MemoryDigest; path: string; removedBySanitizer: number }> => {
  const dir = splitTerms(await readOptionalConfig("DEEP_ARTICLE_MEMORY_DIR"))[0] ??
    DEFAULT_MEMORY_DIR;

  // 区分「没给」（→ 去配置/目录找）与「显式给空串」（→ 本次不接记忆包）。
  // 不区分的话，测试会去读到本机真实的记忆包，既是不稳定也是隔离漏洞。
  let path = "";
  let explicitlyOff = false;
  if (options.memoryPack !== undefined) {
    path = options.memoryPack.trim();
    explicitlyOff = path.length === 0;
  } else {
    const fromConfig = splitTerms(
      await readOptionalConfig("DEEP_ARTICLE_MEMORY_PACK"),
    )[0];
    path = fromConfig || (await discoverMemoryPack(dir)) || "";
  }

  const empty = (reason: string): { digest: MemoryDigest; path: string; removedBySanitizer: number } => {
    logger.warn(`[记忆包] ${reason}，本次不注入作者记忆`);
    return {
      digest: {
        text: "",
        kept: [],
        dropped: [{
          heading: "(整包)",
          path: redactTerms(path, blockedTerms),
          reason: "未命中允许清单",
        }],
        available: false,
      },
      path,
      removedBySanitizer: 0,
    };
  };

  if (!path) {
    return empty(
      explicitlyOff
        ? "调用方显式关闭记忆包"
        : `没有找到记忆包（目录 ${redactTerms(dir, blockedTerms)}）`,
    );
  }

  let markdown: string;
  try {
    markdown = await Deno.readTextFile(path);
  } catch (error) {
    return empty(
      `读取失败：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }

  const allow = options.memoryAllow ??
    (splitTerms(await readOptionalConfig("DEEP_ARTICLE_MEMORY_SECTIONS"))
      .length > 0
      ? splitTerms(await readOptionalConfig("DEEP_ARTICLE_MEMORY_SECTIONS"))
      : DEFAULT_MEMORY_ALLOW);
  const deny = options.memoryDeny ??
    (splitTerms(await readOptionalConfig("DEEP_ARTICLE_MEMORY_DENY"))
      .length > 0
      ? splitTerms(await readOptionalConfig("DEEP_ARTICLE_MEMORY_DENY"))
      : DEFAULT_MEMORY_DENY);
  const maxChars = options.memoryChars ??
    await readPositiveInt("DEEP_ARTICLE_MEMORY_CHARS", DEFAULT_MEMORY_CHARS);

  const digest = buildMemoryDigest(markdown, { allow, deny, maxChars });
  // 第二道网：章节筛选已排掉事实性章节，这里再扫一遍金额、姓名、单位等模式
  const sanitized = sanitizeAuthorContext(digest.text, { blockedTerms });
  // 审计元数据也脱敏：章节标题常带姓名（例如「某某 · Agent 记忆包」），
  // 否则落盘的 02-作者背景.md 会把名字写进去。
  const finalDigest: MemoryDigest = {
    ...digest,
    text: sanitized.text,
    kept: digest.kept.map((item) => ({
      ...item,
      heading: redactTerms(item.heading, blockedTerms),
      path: redactTerms(item.path, blockedTerms),
    })),
    dropped: digest.dropped.map((item) => ({
      ...item,
      heading: redactTerms(item.heading, blockedTerms),
      path: redactTerms(item.path, blockedTerms),
    })),
    available: sanitized.text.length > 0,
  };

  if (!finalDigest.available) {
    return empty("摘要为空（允许清单没匹配到任何章节，或全部被脱敏）");
  }

  logger.info(
    `[记忆包] ${redactTerms(path, blockedTerms)}：采用 ${digest.kept.length} 节，` +
      `跳过 ${digest.dropped.length} 节，` +
      `共 ${finalDigest.text.length} 字；脱敏再删 ${sanitized.removed.length} 处`,
  );
  return { digest: finalDigest, path, removedBySanitizer: sanitized.removed.length };
};

/**
 * 读取并脱敏作者背景。任何单文件失败只记录 skipped，不影响其余文件。
 */
export const loadAuthorContext = async (
  options: AuthorContextOptions = {},
  logger: AuthorContextLogger = defaultLogger,
): Promise<AuthorContext> => {
  const skipped: AuthorContextSkip[] = [];
  const sources: AuthorContextSource[] = [];
  const removed: PrivacyHit[] = [];

  const explicitFiles = options.files ??
    splitList(await readOptionalConfig("DEEP_ARTICLE_AUTHOR_CONTEXT_FILES"));
  const roots = options.roots ??
    (splitList(await readOptionalConfig("DEEP_ARTICLE_AUTHOR_CONTEXT_ROOTS"))
      .length > 0
      ? splitList(await readOptionalConfig("DEEP_ARTICLE_AUTHOR_CONTEXT_ROOTS"))
      : DEFAULT_AUTHOR_CONTEXT_ROOTS);

  const maxFiles = options.maxFiles ??
    await readPositiveInt(
      "DEEP_ARTICLE_AUTHOR_CONTEXT_MAX_FILES",
      DEFAULT_MAX_FILES,
    );
  const perFileChars = options.perFileChars ??
    await readPositiveInt(
      "DEEP_ARTICLE_AUTHOR_CONTEXT_PER_FILE_CHARS",
      DEFAULT_PER_FILE_CHARS,
    );
  const totalChars = options.totalChars ??
    await readPositiveInt(
      "DEEP_ARTICLE_AUTHOR_CONTEXT_CHARS",
      DEFAULT_TOTAL_CHARS,
    );

  // 收集候选：显式清单优先，否则从语料目录按最近修改取
  let candidates: Candidate[] = [];
  if (explicitFiles.length > 0) {
    candidates = explicitFiles.map((path) => ({
      path: normalize(path),
      modified: 0,
    }));
  } else {
    for (const root of roots) {
      const found = await collectCandidates(root, maxFiles);
      if (found.length === 0) {
        skipped.push({ path: normalize(root), reason: "目录不存在或没有文本文件" });
      }
      candidates.push(...found);
    }
    candidates.sort((a, b) => b.modified - a.modified);
  }

  const { terms, source: termSource } = await loadBlockedTerms();

  // 记忆包：本地摘要（只留认知、观点、价值观、原则），先于语料处理，
  // 因为它比语料更能提供「他会怎么看待一件事」。
  const memory = await loadMemoryDigest(options, logger, terms);

  let used = 0;
  const blocks: string[] = [];
  for (const candidate of candidates) {
    if (sources.length >= maxFiles) break;
    if (used >= totalChars) break;

    let raw: string;
    try {
      raw = await Deno.readTextFile(candidate.path);
    } catch (error) {
      skipped.push({
        path: candidate.path,
        reason: `读取失败：${error instanceof Error ? error.message : "未知错误"}`,
      });
      continue;
    }

    const budget = Math.min(perFileChars, totalChars - used);
    const head = raw.slice(0, budget);
    if (!head.trim()) {
      skipped.push({ path: candidate.path, reason: "空文件" });
      continue;
    }

    const sanitized = sanitizeAuthorContext(head, { blockedTerms: terms });
    removed.push(...sanitized.removed);
    if (!sanitized.text.trim()) {
      skipped.push({
        path: candidate.path,
        reason: "脱敏后无剩余内容（整篇命中敏感规则）",
      });
      continue;
    }

    // 注入模型时用匿名编号，不把本地绝对路径写进提示词：
    // 模型不需要路径，而路径常常带私人目录名与姓名。真实路径仍记在 sources 里供落盘审计。
    const label = `作者材料-${sources.length + 1}`;
    blocks.push(`<${label}>\n${sanitized.text}\n</${label}>`);
    sources.push({ path: candidate.path, chars: sanitized.text.length });
    used += sanitized.text.length;
  }

  const corpusSummary = blocks.join("\n\n");
  const summary = [
    memory.digest.available
      ? `<作者认知与原则 来源="本地摘要，仅含观点与原则">\n${memory.digest.text}\n</作者认知与原则>`
      : "",
    corpusSummary,
  ].filter(Boolean).join("\n\n");

  const available = sources.length > 0 || memory.digest.available;
  if (sources.length === 0 && !memory.digest.available) {
    logger.warn(
      `[作者背景] 未取到任何可用材料（候选 ${candidates.length} 份，全部跳过）。` +
        `作者性将只能依赖认知路径，不依赖既有语料。`,
    );
  } else {
    logger.info(
      `[作者背景] 语料 ${sources.length} 份 + 记忆包 ${memory.digest.kept.length} 节，` +
        `共 ${summary.length} 字；语料胜敏删除 ${removed.length} 处；名单来源：${termSource}。`,
    );
  }

  return {
    summary,
    sources,
    skipped,
    removed,
    privacyTermSource: termSource,
    privacyTerms: terms,
    available,
    memory: {
      ...memory.digest,
      path: memory.path,
      removedBySanitizer: memory.removedBySanitizer,
    },
  };
};
