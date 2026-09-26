/**
 * 内容排序的评分标准（权重 + 档位措辞）。
 *
 * 权重与 `content-ranker.prompt.ts` 里给大模型的 20/45/20/15 完全一致 ——
 * 两条路径（LLM / Jev）必须用同一套价值判断，否则 A/B 对比没有意义。
 *
 * 官方对 Score 档位的两条硬规则（docs.typesafe.ai/primitives/score）：
 *   1. 档位写「情形」，不写「程度」，且**描述里不要出现数字**（数字会压低置信度）；
 *   2. 一个问题只测一个维度 —— 所以这里是 4 个独立问题，权重在代码里合并，
 *      而不是把「又新又实用又热门」写进同一段描述。
 *
 * 档位措辞是**初稿**：官方明确要求拿自己的真实语料校准，先跑
 * `scripts/check-jev-ranker.ts` 看分维度置信度分布，再改这里的字。
 */

export const DIMENSIONS = {
  /** 技术创新与突破性 */
  innovation: 0.20,
  /** 实用价值与应用场景 */
  utility: 0.45,
  /** 市场影响力与发展潜力 */
  influence: 0.20,
  /** 时效性与热度 */
  freshness: 0.15,
} as const;

export type DimensionKey = keyof typeof DIMENSIONS;

export const DIMENSION_KEYS = Object.keys(DIMENSIONS) as DimensionKey[];

/** 每个维度问什么（对应现有提示词里的四个评分小节） */
export const INSTRUCTIONS: Record<DimensionKey, string> = {
  innovation: "评估这条内容在技术创新上的程度：它带来的是常规迭代，还是新方法、新架构、新形态。",
  utility: "评估这条内容的实用价值：普通开发者或团队能不能直接接入、能不能解决真实问题。",
  influence: "评估这条内容对 AI 行业的影响与后续发展潜力：现在有多少团队在跟进或采纳。",
  freshness: "评估这条内容的时效性与当前热度：它是刚刚发布正在发酵，还是已经降温的旧闻。",
};

/** 档位：从低到高，位置即分数（0 起）。每档写情形，不写程度、不含数字。 */
export const CRITERIA: Record<DimensionKey, string[]> = {
  innovation: [
    "已有产品的常规更新、版本迭代或小修补，没有新方法或新能力",
    "沿用现成路线，但在效果、速度或成本上做了明确改进",
    "提出新的方法、架构或全新产品形态，与现有主流做法有明显区别",
    "开辟新方向或显著改变现有做法，同类产品短期内难以复现",
  ],
  utility: [
    "概念演示或研究预览，没有可用产品，也看不到落地路径",
    "已经可以试用，但部署或接入门槛高，或只覆盖很窄的场景",
    "有明确使用场景，普通开发者或团队能直接接入并看到效果",
    "开箱可用、接入成本低，能替代现有做法并明显提升效率",
  ],
  influence: [
    "尚无讨论度，基本只有发布者自己在说",
    "小范围关注，局限在单一社区或细分人群",
    "行业内持续讨论，多家团队开始跟进或集成",
    "被主流厂商或大量团队采纳，正在改变行业做法或竞争格局",
  ],
  freshness: [
    "陈旧内容，或与当前趋势无关",
    "发布已有一段时间，讨论正在降温",
    "近期发布，正在被讨论",
    "刚刚发布或正在快速发酵，属于当前热点",
  ],
};

/**
 * 含图加分：现有提示词里的一条规则（「如果文章中包含图片，则权重增加 10 分」）。
 * Jev 只吃文本、读不到图，所以这一分必须在代码里补，否则会静默丢掉一条既有规则。
 */
export const IMAGE_BONUS = 10;

/** 档位轴上的原始分 → 0..1。不同档位数的量表必须先归一化，权重才成立。 */
export const normalizeLevel = (level: number, levelCount: number): number => {
  const span = levelCount - 1;
  if (span <= 0) return 0;
  const ratio = level / span;
  return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
};

/**
 * 按权重合成的置信度。
 *
 * 用的是加权平均，不用 min —— 一个维度描述得模糊不该把整条判死。
 * 缺维度时**按 0 计**、不重新归一化：少答一维就该显示成低置信（送人工复核），
 * 若改成「按已答权重重新摊平」，只答一维且它很自信时会得到虚高的整体置信度。
 */
export const weightedConfidence = (
  confidences: Partial<Record<DimensionKey, number>>,
): number => {
  let sum = 0;
  for (const key of DIMENSION_KEYS) {
    const value = confidences[key];
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    sum += DIMENSIONS[key] * value;
  }
  return sum < 0 ? 0 : sum > 1 ? 1 : sum;
};

/** 按权重合成百分制分数（不含含图加分、不夹取上限） */
export const weightedScore = (
  normalized: Partial<Record<DimensionKey, number>>,
): number => {
  let sum = 0;
  for (const key of DIMENSION_KEYS) {
    const value = normalized[key];
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    sum += DIMENSIONS[key] * value;
  }
  return sum * 100;
};
