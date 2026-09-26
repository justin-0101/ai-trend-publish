/**
 * 内容去重：合并「同一篇内容被多个号转发/引用」这类重复。
 *
 * 为什么从排序器手里拿回来自己做
 * ------------------------------------------------------------------
 * 原来去重是让 LLM 在评分时顺手做的（提示词里写着「相似文章只保留分数最高的一篇」）。
 * 实测代价很大：30 条输入只回来 17–29 条，而它认的「相似」里混着同主题、不同事件的内容 ——
 * 做 GEO 选题时同类内容被合并掉，剩下的反而是泛 AI 热点。丢哪一条不可控、也不可审计。
 * 更关键的是：「关键词相关优先」只在排序之后起作用，条目在 LLM 那一步就没了的话，
 * 后面再怎么排都救不回来。
 *
 * 用什么信号（全部在本机算，不依赖模型）
 * ------------------------------------------------------------------
 *   1. 归一化正文完全相同，或一条完整包含另一条；
 *   2. 归一化正文的字符二元组包含度 ≥ 阈值（默认 0.9）；
 *   3. 归一化首行（标题）完全相同；
 *   4. URL 相同（数据源带 url 时，例如 FireCrawl / Twitter）。
 *
 * 阈值为什么定 0.9 这么高
 * ------------------------------------------------------------------
 * 拿真实数据量过（X 搜索 30 条、Twitter 时间线 20 条 + FireCrawl）：
 *   - 字符二元组包含度上限只有 0.76，且那几对是「同主题、不同帖」；
 *   - char-4-gram Jaccard 上限 0.25；
 *   - 标题完全相同 0 对、正文完全相同 0 对、同 URL 0 组（DOM 抓取拿不到 URL）。
 * 也就是说短帖只要把阈值放低，就会开始合并「同主题但内容不同」的帖子。
 * 取舍很清楚：**宁可少合并，也不误删** —— 少合并只是文章里多一条同类内容，
 * 误合并是内容凭空消失。
 */

import { ScrapedContent } from "../modules/interfaces/scraper.interface.ts";
import { RankResult } from "../modules/interfaces/content-ranker.interface.ts";

export interface DedupeOptions {
  /** 字符二元组包含度阈值，默认 0.9（越高越保守） */
  threshold?: number;
  /**
   * 按位置而不是按 id 建立「原文索引」。
   *
   * 默认 false，保持既有行为。置 true 给 id 可能重复的调用方。
   * 为什么需要它：id 重复（例如同一条推文的 url 被两个源各抽一次，id 就是 url）时，
   * `byId` 只会留下最后一条，于是**重复项的 id 与代表项完全相同**；
   * 调用方若再按 id 过滤存活项，就会把重复项全部捞回来，去重等于没做。
   * 读 `dedupeScrapedContents` 就免了这个坑。
   */
  keyByIndex?: boolean;
}

export interface DroppedItem {
  id: string;
  /** 被保留的那一条的 id（它才是重复组的代表） */
  duplicateOf: string;
  reason: string;
  /** 文本相似度，仅 similarity 规则有值 */
  similarity?: number;
}

/** dedupeScrapedContents 额外带回下标，便于留档写清「第几条被顶掉」 */
export interface DroppedAt extends DroppedItem {
  /** 在入参数组里的下标 */
  atIndex: number;
  /** 代表项在入参数组里的下标 */
  duplicateOfIndex: number;
}

export interface DedupeResult {
  kept: RankResult[];
  dropped: DroppedItem[];
}

const normalize = (text: string): string =>
  String(text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** 去掉空格后的字符二元组：中文按字、英文按字符，短文本也能算出稳定指纹 */
const bigrams = (text: string): Set<string> => {
  const dense = normalize(text).replace(/ /g, "");
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= dense.length; i++) grams.add(dense.slice(i, i + 2));
  return grams;
};

/** 包含度 = 交集 / 较短一方的规模。比 Jaccard 更适合「短帖被长帖完整引用」的情形 */
const containment = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / Math.min(a.size, b.size);
};

const firstLine = (content: ScrapedContent): string =>
  normalize(
    String(content.title ?? "").split("\n").map((s) => s.trim()).filter(Boolean)[0] ??
      "",
  );

interface Fingerprint {
  id: string;
  /** 标题+正文归一化（用于相似度） */
  text: string;
  /** 仅正文归一化（用于「同文」「完整包含」这类判定，避免标题不同就绕过） */
  body: string;
  grams: Set<string>;
  title: string;
  url: string;
}

