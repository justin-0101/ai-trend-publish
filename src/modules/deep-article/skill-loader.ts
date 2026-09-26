import { readOptionalConfig } from "@src/utils/config/optional-config.ts";

/**
 * 深度文写作 skill 的步骤装载器。
 *
 * 设计意图：skill 目录里有 2500 行以上 references，不可能整包塞进提示词。
 * `references/skill-step-map.json` 把「第几步 → 注入哪几个 reference」外置，
 * 工作流按表注入。skill 迭代时改 JSON，不用改 TS。
 *
 * 只读：本模块不会写入 skill 目录。
 */

/** 步骤定义：refs 为相对 skill 根的路径。 */
export interface SkillStep {
  title: string;
  refs: string[];
  /** 为 true 时，若调用方给了 lane，额外注入 content-lanes.md 里对应领域的章节 */
  includeLaneSection?: boolean;
  maxChars?: number;
  /** 该步的任务指令，直接进入提示词尾部 */
  instruction: string;
}

export interface SkillStepMap {
  version: number;
  name: string;
  skillRoots: string[];
  preamble: { ref: string; section: string; maxChars?: number };
  /** 每一步都注入的红线（隐私、观察者位） */
  sharedRefs: string[];
  /** 领域名 → content-lanes.md 里的 ## 章节标题 */
  laneSections: Record<string, string>;
  steps: Record<string, SkillStep>;
}

/**
 * 引导用候选路径：读 map 之前必须先能定位 skill 根，所以这里必须写死一份。
 * map 里的 skillRoots 在定位成功后才生效（用于记录与人工核对）。
 */
const BOOTSTRAP_SKILL_ROOTS = [
  "F:/wechat-skills/write-ai-wechat-article",
  "E:/openclaw-skills/write-ai-wechat-article",
];

const STEP_MAP_RELATIVE = "references/skill-step-map.json";
const LANE_SOURCE_RELATIVE = "references/content-lanes.md";

const joinPath = (base: string, relative: string): string =>
  `${base.replace(/[\\/]+$/, "")}/${relative.replace(/^[\\/]+/, "")}`;

const fileExists = async (path: string): Promise<boolean> => {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch {
    return false;
  }
};

const readText = (path: string): Promise<string> =>
  Deno.readTextFile(path).then((text) => text.replace(/\r\n?/g, "\n"));

export class SkillLoaderError extends Error {}

interface LoadedSkill {
  root: string;
  map: SkillStepMap;
  /** 相对路径 → 文件正文，避免同一步骤重复读盘 */
  files: Map<string, string>;
}

let loaded: LoadedSkill | null = null;

/** 清缓存。测试用；正常流程不需要调用。 */
export const resetSkillLoaderCache = (): void => {
  loaded = null;
};

const resolveCandidates = async (): Promise<string[]> => {
  const override = await readOptionalConfig("DEEP_ARTICLE_SKILL_ROOT");
  const candidates: string[] = [];
  if (typeof override === "string" && override.trim()) {
    candidates.push(override.trim());
  }
  candidates.push(...BOOTSTRAP_SKILL_ROOTS);
  return [...new Set(candidates)];
};

/**
 * 定位 skill 根并读取步骤表。找不到时抛可操作的错误（列出所有尝试过的路径），
 * 而不是退化成一个含糊的「文件不存在」。
 */
export const loadSkill = async (): Promise<LoadedSkill> => {
  if (loaded) return loaded;

  const candidates = await resolveCandidates();
  const tried: string[] = [];
  for (const root of candidates) {
    const mapPath = joinPath(root, STEP_MAP_RELATIVE);
    tried.push(mapPath);
    if (!await fileExists(mapPath)) continue;
    const raw = await readText(mapPath);
    let map: SkillStepMap;
    try {
      map = JSON.parse(raw) as SkillStepMap;
    } catch (error) {
      throw new SkillLoaderError(
        `skill 步骤表不是合法 JSON：${mapPath}（${
          error instanceof Error ? error.message : String(error)
        }）`,
      );
    }
    if (!map.steps || Object.keys(map.steps).length === 0) {
      throw new SkillLoaderError(`skill 步骤表没有任何步骤：${mapPath}`);
    }
    loaded = { root, map, files: new Map([[STEP_MAP_RELATIVE, raw]]) };
    return loaded;
  }

  throw new SkillLoaderError(
    `找不到 skill 步骤表 ${STEP_MAP_RELATIVE}。已尝试：${tried.join(" | ")}。` +
      `请确认 skill 目录存在，或用 DEEP_ARTICLE_SKILL_ROOT 指定 skill 根目录。`,
  );
};

/** 取步骤定义；缺失时报可操作的错误并列出全部可用步骤。 */
const requireStep = (skill: LoadedSkill, stepKey: string): SkillStep => {
  const step = skill.map.steps[stepKey];
  if (!step) {
    throw new SkillLoaderError(
      `skill 步骤表里没有步骤 "${stepKey}"。可用步骤：${
        Object.keys(skill.map.steps).join(", ")
      }`,
    );
  }
  return step;
};

