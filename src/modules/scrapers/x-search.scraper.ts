import {
  ContentScraper,
  Media,
  ScrapedContent,
  ScraperOptions,
} from "../interfaces/scraper.interface.ts";
import { readOptionalConfig } from "../../utils/config/optional-config.ts";
import { formatDate } from "../../utils/common.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
  warn: (msg: string) => console.warn(msg),
  debug: (msg: string, ...args: unknown[]) => console.debug(msg, ...args),
};

/**
 * X 关键词搜索采集（浏览器自动化）。
 *
 * 采集方法本体在 skill 里：`E:\openclaw-skills\x-search-collector`
 *   - `SKILL.md`：为什么只能走浏览器、有哪些坑、验收标准
 *   - `scripts/collect-x-search.mjs`：唯一一份可执行实现
 *
 * 本类只做「调用方」该做的事：定位 skill → 传参 → 校验退出码 → 把 JSON 映射成
 * ScrapedContent。采集逻辑一行都不在这里复制，避免两份实现各自漂移。
 *
 * 为什么必须走浏览器：
 *   - twitterapi.io 付费路线（TwitterScraper）欠费即 402，且只有它支持关键词搜索
 *   - 免密钥 syndication（TwitterFrontendScraper）只有账号时间线，没有全网搜索
 *   - 账号 cookie + GraphQL 要落 cookie、跑私有接口，风控风险高
 */

interface XSearchPost {
  ref?: string;
  dt?: string;
  who?: string;
  text?: string;
  likes?: string;
  media?: boolean;
  promo?: boolean;
}

interface XSearchDoc {
  query: string;
  collectedAt: string;
  count: number;
  rawCount?: number;
  posts: XSearchPost[];
}

/** skill 的可能位置（按优先级）；envKey 存在时先用它的值覆盖 */
const SKILL_DIR_CANDIDATES: Array<{ envKey?: string; dir?: string }> = [
  { envKey: "X_SEARCH_SKILL_DIR" },
  { dir: "E:/openclaw-skills/x-search-collector" },
  { dir: "skills/x-search-collector" },
  { dir: `${Deno.env.get("USERPROFILE") ?? ""}/.pi/agent/skills/x-search-collector` },
  { dir: `${Deno.env.get("HOME") ?? ""}/.pi/agent/skills/x-search-collector` },
];

