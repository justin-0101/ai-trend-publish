import {
  ContentScraper,
  ScrapedContent,
} from "../modules/interfaces/scraper.interface.ts";
import { BarkNotifier } from "../modules/notify/bark.notify.ts";
import { WeixinPublisher } from "../modules/publishers/weixin.publisher.ts";
import { WeixinArticleTemplateRenderer } from "../modules/render/article.renderer.ts";
import { WeixinTemplate } from "../modules/render/interfaces/article.type.ts";
import {
  DeepArticleRunnerLike,
  DeepArticleStepRunner,
} from "../modules/deep-article/step-runner.ts";
import {
  asArray,
  asRecord,
  hasContent,
  toStringArray,
  toText,
} from "../modules/deep-article/llm-json.ts";
import {
  collectHardGateFailures,
  evaluateGate,
  formatGateReport,
  GateResult,
} from "../modules/deep-article/review-gate.ts";
import {
  isFetchableCandidateLink,
  pickSupplementLinks,
} from "../modules/deep-article/source-link.ts";
import { parsePublishDate } from "../modules/deep-article/material-date.ts";
import {
  formatPrivacyHits,
  PrivacyHit,
  reconcileLlmPrivacyHits,
  redactTerms,
} from "../modules/deep-article/privacy.ts";
import {
  buildDeepArticleScrapers,
  collectDeepArticleMaterials,
  renderCollectOutcome,
} from "./deep-article-collect.ts";
import {
  archiveDraft,
  markArchivedDraftPublished,
  readPublishFailure,
} from "./draft-archive.ts";
import {
  TopicClusterer,
  TopicClusterResult,
  TopicPackage,
} from "./topic-cluster.ts";
import { AuthorContext, loadAuthorContext } from "./author-context.ts";
import { checkContentPrivacy, joinForPrivacyScan } from "./privacy-guard.ts";
import {
  buildDeepArticleRunDirName,
  contentToMarkdown,
  DeepArticleArtifact,
  renderRecordMarkdown,
  resolveDeepArticleRunDir,
  writeDeepArticleArtifacts,
} from "./deep-article-archive.ts";
import { readOptionalConfig } from "@src/utils/config/optional-config.ts";
import { resolveCover } from "@src/utils/image/cover-fallback.ts";
import { ImageGeneratorFactory } from "@src/providers/image-gen/image-generator-factory.ts";
import {
  WorkflowEntrypoint,
  WorkflowEnv,
  WorkflowEvent,
  WorkflowStep,
} from "../works/workflow.ts";
import { WorkflowTerminateError } from "../works/workflow-error.ts";

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(msg, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
  debug: (msg: string, ...args: unknown[]) => console.debug(msg, ...args),
};

/**
 * 深度文工作流。
 *
 * 与现有的文章工作流的分工：
 *   - 文章工作流 = 速递，每条素材一段摘要，凑成 10 条合集；
 *   - 本工作流 = 从时效窗口内素材里提炼主题包，按爆款评分选 1 个主题，写 1 篇
 *     1400-2200 字的原创评论稿，走 skill `write-ai-wechat-article` 的完整链路。
 *
 * 与 skill 的三处刻意偏差（都写在报告里，不静默）：
 *   1. 采用**观察者评论位**：不做作者素材访谈、不虚构亲历，作者性来自判断位置、
 *      取舍标准、边界承认与可复用观察标准（`references/observer-stance.md`）。
 *   2. 新增第五领域「AI 行业与技术观察」，让当天抓到的行业素材有落点。
 *   3. 发布状态只到「机器达标」：自动化流程不得替作者确认，发布前需本人阅读。
 */

export interface WeixinDeepWorkflowEnv {
  name: string;
  draftWriter?: (
    draft: { title: string; html: string; workflowType: string },
  ) => Promise<unknown>;
  draftStatusWriter?: (
    id: string,
    status: "draft" | "published",
  ) => Promise<unknown>;
}

export interface WeixinDeepWorkflowParams {
  sourceType?:
    | "all"
    | "firecrawl"
    | "twitter"
    | "twitter-cookie"
    | "x-search";
  includeKeywords?: string[];
  excludeKeywords?: string[];
  maxMaterials?: number;
  /** 显式指定领域；不给则由领域路由步骤判断 */
  lane?: string;
  /** 默认 false：深度文默认只出稿归档，不发公众号 */
  publish?: boolean;
  publishMode?: "immediate" | "draft";
  forcePublish?: boolean;
  /** 默认 true：读取作者语料生成背景（已先脱敏） */
  useAuthorContext?: boolean;
  templateType?: string;
}

/** 步骤之间传递的研究包。只放后续步骤真正要用的字段。 */
interface ResearchBundle {
  package: TopicPackage;
  /** 选中主题包关联的素材正文；起草与审稿都需要，不能只传 id */
  materials: ScrapedContent[];
  /** 经 material-gap 与真实 URL 对账确认可进入证据链的补料 */
  supplements: ScrapedContent[];
  authorContext: AuthorContext;
  lane: string;
  laneCard: Record<string, unknown>;
  materialGap: Record<string, unknown>;
  stance: Record<string, unknown>;
  evidence: Record<string, unknown>;
  thesis: Record<string, unknown>;
  craft: Record<string, unknown>;
}

/**
 * 可注入的依赖。全部可选：不传就走真实实现。
 * 存在的唯一理由是让编排能被零成本测到（桩 runner + 桩抓取器 + 桩发布器）。
 */
export interface WeixinDeepWorkflowDeps {
  runner?: DeepArticleRunnerLike;
  topicClusterer?: Pick<TopicClusterer, "cluster">;
  publisher?: WeixinPublisher;
  notifier?: BarkNotifier;
  renderer?: WeixinArticleTemplateRenderer;
  scrapers?: Map<string, ContentScraper>;
  /** 覆盖作者背景加载，测试用 */
  authorContextLoader?: typeof loadAuthorContext;
}

const DEFAULT_DEEP_TEMPLATE = "deep";

/** 摘要式限制：单条素材在主题包与证据步骤里的最大长度 */
const MATERIAL_PREVIEW_CHARS = 900;

/** § 模型输出一律先过 asRecord，再取字段；pickString 不再接受非字符串。 */
const pickString = (record: Record<string, unknown>, key: string): string =>
  toText(record[key]);

