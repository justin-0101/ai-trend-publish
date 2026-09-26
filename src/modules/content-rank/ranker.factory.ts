/**
 * 排序器工厂：按 `AI_CONTENT_RANKER_ENGINE` 选实现，并负责整批回落。
 *
 * 设计上的两条硬约束：
 *   1. **默认必须还是 LLM**：开关缺失或写错一律当 LLM，绝不因为配置读错就换引擎。
 *   2. **出稿不能被 Jev 拖死**：Jev 是第三方托管服务（early access + 闭源），
 *      它挂了要能自动回落，且回落必须打日志，不能静默降级。
 *
 * 回滚成本 = 改一个环境变量 + 重启，不需要回退代码。
 */
import { ContentRanker } from "./ai.content-ranker.ts";
import { JevClient } from "../../providers/system-one/jev.client.ts";
import { JevContentRanker } from "./jev.content-ranker.ts";
import { RankerLike, RankResult } from "../interfaces/content-ranker.interface.ts";
import { ScrapedContent } from "../interfaces/scraper.interface.ts";
import { readOptionalConfig } from "../../utils/config/optional-config.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

export type RankerEngine = "LLM" | "JEV";

/** 缺省 / 非法值一律回 LLM：宁可不出新功能，也不因为配置笔误换掉排序引擎。 */
export const resolveRankerEngine = (raw: unknown): RankerEngine =>
  String(raw ?? "").trim().toUpperCase() === "JEV" ? "JEV" : "LLM";

export const toNumber = (raw: unknown, fallback: number): number => {
  // 空串不能当 0：`JEV_TIMEOUT_MS=""` 会变成超时 0ms，等于每次请求都立刻超时；
  // `JEV_CONCURRENCY=""` 会变成 0（虽然后面有 Math.max 兜，但不该靠那层）。
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export const toBoolean = (raw: unknown, fallback: boolean): boolean => {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
};

/**
 * 整批成功率低于阈值（或抛异常）时回落 LLM。
 *
 * 阈值内失败的那几条**不在这里补 0**：工作流里已有「漏评按 0 分补在末尾」的兜底，
 * 这里补等于把同一件事写两遍，还会掩盖「Jev 到底漏了几条」这个验证信号。
 */
export class FallbackRanker implements RankerLike {
  constructor(
    private readonly primary: RankerLike,
    private readonly fallback: RankerLike,
    private readonly threshold: number,
    private readonly fallbackEnabled: boolean,
    private readonly label = "JEV",
  ) {}

  public async rankContents(
    contents: ScrapedContent[],
    keywords: string[] = [],
  ): Promise<RankResult[]> {
    if (!contents.length) return [];
    let reason: string | null = null;
    try {
      const results = await this.primary.rankContents(contents, keywords);
      const rate = results.length / contents.length;
      if (rate >= this.threshold) {
        if (results.length < contents.length) {
          logger.warn(
            `[排序] ${this.label} 成功率 ${(rate * 100).toFixed(0)}%（${
              results.length
            }/${contents.length}）达到阈值 ${
              (this.threshold * 100).toFixed(0)
            }%，缺失条目按 0 分补在末尾`,
          );
        }
        return results;
      }
      reason = `成功率 ${(rate * 100).toFixed(0)}%（${results.length}/${
        contents.length
      }）低于阈值 ${(this.threshold * 100).toFixed(0)}%`;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }

    logger.warn(`[排序] ${this.label} 失败，回落 LLM｜原因：${reason}`);
    if (!this.fallbackEnabled) {
      throw new Error(
        `${this.label} 排序失败且回落已关闭（JEV_FALLBACK_TO_LLM=false）：${reason}`,
      );
    }
    return this.fallback.rankContents(contents, keywords);
  }
}

/**
 * 组装排序器。只在 `weixin-article.workflow` 里用 —— 另外两个 generator
 * （default / hellogithub）读的是 `AI_CONTENT_RANKER_LLM_PROVIDER`，别顺手动它们。
 */
export const createRanker = async (): Promise<RankerLike> => {
  const engine = resolveRankerEngine(
    await readOptionalConfig("AI_CONTENT_RANKER_ENGINE"),
  );
  const llm = new ContentRanker();
  if (engine === "LLM") return llm;

  const apiKey = await readOptionalConfig("JEV_API_KEY");
  const fallbackEnabled = toBoolean(
    await readOptionalConfig("JEV_FALLBACK_TO_LLM"),
    true,
  );
  const threshold = toNumber(
    await readOptionalConfig("JEV_FALLBACK_THRESHOLD"),
    0.9,
  );

  if (!apiKey) {
    if (!fallbackEnabled) {
      throw new Error(
        "AI_CONTENT_RANKER_ENGINE=JEV 但 JEV_API_KEY 未配置，且 JEV_FALLBACK_TO_LLM=false",
      );
    }
    logger.warn(
      "[排序] AI_CONTENT_RANKER_ENGINE=JEV 但 JEV_API_KEY 未配置，本次回落 LLM",
    );
    return llm;
  }

  const model = String((await readOptionalConfig("JEV_MODEL")) ?? "jev-1.13.0");
  const baseUrl = String(
    (await readOptionalConfig("JEV_BASE_URL")) ?? "https://api.typesafe.ai",
  );
  const timeoutMs = toNumber(await readOptionalConfig("JEV_TIMEOUT_MS"), 15000);
  const concurrency = Math.max(
    1,
    toNumber(await readOptionalConfig("JEV_CONCURRENCY"), 5),
  );

  const client = new JevClient({
    baseUrl,
    apiKey: String(apiKey),
    model,
    timeoutMs,
  });
  const jev = new JevContentRanker(client, { concurrency });
  logger.info(
    `[排序] 引擎=JEV｜model=${model}｜并发=${concurrency}｜回落阈值=${
      (threshold * 100).toFixed(0)
    }%｜回落=${
      fallbackEnabled ? "开" : "关"
    }｜注意：关键词相关度仍由代码层的 prioritizeByKeywordRelevance 兜`,
  );
  return new FallbackRanker(jev, llm, threshold, fallbackEnabled);
};
