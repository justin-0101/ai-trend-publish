import { ScrapedContent } from "@src/modules/interfaces/scraper.interface.ts";
import { readOptionalConfig } from "@src/utils/config/optional-config.ts";
import {
  clampScore,
  toStringArray,
  toText,
} from "@src/modules/deep-article/llm-json.ts";
import {
  DeepArticleRunnerLike,
  DeepArticleStepRunner,
  StepRunMeta,
} from "@src/modules/deep-article/step-runner.ts";
import { listLanes } from "@src/modules/deep-article/skill-loader.ts";
import {
  extractLinks,
  hasFetchableCandidateLink,
  isFetchableCandidateLink,
} from "@src/modules/deep-article/source-link.ts";
import { parsePublishDate } from "@src/modules/deep-article/material-date.ts";

/**
 * 主题包提炼与爆款评分。
 *
 * 与 `ContentRanker` 的分工：
 *   - ContentRanker 逐条打分，用来从一批素材里挑出 N 条做速递（现有的文章工作流）；
 *   - 本模块先把素材按「事实事件」聚成主题包，再给主题包打分，用来从一批素材里
 *     挑出 1 个主题写深度文。
 *
 * 关键防御：分值由代码夹取、总分由代码相加、硬淘汰由代码执行。
 * 模型只负责聚类与给出理由，不负责决定谁能入选。
 */

export interface TopicPackageScores {
  /** 认知落差 ≤25 */
  gap: number;
  /** 现实相关 ≤20 */
  relevance: number;
  /** 争议空间 ≤15 */
  controversy: number;
  /** 素材充分 ≤20 */
  material: number;
  /** 作者可写 ≤20 */
  writable: number;
}

export interface TopicPackage {
  name: string;
  materialIds: string[];
  primarySources: string[];
  /** 从真实素材 URL/正文派生出的可抓取入口；不代表已确认一手 */
  supplementEntryLinks: string[];
  coreFacts: string[];
  widelyRepeated: string;
  omittedConditions: string[];
  controversy: string;
  lane: string;
  laneReason: string;
  authorEntry: string;
  gaps: string[];
  scores: TopicPackageScores;
  /** 代码相加得到的总分，不采用模型自报的总分 */
  total: number;
  deduction: string;
  /** 命中硬淘汰时的原因；有值时该包不参与排序入选 */
  eliminated?: string;
  /** 引用了不存在的素材 id（防幻觉记录） */
  invalidMaterialIds?: string[];
  /**
   * 领域名不是五个标准值之一。
   *
   * 不在这一步淘汰：实测模型会自创领域名（「AI 模型服务与商业化」），
   * 按字面比对就会把所有主题包误杀。领域是否成立的裁决交给
   * `lane-routing` 步骤——那一步带了完整的 content-lanes 规则，能把自创名
   * 归到最近的领域，也确实能判定「五个都不匹配」。
   */
  laneUnverified?: boolean;
  /** 模型自报的原始领域名，落盘与传参给领域路由用 */
  laneRaw?: string;
}

export interface TopicClusterResult {
  /** 全部主题包，入选者在前、被淘汰者在后 */
  packages: TopicPackage[];
  /** 排名第一且未被淘汰的主题包 */
  selected?: TopicPackage;
  /** 未被任何主题包覆盖的素材 id */
  unassigned: string[];
  /** 因长度预算未送入模型的素材数 */
  droppedByBudget: number;
  meta?: StepRunMeta;
}

export const SCORE_MAX: TopicPackageScores = {
  gap: 25,
  relevance: 20,
  controversy: 15,
  material: 20,
  writable: 20,
};

export const TOPIC_SCORE_TOTAL_MAX = Object.values(SCORE_MAX).reduce(
  (sum, value) => sum + value,
  0,
);

/** 素材送入模型时的长度预算。素材条数多、正文长，不设预算会直接爆上下文。 */
export interface MaterialBudget {
  maxMaterials: number;
  perMaterialChars: number;
  totalChars: number;
}

export const DEFAULT_MATERIAL_BUDGET: MaterialBudget = {
  maxMaterials: 60,
  perMaterialChars: 700,
  totalChars: 42000,
};

const NO_SOURCE_PATTERN = /^(无|none|n\/a|na|未知|未提供|-)$/i;

const hasRealSource = (sources: string[]): boolean =>
  sources.some((source) =>
    source.trim() && !NO_SOURCE_PATTERN.test(source.trim())
  );

/**
 * 把一批素材压进长度预算。超预算的素材按原顺序丢弃（调用方已排过序），
 * 丢弃数量返回给调用方记日志——丢了多少必须可见，不能静默。
 */