export class XSearchScraper implements ContentScraper {
  private async config(key: string): Promise<string | null> {
    const value = await readOptionalConfig(key);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  /** 定位 skill 脚本；找不到时给出可执行的修复指引，而不是一个「文件不存在」 */
  private async resolveScript(): Promise<string> {
    for (const candidate of SKILL_DIR_CANDIDATES) {
      const dir = candidate.envKey
        ? await this.config(candidate.envKey)
        : candidate.dir;
      if (!dir) continue;
      const script = `${dir.replace(/[\\/]+$/, "")}/scripts/collect-x-search.mjs`;
      try {
        if ((await Deno.stat(script)).isFile) return script;
      } catch {
        continue;
      }
    }
    throw new Error(
      "找不到 X 搜索采集脚本。请任选其一：\n" +
        "  1) 装 skill 到 E:\\openclaw-skills\\x-search-collector\n" +
        "  2) 在 .env 设 X_SEARCH_SKILL_DIR=<skill 目录绝对路径>",
    );
  }

  async scrape(
    sourceId: string,
    _options?: ScraperOptions,
  ): Promise<ScrapedContent[]> {
    const query = String(sourceId ?? "").trim();
    if (!query) throw new Error("X 搜索的数据源标识不能为空（应为搜索关键词）");

    const script = await this.resolveScript();
    const nodeBin = (await this.config("X_SEARCH_NODE")) ?? "node";
    const pages = (await this.config("X_SEARCH_PAGES")) ?? "top,latest";
    const rounds = (await this.config("X_SEARCH_ROUNDS")) ?? "";
    const timeoutMs = Number(
      (await this.config("X_SEARCH_TIMEOUT_MS")) ?? "600000",
    );
    const maxPosts = Number((await this.config("X_SEARCH_MAX_POSTS")) ?? "30");

    // 原始 JSON 留在 logs/ 里当证据：采集结果不可复现（x.com 会变），
    // 事后再想核对「当时到底抓到了什么」只能靠它。
    // 文件名带本地时间戳且从不覆盖——之前用「日期」命名，同一天重跑会把上一次的证据
    // 默默盖掉，等于把证据链做成了一次性的。
    const rawOut = `logs/x-search-${this.slug(query)}-${
      this.localStamp(new Date())
    }.json`;

    const args = [
      script,
      "--query",
      query,
      "--pages",
      pages,
      "--out",
      rawOut,
      "--quiet",
    ];
    if (rounds) args.push("--rounds", rounds);

    logger.debug(
      `[X搜索] 采集关键词: ${query}（script=${script}, pages=${pages}）`,
    );

    const started = Date.now();
    const child = new Deno.Command(nodeBin, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 超时必须真的杀掉：采集脚本自己会开标签页，留一个僵尸进程等于留一个失控的浏览器会话
      try {
        child.kill("SIGKILL");
      } catch { /* 已经退了 */ }
    }, timeoutMs);

    let code: number;
    let stdout = "";
    let stderr = "";
    try {
      const out = await child.output();
      code = out.code;
      stdout = new TextDecoder().decode(out.stdout);
      stderr = new TextDecoder().decode(out.stderr);
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      throw new Error(
        `X 搜索采集超时（${Math.round(timeoutMs / 1000)}s）。` +
          `可在 .env 调大 X_SEARCH_TIMEOUT_MS，或调小 X_SEARCH_ROUNDS。`,
      );
    }

    if (code !== 0) {
      // 退出码 2 = 前置条件不满足（桥不通/扩展离线/未登录/代理没开）。
      // 这四种情况的修复动作完全不同，所以原样把脚本的指引透出来，不再包装成一句“抓取失败”。
      const detail = stderr.trim() || stdout.trim() || `退出码 ${code}`;
      const prefix = code === 2 ? "[X搜索·前置条件不满足]" : "[X搜索·采集失败]";
      throw new Error(`${prefix} ${query}\n${detail}`);
    }

    let doc: XSearchDoc;
    try {
      doc = JSON.parse(await Deno.readTextFile(rawOut));
    } catch (error) {
      throw new Error(
        `X 搜索采集脚本退出码为 0，但读不到结果文件 ${rawOut}：${
          error instanceof Error ? error.message : String(error)
        }\nstdout: ${stdout.slice(0, 300)}`,
      );
    }

    const posts = Array.isArray(doc.posts) ? doc.posts : [];
    const contents: ScrapedContent[] = [];
    for (const post of posts) {
      const id = this.extractId(post.ref);
      const text = String(post.text ?? "").trim();
      if (!text) continue;
      // 没有 status id 就等于没有稳定主键：工作流后续按 id 去重/排序，
      // 硬塞一条无主键的内容会让同一条推文在文章里出现两次。
      if (!id) continue;
      contents.push({
        id,
        title: text.split("\n")[0].slice(0, 100),
        content: text,
        url: `https://x.com${post.ref}`,
        publishDate: post.dt
          ? formatDate(post.dt)
          : formatDate(new Date().toISOString()),
        media: this.extractMedia(post),
        metadata: {
          platform: "x-search",
          query: doc.query ?? query,
          username: this.extractUsername(post.who),
          author: post.who ?? "",
          likes: post.likes ?? "",
          hasMedia: post.media === true,
        },
      });
    }

    if (contents.length > maxPosts) {
      logger.debug(`[X搜索] ${contents.length} → ${maxPosts}（按 X_SEARCH_MAX_POSTS 截断）`);
      contents.length = maxPosts;
    }

    logger.debug(
      `[X搜索] ${query} 抓到 ${doc.rawCount ?? posts.length} 条，可用 ${contents.length} 条，` +
        `用时 ${((Date.now() - started) / 1000).toFixed(1)}s，原始数据: ${rawOut}`,
    );

    return contents;
  }

  /** `/user/status/123456` → `123456` */
  private extractId(ref?: string): string | null {
    const match = String(ref ?? "").match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  /** "MagUp @Magup_AI · 13小时" → `Magup_AI` */
  private extractUsername(who?: string): string {
    const match = String(who ?? "").match(/@([A-Za-z0-9_]+)/);
    return match ? match[1] : "";
  }

  /**
   * DOM 路线只能判断「这条推有没有媒体」，拿不到媒体 URL
   * （URL 在对不上的 picture 标签里，取它要额外一屏一次 eval，不值得）。
   * 这里返回空数组而不是伪造一条 url 为空的 Media —— 下游拿空 url 当图片用会出一张破图。
   */
  private extractMedia(_post: XSearchPost): Media[] {
    return [];
  }

  private slug(query: string): string {
    const ascii = query.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
    return (ascii || "query").slice(0, 40).toLowerCase();
  }

  /**
   * 本地时间戳 `YYYYMMDD-HHmmss`。
   * 不用 toISOString：那是 UTC，本地 9/20 早上跑出来的文件名会写 9/19，
   * 对不上 logs/ 里其他按本地日期命名的文件。
   */
  private localStamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
}