/** 本地 `YYYY-MM-DD`。给模型一个代码生成的时间锚点，避免它自行猜“今天”。 */
const localDateLabel = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${
    pad(date.getDate())
  }`;
};

/** 素材距当前的天数；解析不出发布时间时返回 null（不猜）。 */
const ageInDays = (publishDate: unknown, now: Date): number | null => {
  const parsed = parsePublishDate(publishDate);
  if (!parsed) return null;
  return Math.floor((now.getTime() - parsed.getTime()) / 86_400_000);
};

/** URL 对账只忽略 hash 与末尾斜杠，不做跨域或路径猜测。 */
const normalizeSourceUrl = (value: unknown): string => {
  const text = toText(value).trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    url.hash = "";
    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return text.endsWith("/") ? text.slice(0, -1) : text;
  }
};

/** 读取一个正整数配置；缺失或非法时用兜底值。 */
const readDeepConfigInt = async (
  key: string,
  fallback: number,
): Promise<number> => {
  const raw = await readOptionalConfig(key);
  if (raw === null) return fallback;
  const value = typeof raw === "number"
    ? raw
    : Number.parseInt(String(raw), 10);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

/**
 * 段落分隔符归一化。
 * 模型会写 `<next_paragraph/>`（无空格）甚至干脆用空行，那样整篇 2000 字
 * 会被渲染成一个大 div，而且没有任何告警。所以在渲染与归档前统一一次。
 */
export const normalizeParagraphMarkers = (content: string): string =>
  String(content ?? "")
    .replace(/<\s*next_paragraph\s*\/?\s*>/gi, "<next_paragraph />")
    .replace(/<\s*\/\s*next_paragraph\s*>/gi, "<next_paragraph />");

export class WeixinDeepArticleWorkflow
  extends WorkflowEntrypoint<WeixinDeepWorkflowEnv, WeixinDeepWorkflowParams> {
  private scraper: Map<string, ContentScraper>;
  private publisher: WeixinPublisher;
  private notifier: BarkNotifier;
  private renderer: WeixinArticleTemplateRenderer;
  private runner: DeepArticleRunnerLike;
  private topicClusterer: Pick<TopicClusterer, "cluster">;
  private authorContextLoader: typeof loadAuthorContext;
  private stats = { success: 0, failed: 0, materials: 0 };

  constructor(
    env: WorkflowEnv<WeixinDeepWorkflowEnv>,
    deps: WeixinDeepWorkflowDeps = {},
  ) {
    super(env);
    this.scraper = deps.scrapers ?? buildDeepArticleScrapers();
    this.publisher = deps.publisher ?? new WeixinPublisher();
    this.notifier = deps.notifier ?? new BarkNotifier();
    this.renderer = deps.renderer ?? new WeixinArticleTemplateRenderer();
    this.runner = deps.runner ?? new DeepArticleStepRunner();
    this.topicClusterer = deps.topicClusterer ??
      new TopicClusterer(this.runner);
    this.authorContextLoader = deps.authorContextLoader ?? loadAuthorContext;
  }

  public async refresh(): Promise<void> {
    await this.publisher.refresh();
  }

  async run(
    event: WorkflowEvent<WeixinDeepWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const payload = event.payload ?? {};
    let runDir = "";
    const artifacts: DeepArticleArtifact[] = [];
    let artifactsFlushed = false;
    // 只落一次：终止分支已经落过盘时，catch 里的补偿落盘不该再写一遍。
    // 声明在 try 之外，因为 catch 也要用它。
    const flushArtifactsOnce = async (): Promise<string> => {
      if (artifactsFlushed || !runDir) return runDir;
      const dir = await this.flushArtifacts(runDir, artifacts);
      artifactsFlushed = true;
      return dir;
    };
    try {
      logger.info(
        `[深度文] 开始执行，实例ID: ${this.env.id} 事件ID: ${event.id}`,
      );
      await this.notifier.info("深度文开始", "抓取素材 → 提炼主题包 → 成稿");

      const includeKeywords = toStringArray(payload.includeKeywords);
      const excludeKeywords = toStringArray(payload.excludeKeywords);
      // 补料预算：抓几个链接、每条抓回来留多少字。抓太多会把证据表的提示词撑爆。
      const gapFetchLimit = await readDeepConfigInt(
        "DEEP_ARTICLE_GAP_FETCH_LIMIT",
        3,
      );
      const gapFetchChars = await readDeepConfigInt(
        "DEEP_ARTICLE_GAP_FETCH_CHARS",
        3000,
      );

      // 1. 抓取素材（复用与文章工作流相同的数据源与回退策略）
      // 采集过程整体留档：主题包与正文都建立在这批素材上，「拿什么素材在做判断」
      // 必须可查，否则事后无法判断到底是素材不行还是判断不行。
      const collect = await step.do("collect-materials", {
        retries: { limit: 2, delay: "10 second", backoff: "exponential" },
        timeout: "15 minutes",
      }, async () =>
        await collectDeepArticleMaterials({
          sourceType: payload.sourceType,
          includeKeywords,
          excludeKeywords,
          maxMaterials: payload.maxMaterials,
        }, {
          scrapers: this.scraper,
          notifier: this.notifier,
          logger,
        }));

      const materials = collect.materials;
      if (materials.length === 0) {
        throw new WorkflowTerminateError(
          `未获取到任何素材，流程终止（抓到 ${collect.raw.length} 条，去重后 ${collect.deduped.length} 条，排除词筛掉 ${collect.excluded.length} 条）`,
        );
      }

      const runDirName = buildDeepArticleRunDirName(
        new Date(),
        includeKeywords[0] ?? "mixed",
      );
      runDir = resolveDeepArticleRunDir(Deno.cwd(), runDirName);

      // 2. 主题包提炼 + 爆款评分
      const cluster = await step.do("cluster-topics", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "12 minutes",
      }, async () => this.topicClusterer.cluster(materials));

      artifacts.push({
        name: "00-素材清单.md",
        body: renderCollectOutcome(collect),
      });
      artifacts.push({
        name: "01-主题包清单.md",
        body: this.renderTopicPackages(cluster, materials),
      });

      if (!cluster.selected) {
        const allEliminated = cluster.packages.length > 0;
        artifacts.push({
          name: "99-终止原因.md",
          body: allEliminated
            ? "全部主题包命中硬淘汰，按 skill 的 topic-package.md 不进入创作。\n\n" +
              cluster.packages.map((item) =>
                `- ${item.name}：${item.eliminated}`
              ).join("\n")
            : "模型没有返回任何主题包。",
        });
        const written = await flushArtifactsOnce();
        throw new WorkflowTerminateError(
          allEliminated
            ? `全部 ${cluster.packages.length} 个主题包命中硬淘汰，无可创作主题（已在 ${written} 留档）`
            : `主题包提炼没有结果（已在 ${written} 留档）`,
        );
      }

      const selected = cluster.selected;
      const selectedMaterialIds = new Set(selected.materialIds);
      const selectedMaterials = materials.filter((content) =>
        selectedMaterialIds.has(String(content.id))
      );
      const existingFetchablePages = selectedMaterials
        .filter((content) =>
          isFetchableCandidateLink(content.url) &&
          (content.content ?? "").trim().length > 0
        )
        .map((content) => String(content.url));
      logger.info(
        `[深度文] 选中主题：${selected.name}（总分 ${selected.total}，领域 ${
          selected.lane || selected.laneRaw || "待路由"
        }，素材 ${selected.materialIds.length} 条）`,
      );
      if (selected.laneUnverified) {
        logger.info(
          `[深度文] 主题包自评领域「${selected.laneRaw}」不是五个标准领域之一，交由领域路由裁决`,
        );
      }
      if (cluster.droppedByBudget > 0) {
        logger.info(
          `[深度文] 因长度预算未送入模型的素材：${cluster.droppedByBudget} 条`,
        );
      }
      if (cluster.unassigned.length > 0) {
        logger.info(
          `[深度文] 未被任何主题包覆盖的素材：${cluster.unassigned.length} 条（${
            cluster.unassigned.slice(0, 5).join(", ")
          }）`,
        );
      }

      // 3. 作者背景（先脱敏，再注入）
      const authorContext = await step.do(
        "load-author-context",
        {
          timeout: "3 minutes",
        },
        async () =>
          payload.useAuthorContext === false
            ? this.emptyAuthorContext("本次显式关闭作者背景")
            : await this.authorContextLoader({}, logger),
      );

      artifacts.push({
        name: "02-作者背景.md",
        body: this.renderAuthorContext(authorContext),
      });

      // 4. 领域路由（五选一）
      const laneCard = await step.do("lane-routing", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "8 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "lane-routing",
          payload: this.renderTopicForRouting(selected, materials),
          temperature: 0.2,
        });
        return asRecord(result.data);
      });

      const lane = payload.lane?.trim() ||
        pickString(laneCard, "primaryLane");
      if (!lane) {
        artifacts.push({
          name: "99-终止原因.md",
          body: `领域路由失败：五领域都不匹配。\n\n${
            JSON.stringify(laneCard, null, 2)
          }`,
        });
        const written = await flushArtifactsOnce();
        throw new WorkflowTerminateError(
          `主题「${selected.name}」不落在五个领域内，按 skill 规则不出稿（已在 ${written} 留档）`,
        );
      }
      this.checkCard(laneCard, "领域判断卡", false);
      artifacts.push({
        name: "03-领域判断卡.md",
        body: renderRecordMarkdown("领域判断卡", laneCard),
      });

      // 5. 素材缺口判断与补料（skill 第 5 步）
      // 链接只由代码从真实素材挑；先直接抓候选页，再让模型同时看原素材与抓回正文，
      // 判断来源资格和材料充分度。模型给出的 URL 只落盘审计，永不用于发起请求。
      const gap = await step.do("material-gap", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "12 minutes",
      }, async () => {
        const picked = pickSupplementLinks(
          selectedMaterials.map((content) => ({
            url: content.url,
            content: content.content,
          })),
          {
            limit: gapFetchLimit,
            // 有正文的页面已经抓过，不重复；空正文页面必须允许重新补抓。
            exclude: selectedMaterials
              .filter((content) => (content.content ?? "").trim().length > 0)
              .map((content) => content.url)
              .filter(Boolean),
          },
        );

        const supplements: ScrapedContent[] = [];
        const fetchLog: Array<{
          url: string;
          ok: boolean;
          count: number;
          error?: string;
        }> = [];
        const fireCrawl = this.scraper.get("fireCrawl");
        if (picked.length > 0 && !fireCrawl?.scrapePage) {
          for (const url of picked) {
            fetchLog.push({
              url,
              ok: false,
              count: 0,
              error: fireCrawl
                ? "FireCrawl 采集器不支持直接页面抓取"
                : "缺少 FireCrawl 采集器",
            });
          }
        }
        if (fireCrawl?.scrapePage) {
          const scrapePage = fireCrawl.scrapePage.bind(fireCrawl);
          for (const url of picked) {
            try {
              const page = await scrapePage(url);
              const trimmed = (page ? [page] : [])
                .filter((item) => (item.content ?? "").trim().length > 0)
                .slice(0, 1)
                .map((item) => ({
                  ...item,
                  id: `supplement:${url}`,
                  url: item.url || url,
                  content: (item.content ?? "").slice(0, gapFetchChars),
                  metadata: {
                    ...item.metadata,
                    platform: "supplement-candidate",
                    sourceUrl: url,
                  },
                }));
              supplements.push(...trimmed);
              fetchLog.push({
                url,
                ok: trimmed.length > 0,
                count: trimmed.length,
              });
            } catch (error) {
              const message = error instanceof Error
                ? error.message
                : String(error);
              fetchLog.push({ url, ok: false, count: 0, error: message });
              logger.warn(`[深度文][补料] ${url} 抓取失败：${message}`);
            }
          }
        }

        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "material-gap",
          lane,
          payload: [
            this.renderTopicBrief(selected, materials, { fullText: true }),
            this.renderSupplementBrief(supplements),
            fetchLog.length > 0
              ? `【代码抓取结果】\n${
                fetchLog.map((entry) =>
                  `- ${entry.ok ? "成功" : "失败"}｜${entry.url}${
                    entry.error ? `｜${entry.error}` : ""
                  }`
                ).join("\n")
              }`
              : "【代码抓取结果】未发现需要补抓的链接。",
          ].join("\n\n"),
          temperature: 0.3,
        });
        return {
          card: asRecord(result.data),
          picked,
          supplements,
          fetchLog,
        };
      });

      const gapCard = gap.card;
      this.checkCard(gapCard, "素材缺口与补料卡", false);
      const candidateSupplements = gap.supplements;
      const availableSourceUrls = [
        ...existingFetchablePages,
        ...candidateSupplements.flatMap((item) => [
          item.url,
          toText(item.metadata?.sourceUrl),
        ]),
      ].filter(Boolean);
      const qualifiedSourceUrls = this.qualifiedSourceUrls(
        gapCard,
        availableSourceUrls,
      );
      const qualifiedSet = new Set(
        qualifiedSourceUrls.map((url) => normalizeSourceUrl(url)),
      );
      const supplements = candidateSupplements.filter((item) =>
        [item.url, toText(item.metadata?.sourceUrl)]
          .filter(Boolean)
          .some((url) => qualifiedSet.has(normalizeSourceUrl(url)))
      );

      artifacts.push({
        name: "04-素材缺口与补料.md",
        body: this.renderMaterialGap(
          gapCard,
          gap.picked,
          gap.fetchLog,
          candidateSupplements,
          existingFetchablePages,
          qualifiedSourceUrls,
        ),
      });

      const gapSufficiency = pickString(gapCard, "sufficiency").trim();
      const gateFailures: string[] = [];
      if (qualifiedSourceUrls.length === 0) {
        gateFailures.push("没有经素材缺口卡确认的一手来源");
      }
      if (!gapSufficiency || gapSufficiency === "不足") {
        gateFailures.push(`材料充分度为「${gapSufficiency || "未给出"}」`);
      }
      if (
        selectedMaterials.length < 2 &&
        gapSufficiency !== "充足"
      ) {
        gateFailures.push("单素材主题的材料充分度不是「充足」");
      }

      if (gateFailures.length > 0) {
        artifacts.push({
          name: "99-终止原因.md",
          body: [
            "素材地基不足，提前终止。",
            "",
            `- 选中主题关联素材：${selectedMaterials.length} 条`,
            `- 已有可抓取页面：${existingFetchablePages.length} 个`,
            `- 补料候选链接：${gap.picked.length} 个`,
            `- 抓到候选补料：${candidateSupplements.length} 条`,
            `- 经模型确认的一手来源：${qualifiedSourceUrls.length} 个`,
            `- 素材缺口充分度：${gapSufficiency || "未给出"}`,
            "",
            "未通过项：",
            ...gateFailures.map((reason) => `- ${reason}`),
            "",
            "可抓取只代表页面能读取；未确认来源资格与充分度的材料不能进入证据链。",
          ].join("\n"),
        });
        const written = await flushArtifactsOnce();
        throw new WorkflowTerminateError(
          `素材资格不足：${gateFailures.join("；")}（已在 ${written} 留档）`,
        );
      }

      // 6. 证据分层与事实锁定
      const evidence = await step.do("evidence-lock", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "10 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "evidence-lock",
          payload: [
            this.renderTopicBrief(selected, materials, { fullText: true }),
            renderRecordMarkdown("素材缺口与来源资格", gapCard),
            this.renderSupplementBrief(supplements, { qualified: true }),
          ].filter(Boolean).join("\n\n"),
          temperature: 0.2,
        });
        return asRecord(result.data);
      });
      this.checkCard(evidence, "证据与事实锁定表", true);
      artifacts.push({
        name: "05-证据与事实锁定.md",
        body: renderRecordMarkdown("证据分层与原意事实锁定表", evidence),
      });

      // 7. 作者立场与观察者位卡（skill 顺序：证据分层之后）
      const stance = await step.do("author-stance", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "10 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "author-stance",
          lane,
          payload: [
            this.renderTopicBrief(selected, materials),
            this.renderSupplementBrief(supplements, { qualified: true }),
            this.renderEvidenceBrief(evidence),
            authorContext.available
              ? `【作者背景（已脱敏，只作理解用途）】\n${authorContext.summary}`
              : "【作者背景】本次没有可用的作者语料，作者性只依赖认知路径与取材位置。",
          ].join("\n\n"),
          temperature: 0.4,
        });
        return asRecord(result.data);
      });
      this.checkCard(stance, "作者立场卡", false);
      artifacts.push({
        name: "06-作者立场卡.md",
        body: renderRecordMarkdown("作者立场与观察者位卡", stance),
      });

      // 8. 张力、核心机制与可争论判断
      const thesis = await step.do("thesis", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "10 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "thesis",
          lane,
          payload: [
            this.renderTopicBrief(selected, materials),
            this.renderEvidenceBrief(evidence),
            this.renderStanceBrief(stance),
          ].join("\n\n"),
          temperature: 0.6,
        });
        return asRecord(result.data);
      });
      this.checkCard(thesis, "立论与核心机制", true);
      artifacts.push({
        name: "07-立论与反方.md",
        body: renderRecordMarkdown("张力、核心机制与可争论判断", thesis),
      });

      // 9. 文章原型与写作技术卡
      const craft = await step.do("archetype-craft", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "12 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "archetype-craft",
          lane,
          payload: [
            this.renderTopicBrief(selected, materials),
            this.renderEvidenceBrief(evidence),
            this.renderStanceBrief(stance),
            renderRecordMarkdown("立论与反方", thesis),
          ].join("\n\n"),
          temperature: 0.4,
        });
        return asRecord(result.data);
      });
      this.checkCard(craft, "写作技术卡", false);
      artifacts.push({
        name: "08-写作技术卡.md",
        body: renderRecordMarkdown("文章原型与写作技术卡", craft),
      });

      const bundle: ResearchBundle = {
        package: selected,
        materials,
        supplements,
        authorContext,
        lane,
        laneCard,
        materialGap: gapCard,
        stance,
        evidence,
        thesis,
        craft,
      };

      // 10. 起草正文
      const draft = await step.do("draft", {
        retries: { limit: 2, delay: "10 second", backoff: "exponential" },
        timeout: "20 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "draft",
          lane,
          useDraftProvider: true,
          payload: this.renderResearchBundle(bundle),
          temperature: 0.8,
        });
        return asRecord(result.data);
      });

      const draftContent = normalizeParagraphMarkers(
        pickString(draft, "content"),
      );
      if (!draftContent) {
        artifacts.push({
          name: "99-终止原因.md",
          body: "起草步骤没有返回正文。",
        });
        const written = await this.flushArtifacts(runDir, artifacts);
        throw new WorkflowTerminateError(
          `起草失败，未返回正文（已在 ${written} 留档）`,
        );
      }
      artifacts.push({
        name: "09-初稿.md",
        body: [
          `# ${pickString(draft, "title")}`,
          pickString(draft, "subtitle")
            ? `\n> ${pickString(draft, "subtitle")}`
            : "",
          "",
          contentToMarkdown(draftContent),
        ].join("\n"),
      });

      // 11. 事实回查
      const recheck = await step.do("fact-recheck", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "12 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "fact-recheck",
          payload: [
            renderRecordMarkdown("证据与事实锁定表", evidence),
            `【待回查正文】\n${draftContent}`,
          ].join("\n\n"),
          temperature: 0.2,
        });
        return asRecord(result.data);
      });

      let currentContent =
        normalizeParagraphMarkers(pickString(recheck, "content")) ||
        draftContent;
      let currentTitles = toStringArray(draft.titles);
      artifacts.push({
        name: "10-事实回查.md",
        body: [
          renderRecordMarkdown("回查问题", asArray(recheck.issues)),
          "",
          `改动的事实：${
            toStringArray(recheck.changedFacts).join("；") || "无"
          }`,
          "",
          contentToMarkdown(currentContent),
        ].join("\n"),
      });

      // 12. 三轮审稿 + 量表打分
      const reviewPayloadBase = () =>
        [
          this.renderResearchBundle(bundle),
          `【待审正文】\n${currentContent}`,
          `【候选标题】\n${currentTitles.join("\n")}`,
        ].join("\n\n");

      const review1 = await step.do("review-1", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "12 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "review-1",
          payload: reviewPayloadBase(),
          temperature: 0.1,
        });
        return asRecord(result.data);
      });
      artifacts.push({
        name: "11-审稿-第一轮.md",
        body: renderRecordMarkdown("第一轮：任务、材料与证据", review1),
      });

      const review2 = await step.do("review-2", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "12 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "review-2",
          lane,
          payload: reviewPayloadBase(),
          temperature: 0.1,
        });
        return asRecord(result.data);
      });
      artifacts.push({
        name: "12-审稿-第二轮.md",
        body: renderRecordMarkdown("第二轮：观点、机制与作者性", review2),
      });

      const review3 = await step.do("review-3", {
        retries: { limit: 2, delay: "5 second", backoff: "exponential" },
        timeout: "20 minutes",
      }, async () => {
        const result = await this.runner.runJson<Record<string, unknown>>({
          stepKey: "review-3",
          payload: reviewPayloadBase(),
          temperature: 0.3,
        });
        return asRecord(result.data);
      });

      const revisedContent = pickString(review3, "content");
      if (revisedContent) {
        currentContent = normalizeParagraphMarkers(revisedContent);
      }
      const revisedTitles = toStringArray(review3.titles);
      if (revisedTitles.length > 0) currentTitles = revisedTitles;

      artifacts.push({
        name: "13-审稿-第三轮.md",
        body: [
          renderRecordMarkdown("第三轮：语言、节奏与发布完整性", review3),
          "",
          `压缩比例：${
            review3.compressionRate === undefined
              ? "未提供"
              : review3.compressionRate
          }`,
        ].join("\n"),
      });

      // 13. 量表打分与闸门
      const hardGate = collectHardGateFailures([review1, review2, review3]);
      const score = hardGate.hardGateFailed
        ? undefined
        : await step.do("review-score", {
          retries: { limit: 2, delay: "5 second", backoff: "exponential" },
          timeout: "12 minutes",
        }, async () => {
          const result = await this.runner.runJson<Record<string, unknown>>({
            stepKey: "review-score",
            payload: [
              renderRecordMarkdown("第一轮审稿", review1),
              renderRecordMarkdown("第二轮审稿", review2),
              renderRecordMarkdown("第三轮审稿", review3),
              `【待评正文】\n${currentContent}`,
            ].join("\n\n"),
            temperature: 0.1,
          });
          return asRecord(result.data);
        });

      const gate: GateResult = evaluateGate({
        hardGateFailed: hardGate.hardGateFailed,
        returnStage: hardGate.returnStage,
        dimensions: (score?.dimensions ?? {}) as Record<string, unknown>,
      });
      artifacts.push({
        name: "14-审稿闸门.md",
        body: [
          formatGateReport(gate),
          "",
          score
            ? renderRecordMarkdown("量表说明", {
              twoStrongest: score.twoStrongest,
              twoRisks: score.twoRisks,
              publishJudgement: score.publishJudgement,
              notes: score.notes,
            })
            : "（触发硬门槛，未进入打分）",
        ].join("\n"),
      });

      // 14. 隐私后检：代码层 + 模型层。
      // 模型层必须与正文对账后才算数：模型会报出不存在的命中，照单全收会让闸门
      // 因假阳性失去可信度；而对账后的真命中一定要拦（代码层故意收窄了机构名识别，
      // 「在某某公司做项目」这类写法只有模型层能抳住）。
      const llmPrivacyAll = asArray(review3.privacyHits);
      const llmPrivacy = reconcileLlmPrivacyHits(
        llmPrivacyAll,
        joinForPrivacyScan(currentContent, currentTitles),
      );
      const llmPrivacyIgnored = llmPrivacyAll.length - llmPrivacy.length;
      const privacy = await step.do(
        "privacy-check",
        async () =>
          await checkContentPrivacy(
            joinForPrivacyScan(currentContent, currentTitles),
            logger,
          ),
      );

      artifacts.push({
        name: "15-隐私后检.md",
        body: [
          `- 代码层结论：${privacy.passed ? "通过" : "拦截"}`,
          `- 命中拦截项：${privacy.blocking.length}`,
          `- 命中提醒项：${privacy.warnings.length}`,
          `- 名单来源：${privacy.termSource}（${privacy.terms.length} 个词）`,
          `- 模型层：报 ${llmPrivacyAll.length} 项，与正文对账后成立 ${llmPrivacy.length} 项，忽略 ${llmPrivacyIgnored} 项（正文里找不到命中文本）`,
          `- 合计参与发布判定：${
            privacy.blocking.length + llmPrivacy.length
          } 项`,
          "",
          "## 代码层命中",
          "",
          privacy.formatted || "（无）",
          "",
          "## 模型层命中（与正文对账后）",
          "",
          llmPrivacy.length > 0
            ? llmPrivacy.map((item) => `- ${item.category}：${item.text}`).join(
              "\n",
            )
            : "（无）",
        ].join("\n"),
      });

      // 15. 渲染 + 归档
      const summaryTitle = pickString(draft, "title") || selected.name;
      const subtitle = pickString(draft, "subtitle");

      const renderedTemplate = await step.do("render-article", {
        timeout: "8 minutes",
      }, async () =>
        await this.renderArticle(
          currentContent,
          summaryTitle,
          subtitle,
          selected,
          payload.templateType,
        ));

      artifacts.push({
        name: "16-成稿.md",
        body: [
          `# ${summaryTitle}`,
          subtitle ? `\n> ${subtitle}` : "",
          "",
          contentToMarkdown(currentContent),
          "",
          "## 候选标题",
          "",
          currentTitles.map((title) => `- ${title}`).join("\n") || "（无）",
        ].join("\n"),
      });
      artifacts.push({
        name: "README.md",
        body: this.renderRunIndex({
          runDirName,
          selected,
          cluster,
          bundle,
          gate,
          privacyPassed: privacy.passed,
          materialCount: materials.length,
        }),
      });

      const finalRunDir = await flushArtifactsOnce();

      // 未接入 draftWriter（例如定时任务触发）时，把成稿 HTML 写进留档目录，
      // 否则这条路径只能留下一堆 markdown，看不到实际排版。
      if (!this.env.env.draftWriter) {
        await step.do("archive-html-fallback", async () => {
          const written = await writeDeepArticleArtifacts(finalRunDir, [{
            name: "16-草稿.html",
            body: renderedTemplate,
          }]);
          logger.info(
            `[深度文][留档] 未接入 draftWriter，成稿 HTML 已落到 ${
              written.written.join(", ") || "(失败)"
            }`,
          );
        });
      }

      const archivedDraftId = await archiveDraft(
        this.env.env,
        {
          title: summaryTitle,
          html: renderedTemplate,
          workflowType: "weixin-deep-article",
        },
        logger,
      );

      // 16. 发布判断：三重条件，任一不满足都不发
      const publishMode = payload.publishMode;
      const wantPublish = publishMode === "draft"
        ? false
        : payload.forcePublish
        ? true
        : (payload.publish ?? false);

      const blockingReasons: string[] = [];
      if (!gate.machinePass) {
        blockingReasons.push(
          gate.scored
            ? `量表未达标：${gate.reasons.join("；")}`
            : `硬门槛失败：${gate.hardGateFailed}`,
        );
      }
      if (!privacy.passed) {
        blockingReasons.push(`隐私后检拦截 ${privacy.blocking.length} 处`);
      }
      if (llmPrivacy.length > 0) {
        blockingReasons.push(
          `模型层隐私命中 ${llmPrivacy.length} 处（已与正文对账）：${
            llmPrivacy.slice(0, 3).map((item) =>
              `${item.category}「${item.text.slice(0, 20)}」`
            ).join("、")
          }`,
        );
      }

      const summary = [
        "深度文工作流执行完成",
        `- 素材：${materials.length} 条（送入主题包 ${
          materials.length - cluster.droppedByBudget
        } 条）`,
        `- 主题包：${cluster.packages.length} 个，入选「${selected.name}」（${selected.total} 分）`,
        `- 领域：${lane}`,
        `- 状态：${gate.status}（总分 ${gate.total}/${gate.totalMax}）`,
        `- 隐私：${
          privacy.passed ? "通过" : `拦截 ${privacy.blocking.length} 处`
        }`,
        `- 留档：${finalRunDir}`,
      ].join("\n");

      if (wantPublish && blockingReasons.length === 0) {
        // 封面只在真要发时生成：图片生成走第三方额度，稿子可能被丢弃，
        // 不应为一份待确认的草稿先烧一次额度。
        const mediaId = await step.do("generate-cover", {
          timeout: "5 minutes",
        }, async () => {
          const cover = await resolveCover({
            label: "deep-article:generate-cover",
            upload: (source) => this.publisher.uploadThumb(source),
            placeholder: { width: 1200, height: 400 },
            generate: async () => {
              const generator = await ImageGeneratorFactory.getInstance()
                .getGenerator("ALIWANX_POSTER");
              return await generator.generate({
                title: summaryTitle.slice(0, 30),
                sub_title: new Date().toLocaleDateString() + " 深度解读",
                prompt_text_zh: `深度解读 | ${selected.name} | 科技与产业观察`,
                generate_mode: "generate",
                generate_num: 1,
              }) as string;
            },
          });
          return cover.mediaId;
        });

        // 不重试：publish() 用返回值报错、不抛异常，所以能走到重试的只有网络/超时，
        // 而那时请求可能已经落地，重试会造成重复推送（公众号群发有次数限制）。
        const publishResult = await step.do("publish-article", {
          retries: { limit: 0, delay: "1 second", backoff: "linear" },
          timeout: "5 minutes",
        }, async () => {
          logger.info("[深度文] 发布到微信公众号");
          return await this.publisher.publish(renderedTemplate, {
            title: summaryTitle,
            thumbMediaId: mediaId,
          });
        });

        const failure = readPublishFailure(publishResult);
        if (failure) {
          throw new WorkflowTerminateError(
            `发布失败（内容已归档到本地草稿箱，留档在 ${finalRunDir}）：${failure}`,
          );
        }
        await markArchivedDraftPublished(
          this.env.env,
          archivedDraftId,
          logger,
        );
        await this.notifier.success("深度文完成", `${summary}\n- 发布: 成功`);
        return;
      }

      // 到此为止都不发：把原因明确说清，而不是静默跳过
      const skipReason = wantPublish
        ? `不发布：${blockingReasons.join("；")}`
        : "不发布：深度文默认只出稿归档，需作者本人阅读后决定";
      logger.info(`[深度文] ${skipReason}`);
      await this.notifier.warning(
        "深度文出稿待确认",
        `${summary}\n- ${skipReason}\n- 发布状态：${gate.publishStatus}`,
      );

      if (wantPublish && blockingReasons.length > 0) {
        throw new WorkflowTerminateError(
          `请求发布但未通过校验：${
            blockingReasons.join("；")
          }（留档在 ${finalRunDir}）`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 未落盘过就补一次：LLM 在第 7 步挂掉时，前 6 张卡不该跟着丢。
      // 落盘失败不能覆盖真正的错误，所以这里只记日志。
      if (!artifactsFlushed && runDir && artifacts.length > 0) {
        try {
          await flushArtifactsOnce();
        } catch (flushError) {
          logger.error(
            `[深度文][留档] 异常路径补落盘失败：${
              flushError instanceof Error ? flushError.message : "未知错误"
            }`,
          );
        }
      }
      if (error instanceof WorkflowTerminateError) {
        await this.notifier.warning("深度文终止", message);
        throw error;
      }
      logger.error("[深度文] 执行失败:", message);
      await this.notifier.error("深度文失败", message);
      throw error;
    }
  }

  // ---------- 提示词装配 ----------

  private renderTopicForRouting(
    selected: TopicPackage,
    materials: ScrapedContent[],
  ): string {
    return [
      this.renderTopicBrief(selected, materials),
      selected.laneUnverified
        ? `【主题包自评领域】${selected.laneRaw}（模型自创名，不在五个标准领域内：请裁决到最接近的一个；若五个都不匹配，primaryLane 返回空字符串并说明理由）`
        : `【主题包自评领域】${selected.lane}`,
      `【自评理由】${selected.laneReason}`,
    ].join("\n\n");
  }

  private renderTopicBrief(
    selected: TopicPackage,
    materials: ScrapedContent[],
    options: { fullText?: boolean; now?: Date } = {},
  ): string {
    const previewChars = options.fullText
      ? Number.POSITIVE_INFINITY
      : MATERIAL_PREVIEW_CHARS;
    const now = options.now ?? new Date();
    const byId = new Map(materials.map((item) => [String(item.id), item]));
    const materialBlocks = selected.materialIds.slice(0, 12).map((id) => {
      const content = byId.get(id);
      if (!content) return `素材ID: ${id}（正文未命中，仅保留 ID）`;
      const age = ageInDays(content.publishDate, now);
      return [
        `素材ID: ${id}`,
        `标题: ${content.title ?? ""}`,
        `发布时间: ${content.publishDate ?? ""}${
          age === null ? "（未能解析，时效未知）" : `（距当前 ${age} 天）`
        }`,
        `素材URL: ${content.url ?? ""}`,
        `正文节选:`,
        (content.content ?? "").slice(0, previewChars),
      ].join("\n");
    });

    return [
      // 时间基准必须由代码给：模型凭空推测“今天”会导致把已发布的素材当成未来数据，
      // 进而误判一手/二手与可用性（真跑已经踩到）。
      `【当前日期】${
        localDateLabel(now)
      }（代码生成，时效判断只能以此为“今天”）`,
      "【选定主题包】",
      renderRecordMarkdown("主题包字段", {
        name: selected.name,
        primarySources: selected.primarySources,
        supplementEntryLinks: selected.supplementEntryLinks,
        coreFacts: selected.coreFacts,
        widelyRepeated: selected.widelyRepeated,
        omittedConditions: selected.omittedConditions,
        controversy: selected.controversy,
        lane: selected.lane || selected.laneRaw || "未标注",
        laneReason: selected.laneReason,
        authorEntry: selected.authorEntry,
        gaps: selected.gaps,
        scores: selected.scores,
        total: selected.total,
      }),
      "【本主题包关联素材】",
      materialBlocks.join("\n---\n"),
    ].join("\n\n");
  }

  /**
   * 把模型的来源资格判断与代码真实抓到/已有的 URL 对账。
   * 模型自造 URL、二手/未知来源、usableAsEvidence 非 true，一律不放行。
   */
  private qualifiedSourceUrls(
    card: Record<string, unknown>,
    availableUrls: string[],
  ): string[] {
    const allowed = new Map<string, string>();
    for (const url of availableUrls) {
      const normalized = normalizeSourceUrl(url);
      if (normalized) allowed.set(normalized, url);
    }

    const qualified = new Set<string>();
    for (const item of asArray(card.sourceAssessment)) {
      const row = asRecord(item);
      if (pickString(row, "sourceType") !== "一手") continue;
      if (row.usableAsEvidence !== true) continue;
      const actual = allowed.get(normalizeSourceUrl(row.url));
      if (actual) qualified.add(actual);
    }
    return [...qualified];
  }

  /** 补料卡：缺口、抓了哪些链接、抓到什么、以及模型给的候选链接（未采信）。 */
  private renderMaterialGap(
    card: Record<string, unknown>,
    picked: string[],
    fetchLog: Array<
      { url: string; ok: boolean; count: number; error?: string }
    >,
    supplements: ScrapedContent[],
    existingFetchablePages: string[],
    qualifiedSourceUrls: string[],
  ): string {
    const lines = [
      renderRecordMarkdown("素材缺口与充分度", card),
      "",
      `## 选中主题已有可抓取页面（${existingFetchablePages.length} 个）`,
      "",
      "> 「可抓取」只代表代码能读取页面，不自动等于一手来源；是否足够由上面的素材缺口卡判断。",
      "",
      existingFetchablePages.length > 0
        ? existingFetchablePages.map((url) => `- ${url}`).join("\n")
        : "（无；若主题只有一条社交素材，就必须靠下面的补料成功后才能继续）",
      "",
      "## 代码挑出并抓取的链接",
      "",
      "> 链接由代码从素材正文里挑（排除社交平台与静态资源），不采用模型给的候选 URL：",
      "> 模型给的地址可能是幻觉，抓不存在的地址既浪费请求，也可能把错内容灌进证据表。",
      "",
      picked.length > 0
        ? picked.map((url) => `- ${url}`).join("\n")
        : "（素材里没有可抓取的补料链接）",
      "",
      "### 抓取结果",
      "",
      fetchLog.length > 0
        ? fetchLog
          .map((entry) =>
            `- ${entry.ok ? "✓" : "✗"} ${entry.url}｜${entry.count} 条${
              entry.error ? `｜${entry.error}` : ""
            }`
          )
          .join("\n")
        : "（未发起抓取）",
      "",
      `## 抓到的候选补料（${supplements.length} 条，尚未自动视为一手）`,
      ,
      "",
      supplements.length > 0
        ? supplements.map((item, index) =>
          `### ${index + 1}. ${item.title || "（无标题）"}

- 链接：${item.url}
- 正文长度：${(item.content ?? "").length} 字

\`\`\`text
${(item.content ?? "").trim()}
\`\`\`
`
        ).join("\n")
        : "（无）",
      "",
      `## 经素材缺口卡确认可进入证据链的一手 URL（${qualifiedSourceUrls.length} 个）`,
      "",
      qualifiedSourceUrls.length > 0
        ? qualifiedSourceUrls.map((url) => `- ${url}`).join("\n")
        : "（无）",
    ];
    if (card.linkCandidates !== undefined) {
      lines.push(
        "",
        "## 模型给出的候选链接（仅记录，未采信）",
        "",
        renderRecordMarkdown("linkCandidates", card.linkCandidates),
      );
    }
    return lines.join("\n");
  }

  /** 补料摘要；qualified=false 时只供 material-gap 判断，不得当证据。 */
  private renderSupplementBrief(
    supplements: ScrapedContent[],
    options: { qualified?: boolean } = {},
  ): string {
    const qualified = options.qualified === true;
    if (supplements.length === 0) {
      return qualified
        ? "【已确认可进入证据链的补料】无"
        : "【代码抓到的候选补料】无（来源资格尚未判断）";
    }
    return [
      qualified
        ? `【已确认可进入证据链的补料（${supplements.length} 条）】`
        : `【代码抓到的候选补料（${supplements.length} 条，来源资格尚未判断）】`,
      supplements
        .map((item, index) =>
          [
            `材料 ${index + 1}｜${item.title || "（无标题）"}`,
            `请求URL：${toText(item.metadata?.sourceUrl) || item.url}`,
            `落地URL：${item.url}`,
            `正文：`,
            (item.content ?? "").trim(),
          ].join("\n")
        )
        .join("\n---\n"),
    ].join("\n");
  }

  private renderEvidenceBrief(evidence: Record<string, unknown>): string {
    return renderRecordMarkdown("证据与事实锁定表", evidence);
  }

  private renderStanceBrief(stance: Record<string, unknown>): string {
    return renderRecordMarkdown("作者立场与观察者位卡", stance);
  }

  /** 起草与审稿用：把研究包按 skill 要求的顺序拼成一份输入 */
  private renderResearchBundle(bundle: ResearchBundle): string {
    const parts = [
      this.renderTopicBrief(bundle.package, bundle.materials),
      renderRecordMarkdown("素材缺口与来源资格", bundle.materialGap),
      renderRecordMarkdown("领域判断卡", bundle.laneCard),
      renderRecordMarkdown("作者立场与观察者位卡", bundle.stance),
      renderRecordMarkdown("证据与事实锁定表", bundle.evidence),
      this.renderSupplementBrief(bundle.supplements, { qualified: true }),
      renderRecordMarkdown("张力、核心机制与可争论判断", bundle.thesis),
      renderRecordMarkdown("文章原型与写作技术卡", bundle.craft),
      `【本篇主领域】${bundle.lane}`,
    ];
    if (bundle.authorContext.available) {
      parts.push(
        `【作者背景（已脱敏，只作理解用途；其中的人名、单位、事件一律不得进入文章；` +
          `「作者认知与原则」几节只用于让文章从作者的角度判断，不是可以直接引用的发言）】\n${bundle.authorContext.summary}`,
      );
    }
    return parts.join("\n\n");
  }

  // ---------- 渲染与落盘 ----------

  private async renderArticle(
    content: string,
    title: string,
    subtitle: string,
    selected: TopicPackage,
    templateType?: string,
  ): Promise<string> {
    const templateData: WeixinTemplate[] = [{
      id: "deep-article",
      title,
      subtitle: subtitle || undefined,
      content,
      url: "",
      publishDate: new Date().toLocaleDateString("zh-CN"),
      metadata: {
        score: selected.total,
        keywords: selected.coreFacts.slice(0, 6),
        wordCount: content.replace(/<next_paragraph \/>/g, "").length,
        readTime: Math.max(
          1,
          Math.ceil(content.replace(/<next_paragraph \/>/g, "").length / 275),
        ),
      },
      keywords: selected.coreFacts.slice(0, 6),
    }];

    const template = templateType?.trim() || DEFAULT_DEEP_TEMPLATE;
    return await this.renderer.render(templateData, template);
  }

  private renderTopicPackages(
    cluster: TopicClusterResult,
    materials: ScrapedContent[],
  ): string {
    const lines = [
      "# 主题包清单",
      "",
      `- 素材总数：${materials.length}`,
      `- 因长度预算未送入模型：${cluster.droppedByBudget} 条`,
      `- 未被任何主题包覆盖：${cluster.unassigned.length} 条${
        cluster.unassigned.length > 0
          ? `（${cluster.unassigned.slice(0, 20).join(", ")}）`
          : ""
      }`,
      "",
      "> 分值为代码夹取、总分由代码相加；硬淘汰由代码执行，模型只负责聚类与理由。",
      "",
    ];

    for (const [index, item] of cluster.packages.entries()) {
      lines.push(
        `## ${index + 1}. ${item.name} —— ${item.total} 分${
          item.eliminated ? `（已淘汰：${item.eliminated}）` : "（入选候选）"
        }`,
        "",
        `- 领域：${item.lane || item.laneRaw || "未标注"}${
          item.laneUnverified ? "（自创名，待领域路由裁决）" : ""
        }${item.laneReason ? `（${item.laneReason}）` : ""}`,
        `- 素材：${item.materialIds.length} 条${
          item.materialIds.length > 0
            ? `（${item.materialIds.join(", ")}）`
            : ""
        }`,
        item.invalidMaterialIds
          ? `- ⚠️ 引用了不存在的素材 id：${item.invalidMaterialIds.join(", ")}`
          : "",
        `- 一手来源（模型初判）：${item.primarySources.join("；") || "无"}`,
        `- 可抓取补料入口（代码从真实素材派生）：${
          item.supplementEntryLinks.join("；") || "无"
        }`,
        `- 核心事实：${item.coreFacts.join("；") || "无"}`,
        `- 被广泛转述的说法：${item.widelyRepeated || "未记录"}`,
        `- 被省略的限定条件：${item.omittedConditions.join("；") || "未记录"}`,
        `- 争议点：${item.controversy || "无"}`,
        `- 作者判断入口：${item.authorEntry || "未记录"}`,
        `- 素材缺口：${item.gaps.join("；") || "无"}`,
        `- 分项：认知落差 ${item.scores.gap}/25｜现实相关 ${item.scores.relevance}/20｜争议空间 ${item.scores.controversy}/15｜素材充分 ${item.scores.material}/20｜作者可写 ${item.scores.writable}/20`,
        `- 扣分理由：${item.deduction || "未记录"}`,
        "",
      );
    }

    return lines.filter((line) => line !== "").join("\n");
  }

  private renderAuthorContext(context: AuthorContext): string {
    return [
      "# 作者背景（送进模型的实际内容）",
      "",
      "> 这份文件是审计用的：下面「实际注入内容」就是送给模型的原文。",
      "> 命中敏感规则的行在注入前已整行删除，删除记录见下节。",
      "",
      `- 是否取到材料：${context.available ? "是" : "否"}`,
      `- 采用文件数：${context.sources.length}`,
      `- 注入总字数：${context.summary.length}`,
      `- 敏感名单来源：${context.privacyTermSource}`,
      `- 脱敏删除处数：${context.removed.length}`,
      "",
      "## 采用的文件",
      "",
      context.sources.length > 0
        ? context.sources.map((item) => `- ${item.path}（${item.chars} 字）`)
          .join("\n")
        : "（无）",
      "",
      "## 跳过的文件",
      "",
      context.skipped.length > 0
        ? context.skipped.map((item) => `- ${item.path}：${item.reason}`).join(
          "\n",
        )
        : "（无）",
      "",
      "## 脱敏删除的命中",
      "",
      context.removed.length > 0
        ? formatPrivacyHits(context.removed)
        : "（无）",
      "",
      "## 记忆包本地摘要",
      "",
      `- 路径：${redactTerms(context.memory.path, context.privacyTerms)}`,
      `- 是否采用：${context.memory.available ? "是" : "否"}`,
      `- 采用章节：${context.memory.kept.length} 个`,
      `- 跳过章节：${context.memory.dropped.length} 个`,
      `- 摘要字数：${context.memory.text.length}`,
      `- 章节筛选后再脱敏删除：${context.memory.removedBySanitizer} 处`,
      "",
      "### 采用的章节",
      "",
      context.memory.kept.length > 0
        ? context.memory.kept.map((item) =>
          `- ${item.path}（${item.chars} 字）`
        ).join("\n")
        : "（无）",
      "",
      "### 跳过的章节与原因",
      "",
      context.memory.dropped.length > 0
        ? context.memory.dropped.map((item) =>
          `- ${item.path || item.heading}：${item.reason}`
        ).join("\n")
        : "（无）",
      "",
      "## 实际注入内容",
      "",
      context.summary || "（无）",
    ].join("\n");
  }

  private renderRunIndex(input: {
    runDirName: string;
    selected: TopicPackage;
    cluster: TopicClusterResult;
    bundle: ResearchBundle;
    gate: GateResult;
    privacyPassed: boolean;
    materialCount: number;
  }): string {
    return [
      `# 深度文运行记录：${input.runDirName}`,
      "",
      "## 结论",
      "",
      `- 主题：${input.selected.name}（爆款评分 ${input.selected.total}/100）`,
      `- 领域：${input.bundle.lane}`,
      `- 素材：${input.materialCount} 条，主题包 ${input.cluster.packages.length} 个`,
      `- 审稿状态：**${input.gate.status}**（${input.gate.total}/${input.gate.totalMax}）`,
      `- 隐私后检：${input.privacyPassed ? "通过" : "拦截"}`,
      `- 发布状态：${input.gate.publishStatus}`,
      "",
      "## 产物索引",
      "",
      "| 文件 | 内容 |",
      "|---|---|",
      "| 01-主题包清单.md | 时效窗口内素材聚类结果、爆款评分与硬淘汰 |",
      "| 02-作者背景.md | 注入模型的作者背景（已脱敏）+ 删除记录 |",
      "| 00-素材清单.md | 原始采集结果、时效窗口、去重与筛除记录 |",
      "| 03-领域判断卡.md | 五领域路由结果 |",
      "| 04-素材缺口与补料.md | 缺口判断 + 抓取的一手材料 |",
      "| 05-证据与事实锁定.md | 陈述分层与锁定表 |",
      "| 06-作者立场卡.md | 观察者位、取舍标准、边界 |",
      "| 07-立论与反方.md | 张力、核心机制、可争论判断、最强反方 |",
      "| 08-写作技术卡.md | 文章原型与本篇写法 |",
      "| 09-初稿.md | 起草结果 |",
      "| 10-事实回查.md | 事实修正记录 |",
      "| 11~13-审稿-*.md | 三轮独立审稿 |",
      "| 14-审稿闸门.md | 量表得分与通过判断 |",
      "| 15-隐私后检.md | 代码层与模型层隐私命中 |",
      "| 16-成稿.md | 最终正文与候选标题 |",
      "",
      "## 待你确认",
      "",
      "- 这篇是否像你写的、是否愿意发（skill 规定作者本人阅读反馈高于量表分数，机器不代签）；",
      "- 主题包清单里是否有更适合本次素材的主题（可换主题重跑）；",
      "- 候选标题选哪个。",
    ].join("\n");
  }

  /**
   * 中间卡空值检查。
   *
   * 模型返回 `{}` 时不检查的后果：03/05/06/07 几张卡落盘后只有标题行，
   * 流程照样跑到打分与发布，而操作者从产物上看不出地基是空的。
   * evidence / thesis 为空必须终止——它们是正文的地基，缺了写出来的只是空话。
   */
  private checkCard(
    record: Record<string, unknown>,
    name: string,
    critical: boolean,
  ): void {
    if (hasContent(record)) return;
    if (critical) {
      throw new WorkflowTerminateError(
        `${name}为空（模型未返回有效字段），无法继续起草`,
      );
    }
    logger.warn(
      `[深度文] ${name}为空（模型未返回有效字段），已继续但产物会偏薄`,
    );
  }

  private async flushArtifacts(
    dir: string,
    artifacts: DeepArticleArtifact[],
  ): Promise<string> {
    const { written, failed } = await writeDeepArticleArtifacts(dir, artifacts);
    if (failed.length > 0) {
      logger.warn(
        `[深度文][留档] ${failed.length} 个文件写入失败：${
          failed.map((item) => `${item.name}(${item.error})`).join(", ")
        }`,
      );
    }
    logger.info(`[深度文][留档] 已写入 ${written.length} 个文件到 ${dir}`);
    return dir;
  }

  private emptyAuthorContext(reason: string): AuthorContext {
    return {
      summary: "",
      sources: [],
      skipped: [{ path: "(未读取)", reason }],
      removed: [] as PrivacyHit[],
      privacyTermSource: "(未加载)",
      privacyTerms: [],
      available: false,
      memory: {
        text: "",
        kept: [],
        dropped: [],
        available: false,
        path: "(未读取)",
        removedBySanitizer: 0,
      },
    };
  }
}
