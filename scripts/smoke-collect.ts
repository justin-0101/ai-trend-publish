/**
 * 采集环节冒烟测试：逐条采集通道单独跑一遍，看它到底能不能拿到资料。
 *
 * 为什么单独写：工作流的 scrape-contents 步骤会把多个源的结果混在一起，
 * 「抓到 0 条」和「某个源挂了」在日志里长得一样。这里一源一测，
 * 每条通道给出 条数 / 样例标题 / 耗时 / 原始报错。
 *
 * 只读网络请求，不发布、不写草稿、不改配置。
 *
 * 跑法：
 *   deno run --env --allow-env --allow-read --allow-write --allow-net --allow-run \
 *     --allow-sys --allow-ffi scripts/smoke-collect.ts
 */

import { ConfigManager } from "@src/utils/config/config-manager.ts";
import { FireCrawlScraper } from "@src/modules/scrapers/fireCrawl.scraper.ts";
import {
  TwitterCookieScraper,
  TwitterFrontendScraper,
  TwitterScraper,
} from "@src/modules/scrapers/twitter.scraper.ts";
import { XSearchScraper } from "@src/modules/scrapers/x-search.scraper.ts";
import { HelloGithubScraper } from "@src/modules/scrapers/hellogithub.scraper.ts";

interface Result {
  name: string;
  source: string;
  ok: boolean;
  count: number;
  ms: number;
  sample: string;
  note: string;
}

const withTimeout = async <T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: number | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`本机侧超时 ${Math.round(ms / 1000)}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const errText = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").slice(0, 300);
};

const cases: Array<{
  name: string;
  source: string;
  timeoutMs: number;
  run: () => Promise<{ items: Array<{ title?: string; url?: string }> } | Array<{ title?: string }>>;
}> = [
  {
    name: "FireCrawl（HackerNews 源）",
    source: "https://news.ycombinator.com/",
    timeoutMs: 180_000,
    run: () => new FireCrawlScraper().scrape("https://news.ycombinator.com/"),
  },
  {
    name: "Twitter API（twitterapi.io，付费）",
    source: "https://x.com/OpenAIDevs",
    timeoutMs: 90_000,
    run: () => new TwitterScraper().scrape("https://x.com/OpenAIDevs"),
  },
  {
    name: "Twitter Frontend（syndication，免密钥兜底）",
    source: "https://x.com/OpenAIDevs",
    timeoutMs: 90_000,
    run: () => new TwitterFrontendScraper().scrape("https://x.com/OpenAIDevs"),
  },
  {
    name: "Twitter Cookie（需 TWITTER_COOKIE）",
    source: "https://x.com/OpenAIDevs",
    timeoutMs: 60_000,
    run: () => new TwitterCookieScraper().scrape("https://x.com/OpenAIDevs"),
  },
  {
    name: "HelloGitHub（AI 期刊列表）",
    source: "https://hellogithub.com/periodical/category/AI",
    timeoutMs: 120_000,
    run: () => new HelloGithubScraper().getHotItems(1),
  },
  {
    name: "X 关键词搜索（浏览器自动化）",
    source: "GEO 生成式引擎优化",
    timeoutMs: 150_000,
    run: () => new XSearchScraper().scrape("GEO 生成式引擎优化"),
  },
];

const main = async () => {
  await ConfigManager.getInstance().initialize();

  const results: Result[] = [];
  for (const c of cases) {
    const start = Date.now();
    try {
      const raw = await withTimeout(c.run(), c.timeoutMs, c.name);
      const items = (Array.isArray(raw) ? raw : (raw as { items?: unknown[] }).items ?? []) as Array<{ title?: string }>;
      const first = items[0];
      results.push({
        name: c.name,
        source: c.source,
        ok: items.length > 0,
        count: items.length,
        ms: Date.now() - start,
        sample: (first?.title ?? "").replace(/\s+/g, " ").slice(0, 60),
        note: items.length > 0 ? "" : "调用没抛错，但返回 0 条",
      });
    } catch (e) {
      results.push({
        name: c.name,
        source: c.source,
        ok: false,
        count: 0,
        ms: Date.now() - start,
        sample: "",
        note: errText(e),
      });
    }
    const r = results[results.length - 1];
    console.log(
      `${r.ok ? "OK  " : "FAIL"} | ${r.name} | ${r.count} 条 | ${
        (r.ms / 1000).toFixed(1)
      }s | ${r.ok ? r.sample : r.note}`,
    );
  }

  console.log("\n=== JSON ===");
  console.log(JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
};

await main();
