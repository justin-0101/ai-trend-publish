import { BaseImageGenerator } from "@src/providers/image-gen/base.image-generator.ts";

/**
 * 智谱 cogview-4 图片生成器
 *
 * 接口：POST https://open.bigmodel.cn/api/paas/v4/images/generations
 * 鉴权：Authorization: Bearer ${ZHIPU_API_KEY}
 * 价格：0.06 元 / 次（按生成次数，与 size 无关）
 *
 * 输出是带时效的 CDN URL（智谱侧约 24h 有效），调用方拿到 URL 后应立即下载并
 * 上传到自己控制的存储（这里下游由 WeixinPublisher.uploadThumb 负责下载上传）。
 */

export interface ZhipuCogView4Options {
  /** 图像描述提示词（必填） */
  prompt: string;
  /** 图像尺寸，可选；默认 1440x720（最易被微信 64KB 封面限制接受） */
  size?: "1024x1024" | "768x1344" | "1440x720" | "1024x1536";
}

export const ZHIPU_DEFAULT_MODEL = "cogView-4-250304";
const ZHIPU_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/images/generations";

/**
 * 把 BaseImageGenerator 必须的 abstract 成员显式补齐，避免继承链里出现
 * "non-abstract class does not override" 报错（如果父类没标 abstract 的 refresh）。
 */
export class ZhipuCogView4ImageGenerator extends BaseImageGenerator {
  private apiKey: string = "";

  async refresh(): Promise<void> {
    const key = Deno.env.get("ZHIPU_API_KEY")?.trim();
    if (!key) {
      throw new Error(
        "ZHIPU_API_KEY 未配置（智谱 cogview-4 需要 Bearer 鉴权）",
      );
    }
    this.apiKey = key;
  }

  async generate(options: ZhipuCogView4Options): Promise<string> {
    if (!this.apiKey) {
      // 兜底再读一次（Factory 不一定调过 initialize）
      await this.refresh();
    }
    const { prompt, size = "1440x720" } = options;
    if (!prompt || !prompt.trim()) {
      throw new Error("智谱生成封面：prompt 不能为空");
    }

    const body = JSON.stringify({
      model: ZHIPU_DEFAULT_MODEL,
      prompt: prompt.trim(),
      size,
    });

    let resp: Response;
    try {
      resp = await fetch(ZHIPU_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body,
      });
    } catch (e) {
      throw new Error(
        `智谱 cogview-4 请求失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    let data: any;
    try {
      data = await resp.json();
    } catch {
      throw new Error(
        `智谱 cogview-4 响应不是 JSON（HTTP ${resp.status}）`,
      );
    }

    if (!resp.ok || data?.code || data?.error) {
      const code = data?.code ?? resp.status;
      const msg = data?.message ?? data?.error?.message ?? resp.statusText;
      throw new Error(`智谱 cogview-4 失败(${code}): ${msg}`);
    }

    const url: string | undefined = data?.data?.[0]?.url;
    if (!url) {
      throw new Error(
        `智谱 cogview-4 响应缺少 data[0].url: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return url;
  }
}

/**
 * 构造科技感封面**底图**的 prompt。
 *
 * 关键：必须明确要求「不要任何文字」。实测 cogview-4 会把中文标题画成乱码
 * （如「AI 三连炸」→「AI三连如人」），所以标题一律由本地字体渲染叠加，
 * 模型只负责出无文字的底图。
 */
export const buildTechCoverPrompt = (): string =>
  [
    "Abstract tech background, deep navy blue (#0A1A2F) to cyan (#00C2FF) gradient",
    "glowing data streams, particle grid, holographic UI panels, bokeh light dots",
    "futuristic skyline silhouette, cinematic rim light, high contrast, 4K wallpaper",
    "clean uncluttered center area reserved for text overlay",
    "professional technology magazine background art",
    "absolutely no text, no letters, no words, no numbers, no logo, no signature",
  ].join(", ");