const fingerprint = (content: ScrapedContent): Fingerprint => {
  const title = content.title ?? "";
  const body = content.content ?? "";
  return {
    id: String(content.id),
    text: normalize(`${title} ${body}`),
    body: normalize(body),
    grams: bigrams(`${title} ${body}`),
    title: firstLine(content),
    url: String(content.url ?? "").trim().toLowerCase(),
  };
};

/**
 * 按输入顺序去重：**保留先出现的，丢弃后面重复的**。
 *
 * 输入顺序是有意义的 —— 工作流传进来时已经是「关键词命中在前、同组内按分数降序」，
 * 所以「先出现的」天然就是「更该留的那一条」（既相关、又高分），
 * 不需要在这里再写一遍关键词逻辑。
 */
export const dedupeContents = (
  ordered: RankResult[],
  contents: ScrapedContent[],
  options: DedupeOptions = {},
): DedupeResult => {
  const threshold = options.threshold ?? 0.9;
  const byId = new Map(
    contents.map((c, index) => [
      options.keyByIndex ? String(index) : String(c.id),
      c,
    ]),
  );
  const kept: RankResult[] = [];
  const keptPrints: Fingerprint[] = [];
  const dropped: DroppedItem[] = [];

  for (const item of ordered) {
    const content = byId.get(String(item.id));
    // 找不到原文就照原样保留：去重不该因为「拿不到正文」而吃掉条目
    if (!content) {
      kept.push(item);
      continue;
    }
    const current = fingerprint(content);

    let duplicate: DroppedItem | null = null;
    for (const previous of keptPrints) {
      if (current.url && previous.url && current.url === previous.url) {
        duplicate = {
          id: current.id,
          duplicateOf: previous.id,
          reason: "url",
        };
        break;
      }
      if (current.body && current.body === previous.body) {
        duplicate = {
          id: current.id,
          duplicateOf: previous.id,
          reason: "same-text",
        };
        break;
      }
      if (current.title && current.title === previous.title) {
        duplicate = {
          id: current.id,
          duplicateOf: previous.id,
          reason: "same-title",
        };
        break;
      }
      // 一边完整包含另一边（粘贴/引用整段）
      if (
        current.body && previous.body &&
        (current.body.includes(previous.body) || previous.body.includes(current.body))
      ) {
        duplicate = {
          id: current.id,
          duplicateOf: previous.id,
          reason: "contained",
        };
        break;
      }
      const similarity = containment(current.grams, previous.grams);
      if (similarity >= threshold) {
        duplicate = {
          id: current.id,
          duplicateOf: previous.id,
          reason: "similar",
          similarity: Number(similarity.toFixed(3)),
        };
        break;
      }
    }

    if (duplicate) dropped.push(duplicate);
    else {
      kept.push(item);
      keptPrints.push(current);
    }
  }

  return { kept, dropped };
};

/**
 * 按位置去重，返回保留下来的**原文**而不是 id。
 *
 * 专门给 id 可能重复的调用方用（深度文工作流：同一条推文会被 twitter 与
 * twitter-cookie 两个源各抽一次，id 取的就是 url）。按 id 过滤存活项在这种数据上
 * 会把重复项全捞回来，等于没去重；按下标就与 id 是否重复无关了。
 *
 * 返回的 `dropped` 里的 id 已还原成**原文的 id**，并附上在入参数组里的下标
 * （`atIndex` / `duplicateOfIndex`）——留档时才能写清“第几条被谁顶掉了”。
 */
export const dedupeScrapedContents = (
  contents: ScrapedContent[],
  options: DedupeOptions = {},
): { kept: ScrapedContent[]; dropped: DroppedAt[] } => {
  if (contents.length === 0) return { kept: [], dropped: [] };

  const ordered: RankResult[] = contents.map((_, index) => ({
    id: String(index),
    score: 0,
  }));
  const { kept, dropped } = dedupeContents(ordered, contents, {
    ...options,
    keyByIndex: true,
  });
  const keptIndexes = new Set(kept.map((item) => String(item.id)));

  return {
    kept: contents.filter((_, index) => keptIndexes.has(String(index))),
    dropped: dropped.map((entry) => ({
      ...entry,
      id: String(contents[Number(entry.id)]?.id ?? entry.id),
      duplicateOf: String(
        contents[Number(entry.duplicateOf)]?.id ?? entry.duplicateOf,
      ),
      atIndex: Number(entry.id),
      duplicateOfIndex: Number(entry.duplicateOf),
    })),
  };
};
