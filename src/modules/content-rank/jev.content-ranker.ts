/**
 * Jev 版内容排序器。
 *
 * 一篇一次请求、一次带 4 个维度问题（官方叫 fan-out：同一 state 上的多个问题并行判定）：
 *   - 单篇 state 约 3k 字符，离 32k 的「state + 最长问题」预算很远，永远碰不到上限；
 *   - 失败可以按篇重试，日志能定位到具体是哪一条素材。
 *
 * 与 LLM 路径的三个行为差异，都是刻意的：
 *   1. **不传关键词**。现有提示词里有一段「命中关键词从 50 分起、泛热点不超过 40 分」的
 *      规则，Jev 这一期不带（见执行方案第 2 节）。主题贴合度由排序后的
 *      `prioritizeByKeywordRelevance` 在代码里兜 —— 那一层两条路径都要过。
 *   2. **不做去重**。去重早就从 LLM 挪回代码（`content-dedup.ts`），Jev 不碰。
 *   3. **失败不上抛**。单篇失败只记日志并从结果里缺席，交给工作流里那条
 *      「漏评按 0 分补在末尾」的既有兜底补位；整批成功率不够时由 ranker.factory 回落 LLM。
 */
import {
  JevClient,
  JevHttpError,
  SCORE_LEVEL_MAX,
} from "../../providers/system-one/jev.client.ts";
import {
  ScoreAnswer,
  SystemOneQuestion,
} from "../../providers/interfaces/system-one.interface.ts";
import { ScrapedContent } from "../interfaces/scraper.interface.ts";
import { RankResult } from "../interfaces/content-ranker.interface.ts";
import {
  CRITERIA,
  DIMENSION_KEYS,
  DimensionKey,
  IMAGE_BONUS,
  INSTRUCTIONS,
  normalizeLevel,
  weightedConfidence,
  weightedScore,
} from "../../prompts/content-ranker.rubric.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

/** 单篇 state 的正文截断长度：约 3k–6k token，留足 32k 预算的余量 */
export const DEFAULT_MAX_STATE_CHARS = 12000;

export interface JevContentRankerOptions {
  /** 并发请求数，默认 5（对应 JEV_CONCURRENCY） */
  concurrency?: number;
  /** 单篇正文送入时的最大字符数 */
  maxStateChars?: number;
}

/** 一次 run 的失败明细，供调用方算成功率 / 打日志 */
export interface JevRunFailures {
  total: number;
  succeeded: number;
  failures: Array<{ id: string; title: string; reason: string }>;
}

export class JevContentRanker {
  private readonly concurrency: number;
  private readonly maxStateChars: number;
  private failures: JevRunFailures = { total: 0, succeeded: 0, failures: [] };

