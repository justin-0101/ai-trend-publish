import { assertEquals } from "@std/assert";
import { ScrapedContent } from "../../../modules/interfaces/scraper.interface.ts";
import {
  DEFAULT_MIN_TWEET_CHARS,
  filterShortXMaterials,
  isXArticleMaterial,
  isXMaterial,
  prioritizeXArticles,
  tweetTextLength,
} from "../../../modules/deep-article/x-material.ts";

const tweet = (
  id: string,
  content: string,
  overrides: Partial<ScrapedContent> = {},
): ScrapedContent => ({
  id,
  title: content.slice(0, 20),
  content,
  url: `https://x.com/u/status/${id}`,
  publishDate: "2026-09-26T00:00:00.000Z",
  metadata: { platform: "x-search" },
  ...overrides,
});

const article = (
  id: string,
  content: string,
  overrides: Partial<ScrapedContent> = {},
): ScrapedContent => ({
  id,
  title: "一篇抓取的文章",
  content,
  url: `https://example.com/${id}`,
  publishDate: "2026-09-26T00:00:00.000Z",
  metadata: { source: "fireCrawl" },
  ...overrides,
});

Deno.test("X 来源识别：platform 优先，缺失时退回 URL 域名", () => {
  assertEquals(isXMaterial(tweet("1", "x")), true);
  assertEquals(
    isXMaterial(article("a", "x")),
    false,
    "firecrawl 文章不算 X 素材",
  );

  // platform 缺失或写成别的值时，靠域名兜底
  const noPlatform = tweet("2", "x", { metadata: {} });
  assertEquals(isXMaterial(noPlatform), true);
  const weirdPlatform = tweet("3", "x", {
    metadata: { platform: "unknown" },
    url: "https://mobile.twitter.com/u/status/3",
  });
  assertEquals(isXMaterial(weirdPlatform), true);

  // 长得像但不同域名的不算：不能把 example.com 当 X
  const lookalike = article("b", "x", { url: "https://notx.com/u/1" });
  assertEquals(isXMaterial(lookalike), false);
});

Deno.test("推文长度按原始字符数算：不剔 URL、不剔空白", () => {
  const withLinks = tweet(
    "1",
    "这是今晚直播的相关资料\nhttps://doc.laoyao.cn/9fl0bc\nhttps://doc.laoyao.cn/t754wa",
  );
  // 真跑踩过：这条帖原文 205 字，剔掉链接只剩 66 字，
  // 但它是三份文档的唯一入口，按「剩多少字」判会误杀。
  assertEquals(tweetTextLength(withLinks), withLinks.content.length);
  assertEquals(tweetTextLength(tweet("2", "  短  ")), 1, "首尾空白要去掉");
});

Deno.test("X Article 识别与优先级：Article 排在普通推文前，内部顺序稳定", () => {
  const normal = tweet("1", "普通推文", {
    metadata: { platform: "x-search", xArticle: false },
  });
  const xArticle = tweet("2", "Article 卡片摘要", {
    metadata: {
      platform: "x-search",
      xArticle: true,
      xArticleUrl: "https://x.com/u/article/abc",
    },
  });
  const anotherNormal = tweet("3", "另一条普通推文");

  assertEquals(isXArticleMaterial(xArticle), true);
  assertEquals(isXArticleMaterial(normal), false);
  assertEquals(
    prioritizeXArticles([normal, xArticle, anotherNormal]).map((item) =>
      item.id
    ),
    ["2", "1", "3"],
  );
});

Deno.test("过短推文被筛掉，长推文与非 X 来源保留", () => {
  const short = tweet("1", "姚老师这个估计卷掉了很多商业化geo系统"); // 20 字
  const long = tweet(
    "2",
    "今年 GEO 太火了，315 之后更是一下冒出来一堆服务商。但我自己聊过 10+ 家后，感觉大部分还是同一套路子：黑盒、批量投毒、价格还不低。短期可能有用，长期很难走远。"
      .repeat(
        2,
      ),
  );
  const shortArticle = article("a", "很短的公告页正文");

  const { kept, dropped } = filterShortXMaterials([short, long, shortArticle]);

  assertEquals(kept.map((item) => item.id), ["2", "a"]);
  assertEquals(dropped.map((item) => item.content.id), ["1"]);
  assertEquals(dropped[0].chars, tweetTextLength(short));
  assertEquals(
    kept.some((item) => item.id === "a"),
    true,
    "非 X 来源不受推文长度门槛约束",
  );
});

Deno.test("边界：正好等于门槛时保留；门槛可覆盖；默认值即 120", () => {
  const exact = tweet("1", "字".repeat(DEFAULT_MIN_TWEET_CHARS));
  const justUnder = tweet("2", "字".repeat(DEFAULT_MIN_TWEET_CHARS - 1));

  const byDefault = filterShortXMaterials([exact, justUnder]);
  assertEquals(byDefault.kept.map((item) => item.id), ["1"]);
  assertEquals(byDefault.dropped.map((item) => item.content.id), ["2"]);

  const lowered = filterShortXMaterials([exact, justUnder], { minChars: 10 });
  assertEquals(lowered.kept.length, 2);
  assertEquals(lowered.dropped.length, 0);

  assertEquals(DEFAULT_MIN_TWEET_CHARS, 120);

  // 非法门槛不能变成「全部放行」或「全部筛掉」，要退回默认值
  const bogus = filterShortXMaterials([exact, justUnder], { minChars: 0 });
  assertEquals(bogus.kept.map((item) => item.id), ["1"]);
  const negative = filterShortXMaterials([exact, justUnder], { minChars: -5 });
  assertEquals(negative.kept.map((item) => item.id), ["1"]);
});

Deno.test("空输入不炸", () => {
  assertEquals(filterShortXMaterials([]).kept, []);
  assertEquals(filterShortXMaterials([]).dropped, []);
});