const readSkillFile = async (
  skill: LoadedSkill,
  relative: string,
): Promise<string> => {
  const cached = skill.files.get(relative);
  if (cached !== undefined) return cached;
  const path = joinPath(skill.root, relative);
  if (!await fileExists(path)) {
    throw new SkillLoaderError(`skill 缺少文件：${path}`);
  }
  const text = await readText(path);
  skill.files.set(relative, text);
  return text;
};

/** markdown 标题行的层级；不是标题返回 0。 */
const headingLevel = (line: string): number => {
  const match = line.match(/^(#{1,6})\s+\S/);
  return match ? match[1].length : 0;
};

/**
 * 取 markdown 里某个标题下的整节内容（含标题行本身），到下一个同级或更高级标题为止。
 * 找不到返回 null——调用方决定是报错还是跳过，这里不猜。
 */
export const extractMarkdownSection = (
  markdown: string,
  heading: string,
): string | null => {
  const wanted = heading.trim();
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === wanted);
  if (start === -1) return null;

  const startLevel = headingLevel(lines[start]);
  // 不是标题行时返回 null，而不是取到文件末尾：
  // startLevel 为 0 会让下面的循环条件永远为假，结果是「契约说 null、实现给全文」，
  // 失败方向是提示词里被塞进远超预期的内容。
  if (startLevel === 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const currentLevel = headingLevel(lines[i]);
    if (currentLevel > 0 && currentLevel <= startLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
};

/**
 * 按 maxChars 在段落边界截断。段落太长时硬截，并留下截断标记，
 * 避免把半句话当成完整要求注入提示词。
 */
export const truncateAtParagraph = (text: string, maxChars: number): string => {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const cut = head.lastIndexOf("\n\n");
  const body = cut > maxChars * 0.5 ? head.slice(0, cut) : head;
  return `${body.trimEnd()}\n\n[本段已截断：完整内容见 skill 原文]`;
};

export interface BuildStepPartsOptions {
  /** 领域名，需与 laneSections 的键一致；仅在该步 includeLaneSection 时使用 */
  lane?: string;
}

/**
 * 拼出该步需要注入的 system 段，按顺序：
 * preamble 的五层执行原则 → sharedRefs（隐私/观察者位）→ 该步 refs → 领域章节。
 * 返回数组而不是一整个字符串，方便调用方按需再裁剪或落盘审计。
 */
export const buildStepSystemParts = async (
  stepKey: string,
  options: BuildStepPartsOptions = {},
): Promise<string[]> => {
  const skill = await loadSkill();
  const step = requireStep(skill, stepKey);

  const parts: string[] = [];
  const cap = step.maxChars ?? 12000;

  const { ref, section, maxChars: preambleCap } = skill.map.preamble;
  const preambleSource = await readSkillFile(skill, ref);
  const preambleSection = extractMarkdownSection(preambleSource, section);
  if (preambleSection) {
    parts.push(
      `【写作原则】\n${
        truncateAtParagraph(preambleSection, preambleCap ?? 3000)
      }`,
    );
  }

  for (const shared of skill.map.sharedRefs) {
    const text = await readSkillFile(skill, shared);
    parts.push(`【红线：${shared}】\n${truncateAtParagraph(text, cap)}`);
  }

  for (const refPath of step.refs) {
    const text = await readSkillFile(skill, refPath);
    parts.push(`【规范：${refPath}】\n${truncateAtParagraph(text, cap)}`);
  }

  if (step.includeLaneSection) {
    if (!options.lane) {
      throw new SkillLoaderError(
        `步骤 "${stepKey}" 需要主领域，但调用方没有给 lane`,
      );
    }
    const heading = skill.map.laneSections[options.lane];
    if (!heading) {
      throw new SkillLoaderError(
        `领域 "${options.lane}" 不在 laneSections 里。已知领域：${
          Object.keys(skill.map.laneSections).join(" | ")
        }`,
      );
    }
    const laneSource = await readSkillFile(skill, LANE_SOURCE_RELATIVE);
    const laneSection = extractMarkdownSection(laneSource, heading);
    if (!laneSection) {
      throw new SkillLoaderError(
        `content-lanes.md 里找不到章节 "${heading}"（领域：${options.lane}）`,
      );
    }
    parts.push(`【本篇主领域链路：${options.lane}】\n${
      truncateAtParagraph(laneSection, cap)
    }`);
  }

  return parts;
};

export const getStepInstruction = async (stepKey: string): Promise<string> => {
  const skill = await loadSkill();
  return requireStep(skill, stepKey).instruction;
};

export const getStepTitle = async (stepKey: string): Promise<string> => {
  const skill = await loadSkill();
  return skill.map.steps[stepKey]?.title ?? stepKey;
};

export const listLanes = async (): Promise<string[]> => {
  const skill = await loadSkill();
  return Object.keys(skill.map.laneSections);
};

export const getSkillRoot = async (): Promise<string> => {
  const skill = await loadSkill();
  return skill.root;
};