export const applyMaterialBudget = (
  contents: ScrapedContent[],
  budget: MaterialBudget = DEFAULT_MATERIAL_BUDGET,
): { kept: ScrapedContent[]; dropped: number } => {
  const kept: ScrapedContent[] = [];
  let used = 0;
  for (const content of contents) {
    if (kept.length >= budget.maxMaterials) break;
    const preview = (content.content ?? "").slice(0, budget.perMaterialChars);
    const cost = preview.length + (content.title?.length ?? 0) +
      (content.url?.length ?? 0) + 90;
    if (used + cost > budget.totalChars) break;
    used += cost;
    kept.push(content);
  }
  return { kept, dropped: contents.length - kept.length };
};

export const buildMaterialPayload = (
  contents: ScrapedContent[],
  budget: MaterialBudget = DEFAULT_MATERIAL_BUDGET,
  now: Date = new Date(),
): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${
    pad(now.getDate())
  }`;
  const blocks = contents.map((content) => {
    const body = (content.content ?? "").slice(0, budget.perMaterialChars);
    const published = parsePublishDate(content.publishDate);
    // “距今天数”必须由代码算：模型自己推“今天”会算错，
    // 真跑已踩到（模型以为今天是 2026-05-07，把 5-08 以后的素材当成未发生）。
    const age = published
      ? `（距当前 ${
        Math.floor((now.getTime() - published.getTime()) / 86_400_000)
      } 天）`
      : "（未能解析，时效未知）";
    return [
      `ID: ${content.id}`,
      `标题: ${content.title ?? ""}`,
      `发布时间: ${content.publishDate ?? ""}${age}`,
      `素材URL: ${content.url ?? ""}`,
      `内容:`,
      ,
      body,
    ].join("\n");
  });
  return [
    `【当前日期】${today}（代码生成，时效判断只能以此为“今天”）`,
    blocks.join("\n---\n"),
  ].join("\n\n");
};

interface RawPackage {
  name?: unknown;
  materialIds?: unknown;
  primarySources?: unknown;
  coreFacts?: unknown;
  widelyRepeated?: unknown;
  omittedConditions?: unknown;
  controversy?: unknown;
  lane?: unknown;
  laneReason?: unknown;
  authorEntry?: unknown;
  gaps?: unknown;
  scores?: Record<string, unknown>;
  deduction?: unknown;
  total?: unknown;
}

/**
 * 纯函数：把模型输出规范成主题包，并执行硬淘汰与排序。
 * 不需要 LLM，可直接单测。
 */
export const normalizeAndRankPackages = (
  raw: unknown,
  contents: ScrapedContent[],
  lanes: string[],
): TopicPackage[] => {
  const list = (raw as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(list)) return [];

  const validIds = new Set(contents.map((content) => String(content.id)));
  const contentById = new Map(
    contents.map((content) => [String(content.id), content]),
  );
  const packages: TopicPackage[] = [];

  for (const item of list as RawPackage[]) {
    if (!item || typeof item !== "object") continue;

    const scores = item.scores ?? {};
    const normalizedScores: TopicPackageScores = {
      gap: clampScore(scores.gap, SCORE_MAX.gap),
      relevance: clampScore(scores.relevance, SCORE_MAX.relevance),
      controversy: clampScore(scores.controversy, SCORE_MAX.controversy),
      material: clampScore(scores.material, SCORE_MAX.material),
      writable: clampScore(scores.writable, SCORE_MAX.writable),
    };
    const total = Math.round(
      (normalizedScores.gap +
        normalizedScores.relevance +
        normalizedScores.controversy +
        normalizedScores.material +
        normalizedScores.writable) * 10,
    ) / 10;

    const materialIds = toStringArray(item.materialIds);
    const invalidMaterialIds = materialIds.filter((id) => !validIds.has(id));
    const usableIds = materialIds.filter((id) => validIds.has(id));
    const primarySources = toStringArray(item.primarySources);
    const actualLinks = usableIds.flatMap((id) => {
      const content = contentById.get(id);
      return [content?.url, ...extractLinks(content?.content)];
    });
    const supplementEntryLinks = [
      ...new Set(
        actualLinks
          .filter((url): url is string => typeof url === "string")
          .filter((url) => isFetchableCandidateLink(url)),
      ),
    ];
    const coreFacts = toStringArray(item.coreFacts);
    const laneRaw = toText(item.lane);
    const laneUnverified = laneRaw.length > 0 && !lanes.includes(laneRaw);

    const eliminated = (() => {
      if (usableIds.length === 0) {
        return invalidMaterialIds.length > 0
          ? `引用的素材 id 均不存在（${
            invalidMaterialIds.slice(0, 3).join(", ")
          }）`
          : "没有关联任何素材";
      }
      if (
        !hasRealSource(primarySources) && supplementEntryLinks.length === 0
      ) {
        return "没有一手来源，也没有可抓取的补料入口";
      }
      if (coreFacts.length === 0) return "没有可核验的核心事实";
      if (!laneRaw) return "没有标注最近领域";
      // 材料门槛：只有一条素材时，必须存在可抓取的补料入口，才有把材料补厚的路径。
      // 入口既可能是素材自己的 URL，也可能是推文/快讯正文附带的官方链接；
      // 补料器会看两者，这里必须用同一套标准，不能在前置闸门先误杀。
      if (usableIds.length < 2) {
        if (!hasFetchableCandidateLink(supplementEntryLinks)) {
          return `素材只有 ${usableIds.length} 条，且没有可抓取的补料入口（材料门槛未满足）`;
        }
      }
      // 领域名不在五领域内时**不**在这里淘汰，交给 lane-routing 裁决（见 laneUnverified 注释）
      return undefined;
    })();

    packages.push({
      name: toText(item.name, "未命名主题"),
      materialIds: usableIds,
      primarySources,
      supplementEntryLinks,
      coreFacts,
      widelyRepeated: toText(item.widelyRepeated),
      omittedConditions: toStringArray(item.omittedConditions),
      controversy: toText(item.controversy),
      lane: laneUnverified ? "" : laneRaw,
      laneReason: toText(item.laneReason),
      authorEntry: toText(item.authorEntry),
      gaps: toStringArray(item.gaps),
      scores: normalizedScores,
      total,
      deduction: toText(item.deduction),
      eliminated,
      invalidMaterialIds: invalidMaterialIds.length > 0
        ? invalidMaterialIds
        : undefined,
      laneUnverified: laneUnverified || undefined,
      laneRaw: laneUnverified ? laneRaw : undefined,
    });
  }

  return packages.sort((a, b) => {
    if (Boolean(a.eliminated) !== Boolean(b.eliminated)) {
      return a.eliminated ? 1 : -1;
    }
    if (b.total !== a.total) return b.total - a.total;
    if (b.materialIds.length !== a.materialIds.length) {
      return b.materialIds.length - a.materialIds.length;
    }
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
};

/** 找出未被任何主题包覆盖的素材，用来发现模型整簇漏聚类。 */
export const findUnassignedMaterialIds = (
  packages: TopicPackage[],
  contents: ScrapedContent[],
): string[] => {
  const assigned = new Set(packages.flatMap((item) => item.materialIds));
  return contents
    .map((content) => String(content.id))
    .filter((id) => !assigned.has(id));
};

export class TopicClusterer {
  private runner: DeepArticleRunnerLike;

  constructor(runner?: DeepArticleRunnerLike) {
    this.runner = runner ?? new DeepArticleStepRunner();
  }

  /**
   * 把素材聚成主题包并排序。返回的 packages 里 selected 是唯一入选主题，
   * 调用方不需要再自己比对分数。
   */
  public async cluster(
    contents: ScrapedContent[],
    options: { budget?: MaterialBudget } = {},
  ): Promise<TopicClusterResult> {
    if (contents.length === 0) {
      return { packages: [], unassigned: [], droppedByBudget: 0 };
    }

    const budget = options.budget ?? await this.resolveBudget();
    const { kept, dropped } = applyMaterialBudget(contents, budget);
    const lanes = await listLanes();

    const { data, meta } = await this.runner.runJson<unknown>({
      stepKey: "topic-package",
      payload: buildMaterialPayload(kept, budget),
      temperature: 0.3,
    });

    const packages = normalizeAndRankPackages(data, kept, lanes);
    const unassigned = findUnassignedMaterialIds(packages, kept);
    const selected = packages.find((item) => !item.eliminated);

    return {
      packages,
      selected,
      unassigned,
      droppedByBudget: dropped,
      meta,
    };
  }

  private async resolveBudget(): Promise<MaterialBudget> {
    const maxMaterials = await this.readPositiveInt(
      "DEEP_ARTICLE_MAX_MATERIALS",
      DEFAULT_MATERIAL_BUDGET.maxMaterials,
    );
    const perMaterialChars = await this.readPositiveInt(
      "DEEP_ARTICLE_MATERIAL_CHARS",
      DEFAULT_MATERIAL_BUDGET.perMaterialChars,
    );
    return {
      maxMaterials,
      perMaterialChars,
      totalChars: DEFAULT_MATERIAL_BUDGET.totalChars,
    };
  }

  private async readPositiveInt(
    key: string,
    fallback: number,
  ): Promise<number> {
    const raw = await readOptionalConfig(key);
    if (raw === null) return fallback;
    const value = typeof raw === "number"
      ? raw
      : Number.parseInt(String(raw), 10);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }
}
