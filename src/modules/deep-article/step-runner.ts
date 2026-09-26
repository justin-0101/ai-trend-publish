import { LLMFactory } from "@src/providers/llm/llm-factory.ts";
import { ChatMessage } from "@src/providers/interfaces/llm.interface.ts";
import { ConfigManager } from "@src/utils/config/config-manager.ts";
import { readOptionalConfig } from "@src/utils/config/optional-config.ts";
import { RetryUtil } from "@src/utils/retry.util.ts";
import { parseLooseJson } from "./llm-json.ts";
import { buildStepSystemParts, getStepInstruction, getStepTitle } from "./skill-loader.ts";

/**
 * 深度文工作流的步骤执行器。
 *
 * 把「按 skill 步骤表装配 system 段 → 调 LLM → 宽松解析 JSON」收在一处，
 * 这样 11 个步骤不会各写一遍同样的管道，也保证每一步都带上 skill 的红线。
 */

/** 全体步骤共用的 provider 键；草稿与审稿可用单独键覆盖。 */
export const DEEP_ARTICLE_LLM_PROVIDER_KEY = "DEEP_ARTICLE_LLM_PROVIDER";
export const DEEP_ARTICLE_DRAFT_LLM_PROVIDER_KEY =
  "DEEP_ARTICLE_DRAFT_LLM_PROVIDER";
/** 缺省回落到摘要器用的 provider，避免新增工作流必须同时加配置才能跑 */
export const DEEP_ARTICLE_LLM_PROVIDER_FALLBACK = "AI_SUMMARIZER_LLM_PROVIDER";

export interface StepRunOptions {
  stepKey: string;
  /** 该步的输入（素材清单或上游卡片） */
  payload: string;
  lane?: string;
  /** true 时用草稿专用 provider */
  useDraftProvider?: boolean;
  temperature?: number;
}

export interface StepRunMeta {
  stepKey: string;
  title: string;
  provider: string;
  systemChars: number;
  userChars: number;
  /** 注入的 system 段标题，落盘审计用 */
  systemParts: string[];
}

export interface StepRunResult<T> {
  data: T;
  meta: StepRunMeta;
}

/**
 * 步骤执行器的结构接口。工作流依赖这个而不是具体类，
 * 所以编排可以用桩 runner 做零成本端到端测试（不调 LLM、不联网）。
 */
export interface DeepArticleRunnerLike {
  runJson<T>(options: StepRunOptions): Promise<StepRunResult<T>>;
}

const resolveProvider = async (useDraft: boolean): Promise<string> => {
  const keys = useDraft
    ? [DEEP_ARTICLE_DRAFT_LLM_PROVIDER_KEY, DEEP_ARTICLE_LLM_PROVIDER_KEY]
    : [DEEP_ARTICLE_LLM_PROVIDER_KEY];

  for (const key of keys) {
    const value = await readOptionalConfig(key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  try {
    return await ConfigManager.getInstance().get<string>(
      DEEP_ARTICLE_LLM_PROVIDER_FALLBACK,
    );
  } catch {
    throw new Error(
      `深度文工作流没有可用的 LLM：请配置 ${DEEP_ARTICLE_LLM_PROVIDER_KEY}` +
        ` 或 ${DEEP_ARTICLE_LLM_PROVIDER_FALLBACK}`,
    );
  }
};

/** system 段标题：取每段第一行，落盘时只存标题，不存全文。 */
const partLabel = (part: string): string =>
  part.split("\n")[0].replace(/^【|】$/g, "").trim();

export class DeepArticleStepRunner implements DeepArticleRunnerLike {
  private llmFactory: LLMFactory;

  constructor() {
    this.llmFactory = LLMFactory.getInstance();
  }

  /**
   * 执行一步并要求 JSON 输出。重试由 RetryUtil 负责；解析失败也会触发重试，
   * 因为模型第二次往往能给出合法 JSON。
   */
  public async runJson<T>(options: StepRunOptions): Promise<StepRunResult<T>> {
    const { stepKey, payload, lane, useDraftProvider = false } = options;

    const [parts, instruction, provider] = await Promise.all([
      buildStepSystemParts(stepKey, { lane }),
      getStepInstruction(stepKey),
      resolveProvider(useDraftProvider),
    ]);

    const systemContent = [
      ...parts,
      `【本步任务】\n${instruction}`,
    ].join("\n\n---\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
      { role: "user", content: payload },
    ];

    const data = await RetryUtil.retryOperation(async () => {
      const llm = await this.llmFactory.getLLMProvider(provider);
      const response = await llm.createChatCompletion(messages, {
        temperature: options.temperature ?? 0.4,
        response_format: { type: "json_object" },
      });
      const raw = response?.choices?.[0]?.message?.content;
      if (!raw) {
        throw new Error(`${stepKey}：未获取到有效输出`);
      }
      return parseLooseJson<T>(raw, `${stepKey} 输出`);
    });

    return {
      data,
      meta: {
        stepKey,
        title: await getStepTitle(stepKey),
        provider,
        systemChars: systemContent.length,
        userChars: payload.length,
        systemParts: parts.map(partLabel),
      },
    };
  }
}
