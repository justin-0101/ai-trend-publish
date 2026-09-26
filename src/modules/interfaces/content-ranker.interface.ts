import { ScrapedContent } from "./scraper.interface.ts";
import { LLMProviderType } from "../../providers/interfaces/llm.interface.ts";

export interface RankResult {
  id: string;
  /** 0–100，两条引擎（LLM / JEV）口径一致，下游不用改 */
  score: number;
  /** 0–1，仅 JEV 引擎提供（LLM 路径为 undefined） */
  confidence?: number;
  /** 这条分数由哪个引擎给出 */
  engine?: "LLM" | "JEV";
  /** 分维度原始分与档位概率，仅用于审计和调参，下游不依赖 */
  detail?: {
    dims: Record<
      string,
      { raw: number; normalized: number; confidence: number }
    >;
    probabilities?: Record<string, Record<string, number>>;
    imageBonus?: number;
  };
}

/**
 * 排序器的**最小**接口（比 `ContentRanker` 窄）：
 * `weixin-article.workflow` 只用到 `rankContents`，JEV 实现不提供 batch 版本，
 * 所以工作流依赖这个接口，而不是那个要求 `rankContentsBatch` 的宽接口。
 */
export interface RankerLike {
  rankContents(
    contents: ScrapedContent[],
    keywords?: string[],
  ): Promise<RankResult[]>;
}

export interface ContentRankerConfig {
  provider?: LLMProviderType;
  modelName?: string;
  temperature?: number;
  maxRetries?: number;
  baseDelay?: number;
}

export interface ContentRanker {
  /**
   * 对内容列表进行评分排名
   * @param contents 需要评分的内容列表
   * @returns 评分结果列表
   */
  rankContents(
    contents: ScrapedContent[],
    keywords?: string[],
  ): Promise<RankResult[]>;

  /**
   * 批量对内容进行评分排名
   * @param contents 需要评分的内容列表
   * @param batchSize 每批处理的内容数量
   * @returns 评分结果列表
   */
  rankContentsBatch(
    contents: ScrapedContent[],
    batchSize?: number,
  ): Promise<RankResult[]>;
}
