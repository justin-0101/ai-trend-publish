/**
 * 采集→关键词过滤 联合验证（不调用 LLM、不发布）。
 *
 * 回答一个具体问题：用户设了关键词 GEO，采集环节到底还剩多少条能进下一步？
 *
 * 「采集」用真实抓取（Twitter Frontend / X 搜索原始结果 JSON），
 * 「过滤」逐行复刻 weixin-article.workflow.ts:311-322 的那段逻辑
 * （x-search 命中 include 直接放行、exclude 对所有源生效）。
 * 复刻而非 import：那段逻辑是 run() 里的内联 filter，没有可导出函数。
 */

import { ConfigManager } from "@src/utils/config/config-manager.ts";
import { TwitterFrontendScraper } from "@src/modules/scrapers/twitter.scraper.ts";

interface Item {
  title?: string;
  content?: string;
  platform?: string;
}

// 复刻 weixin-article.workflow.ts:311-322
const applyFilter = (
  items: Item[],
  includeKeywords: string[],
  excludeKeywords: string[],
) =>
  items.filter((content) => {
    const text = `${content.title ?? ""}\n${content.content ?? ""}`.toLowerCase();
    if (excludeKeywords.length > 0) {
      const hit = excludeKeywords.some((k) => text.includes(k.toLowerCase()));
      if (hit) return false;
    }
    if (content.platform === "x-search") return true;
    if (includeKeywords.length > 0) {
      return includeKeywords.some((k) => text.includes(k.toLowerCase()));
    }
    return true;
  });

const loadXSearchRaw = async (): Promise<Item[]> => {
  const dir = "logs";
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.name.startsWith("x-search-") && e.name.endsWith(".json")) {
      files.push(`${dir}/${e.name}`);
    }
  }
  files.sort();
  const latest = files[files.length - 1];
  if (!latest) return [];
  const doc = JSON.parse(await Deno.readTextFile(latest));
  const posts = Array.isArray(doc.posts) ? doc.posts : [];
  console.log(`X 搜索原始文件: ${latest}（${posts.length} 条）`);
  return posts.map((p: { text?: string; who?: string }) => ({
    title: (p.text ?? "").split("\n")[0],
    content: p.text ?? "",
    platform: "x-search",
  }));
};

const main = async () => {
  await ConfigManager.getInstance().initialize();

  const twitter = (await new TwitterFrontendScraper().scrape(
    "https://x.com/OpenAIDevs",
  )) as unknown as Item[];
  console.log(`Twitter Frontend 采集: ${twitter.length} 条\n`);

  const xsearch = await loadXSearchRaw();

  const scenarios: Array<{
    label: string;
    items: Item[];
    include: string[];
    exclude: string[];
  }> = [
    {
      label: "twitter 时间线 + 包含关键词[GEO]（用户报的那个组合）",
      items: twitter,
      include: ["GEO"],
      exclude: [],
    },
    {
      label: "twitter 时间线 + 无关键词",
      items: twitter,
      include: [],
      exclude: [],
    },
    {
      label: "twitter 时间线 + 包含[GEO] + 排除[skills]",
      items: twitter,
      include: ["GEO"],
      exclude: ["skills"],
    },
    {
      label: "x-search(GEO) + 包含关键词[GEO]",
      items: xsearch,
      include: ["GEO"],
      exclude: [],
    },
    {
      label: "x-search(GEO) + 排除关键词[GEO]",
      items: xsearch,
      include: [],
      exclude: ["GEO"],
    },
  ];

  for (const s of scenarios) {
    const out = applyFilter(s.items, s.include, s.exclude);
    console.log(
      `${String(out.length).padStart(3)} / ${String(s.items.length).padStart(3)} 剩余 | ${s.label}`,
    );
  }
};

await main();