  constructor(
    private readonly client: JevClient,
    options: JevContentRankerOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 5);
    this.maxStateChars = options.maxStateChars ?? DEFAULT_MAX_STATE_CHARS;
  }

  /** 上一次 run 的失败明细（日志之外还要给 factory 判定用） */
  public getLastRunFailures(): JevRunFailures {
    return this.failures;
  }

  public async rankContents(
    contents: ScrapedContent[],
    _keywords: string[] = [],
  ): Promise<RankResult[]> {
    this.failures = { total: contents.length, succeeded: 0, failures: [] };
    if (!contents.length) return [];

    const results: RankResult[] = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(this.concurrency, contents.length) },
      async () => {
        for (;;) {
          const index = cursor++;
          if (index >= contents.length) return;
          const content = contents[index];
          const result = await this.rankOne(content);
          if (result) results.push(result);
        }
      },
    );
    await Promise.all(workers);

    // 跟 LLM 路径一样按输入顺序回填：结果顺序不该随并发调度漂移
    const order = new Map(contents.map((c, i) => [String(c.id), i]));
    results.sort(
      (a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0),
    );

    this.failures.succeeded = results.length;
    if (this.failures.failures.length > 0) {
      const detail = this.failures.failures
        .slice(0, 5)
        .map((f) => `${f.id}(${f.reason})`)
        .join(", ");
      logger.warn(
        `[排序] Jev 失败 ${this.failures.failures.length}/${contents.length} 条：${detail}${
          this.failures.failures.length > 5 ? " …" : ""
        }（失败条目交给「漏评按 0 分」兜底）`,
      );
    }
    return results;
  }

  // ------------------------------------------------------------------ 内部

  private async rankOne(content: ScrapedContent): Promise<RankResult | null> {
    const id = String(content.id);
    try {
      const { response, attempts, durationMs } = await this.client.evaluate({
        state: this.buildState(content),
        questions: this.buildQuestions(),
      });
      const scored = this.readAnswers(response.answers);
      if (!scored) {
        this.recordFailure(
          id,
          content.title,
          `4 个维度未全部返回 score 答案（实到: ${
            Object.keys(response.answers).join("/")
          }）`,
        );
        return null;
      }

      const normalized: Partial<Record<DimensionKey, number>> = {};
      const confidences: Partial<Record<DimensionKey, number>> = {};
      const dims: Record<
        string,
        { raw: number; normalized: number; confidence: number }
      > = {};
      const probabilities: Record<string, Record<string, number>> = {};

      for (const key of DIMENSION_KEYS) {
        const answer = scored[key];
        const levelCount = CRITERIA[key].length;
        const value = normalizeLevel(answer.score, levelCount);
        normalized[key] = value;
        confidences[key] = answer.confidence;
        dims[key] = {
          raw: answer.score,
          normalized: value,
          confidence: answer.confidence,
        };
        probabilities[key] = answer.probabilities ?? {};
      }

      const imageBonus = content.media && content.media.length > 0
        ? IMAGE_BONUS
        : 0;
      const base = weightedScore(normalized);
      const score = Math.min(100, base + imageBonus);
      if (attempts > 0) {
        logger.info(
          `[排序] Jev 重试后成功｜${id}｜重试 ${attempts} 次｜${durationMs}ms`,
        );
      }

      return {
        id,
        score,
        confidence: weightedConfidence(confidences),
        engine: "JEV",
        detail: { dims, probabilities, imageBonus },
      };
    } catch (error) {
      this.recordFailure(id, content.title, this.describeError(error));
      return null;
    }
  }

  private recordFailure(id: string, title: string, reason: string): void {
    this.failures.failures.push({ id, title, reason });
  }

  private describeError(error: unknown): string {
    if (error instanceof JevHttpError) {
      return `HTTP ${error.status}${error.retryable ? "(可重试已用尽)" : ""}`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 送入 Jev 的单篇内容。**只放判定需要的字段** —— 素材越短，成本越低，
   * 而且 url / 平台这类噪声会干扰「时效性」判断。
   */
  public buildState(content: ScrapedContent): string {
    const body = (content.content ?? "").slice(0, this.maxStateChars);
    return [
      `标题: ${content.title ?? ""}`,
      `发布时间: ${content.publishDate ?? "未知"}`,
      `正文:`,
      body,
    ].join("\n");
  }

  /** 4 个维度各自一个问题：官方要求「一个问题只测一个维度」，权重在代码里合并。 */
  public buildQuestions(): Record<string, SystemOneQuestion> {
    const questions: Record<string, SystemOneQuestion> = {};
    for (const key of DIMENSION_KEYS) {
      const criteria = CRITERIA[key];
      if (
        criteria.length < 2 || criteria.length > SCORE_LEVEL_MAX
      ) {
        throw new Error(
          `档位数量不合法（${key}: ${criteria.length}），官方要求 2–${SCORE_LEVEL_MAX} 档`,
        );
      }
      questions[key] = {
        type: "score",
        instructions: INSTRUCTIONS[key],
        criteria,
      };
    }
    return questions;
  }

  private readAnswers(
    answers: Record<string, unknown>,
  ): Record<DimensionKey, ScoreAnswer> | null {
    const out = {} as Record<DimensionKey, ScoreAnswer>;
    for (const key of DIMENSION_KEYS) {
      const answer = answers[key];
      if (
        !answer || typeof answer !== "object" ||
        (answer as { type?: string }).type !== "score"
      ) {
        return null;
      }
      const score = (answer as { score?: unknown }).score;
      const confidence = (answer as { confidence?: unknown }).confidence;
      if (typeof score !== "number" || Number.isNaN(score)) return null;
      out[key] = {
        type: "score",
        score,
        confidence: typeof confidence === "number" && !Number.isNaN(confidence)
          ? confidence
          : 0,
        legend: (answer as ScoreAnswer).legend ?? {},
        probabilities: (answer as ScoreAnswer).probabilities ?? {},
      };
    }
    return out;
  }
}
