import { assertEquals, assertThrows } from "@std/assert";
import {
  buildRedditFeedUrl,
  extractRedditPost,
  normalizeRedditSource,
  REDDIT_USER_AGENT,
} from "../../../modules/scrapers/reddit.scraper.ts";
import {
  buildBilibiliApiUrl,
  normalizeBilibiliSource,
} from "../../../modules/scrapers/bilibili.scraper.ts";
import {
  buildZhihuApiUrl,
  normalizeZhihuSource,
} from "../../../modules/scrapers/zhihu.scraper.ts";
import { normalizeFeedUrl } from "../../../modules/scrapers/rss.scraper.ts";

Deno.test("Reddit 源：接受 r/xxx 与网页 URL，默认 hot", () => {
  assertEquals(normalizeRedditSource("r/OpenAI"), {
    subreddit: "OpenAI",
    sort: "hot",
  });
  assertEquals(normalizeRedditSource("OpenAI"), {
    subreddit: "OpenAI",
    sort: "hot",
  });
  assertEquals(normalizeRedditSource("https://www.reddit.com/r/LocalLLaMA"), {
    subreddit: "LocalLLaMA",
    sort: "hot",
  });
  assertEquals(
    normalizeRedditSource("https://www.reddit.com/r/LocalLLaMA/top/.rss"),
    { subreddit: "LocalLLaMA", sort: "top" },
  );
  assertEquals(
    normalizeRedditSource("https://old.reddit.com/r/OpenAI/new"),
    { subreddit: "OpenAI", sort: "new" },
  );
});

Deno.test("Reddit 源：非法输入与错误域名必须报错", () => {
  assertThrows(() => normalizeRedditSource(""), Error, "为空");
  assertThrows(() => normalizeRedditSource("https://example.com/r/OpenAI"), Error, "域名不是");
  assertThrows(() => normalizeRedditSource("r/a"), Error, "识别不出子版块名");
});

Deno.test("Reddit 源：feed 地址只认 www 域名（old.reddit 返回空 feed）", () => {
  assertEquals(
    buildRedditFeedUrl({ subreddit: "OpenAI", sort: "hot" }),
    "https://www.reddit.com/r/OpenAI/hot/.rss",
  );
  // UA 必须能标识调用方，否则更容易被 403/429
  assertEquals(REDDIT_USER_AGENT.includes("trendpublish"), true);
});

Deno.test("Reddit 正文：从模板 HTML 里抽出外链，清掉 [link]/submitted by 噪音", () => {
  const html = `<table><tr><td><a href="https://www.reddit.com/r/OpenAI/comments/1wcsciq/x/">
    <img src="https://external-preview.redd.it/abc.png"/></a></td>
    <td> submitted by <a href="https://www.reddit.com/user/MatricesRL">/u/MatricesRL</a>
    <br/><span><a href="https://openai.com/index/introducing-chatgpt-financial-services/">[link]</a></span>
    <span><a href="https://www.reddit.com/r/OpenAI/comments/1wcsciq/x/">[comments]</a></span></td></tr></table>`;
  const { body, externalUrl } = extractRedditPost(html);
  // 必须是原文外链，而不是 reddit 自身链接或预览图 CDN
  assertEquals(
    externalUrl,
    "https://openai.com/index/introducing-chatgpt-financial-services/",
  );
  assertEquals(body.includes("[link]"), false);
  assertEquals(body.includes("submitted by"), false);
});

Deno.test("B站源：popular 与 newlist:<分区>", () => {
  assertEquals(normalizeBilibiliSource("popular"), { mode: "popular", rid: 0 });
  assertEquals(normalizeBilibiliSource("hot"), { mode: "popular", rid: 0 });
  assertEquals(
    normalizeBilibiliSource("https://www.bilibili.com/v/popular/all"),
    { mode: "popular", rid: 0 },
  );
  assertEquals(normalizeBilibiliSource("newlist:188"), {
    mode: "newlist",
    rid: 188,
  });
  assertEquals(normalizeBilibiliSource("new:tech"), {
    mode: "newlist",
    rid: 188,
  });
  assertEquals(
    buildBilibiliApiUrl({ mode: "newlist", rid: 36 }, 5),
    "https://api.bilibili.com/x/web-interface/newlist?rid=36&ps=5&pn=1",
  );
  assertEquals(
    buildBilibiliApiUrl({ mode: "popular", rid: 0 }, 5),
    "https://api.bilibili.com/x/web-interface/popular?ps=5&pn=1",
  );
});

Deno.test("B站源：已下线的分区排行与 UP 主要给出可操作报错", () => {
  // ranking/region 实测返回陈旧缓存（2026-09 抓到 2025-03 的条目），故不提供
  assertThrows(() => normalizeBilibiliSource("ranking:36"), Error, "识别不出 B站源");
  assertThrows(() => normalizeBilibiliSource(""), Error, "为空");
  assertThrows(() => normalizeBilibiliSource("newlist:nope"), Error, "无法识别的分区");
  assertThrows(
    () => normalizeBilibiliSource("https://example.com/popular"),
    Error,
    "域名不是 bilibili.com",
  );
});

Deno.test("知乎源：hot / daily 与域名推断", () => {
  assertEquals(normalizeZhihuSource("hot"), { mode: "hot" });
  assertEquals(normalizeZhihuSource("https://www.zhihu.com/hot"), { mode: "hot" });
  assertEquals(normalizeZhihuSource("daily"), { mode: "daily" });
  assertEquals(normalizeZhihuSource("https://daily.zhihu.com/"), {
    mode: "daily",
  });
  assertEquals(
    buildZhihuApiUrl({ mode: "hot" }, 10),
    "https://api.zhihu.com/topstory/hot-list?limit=10",
  );
  assertEquals(
    buildZhihuApiUrl({ mode: "daily" }, 10),
    "https://news-at.zhihu.com/api/4/news/latest",
  );
  assertThrows(() => normalizeZhihuSource("https://example.com/hot"), Error, "域名不是 zhihu.com");
});

Deno.test("RSS 源：只接受 http/https 的 feed 地址", () => {
  assertEquals(
    normalizeFeedUrl(" https://www.qbitai.com/feed "),
    "https://www.qbitai.com/feed",
  );
  assertThrows(() => normalizeFeedUrl("www.qbitai.com/feed"), Error, "不是合法 URL");
  assertThrows(() => normalizeFeedUrl("file:///etc/passwd"), Error, "只支持 http/https");
  assertThrows(() => normalizeFeedUrl(""), Error, "为空");
});
