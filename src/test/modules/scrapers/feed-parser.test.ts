import { assertEquals, assertThrows } from "@std/assert";
import {
  detectFeedFormat,
  parseFeed,
} from "../../../modules/scrapers/feed-parser.ts";

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>量子位</title>
    <link>https://www.qbitai.com</link>
    <item>
      <title><![CDATA[世界模型成为新叙事]]></title>
      <link>https://www.qbitai.com/2026/09/498478.html</link>
      <description><![CDATA[<p>具身智能跨越商业化的奇点。</p>]]></description>
      <content:encoded><![CDATA[<p>正文第一段。</p><p>正文第二段。</p>]]></content:encoded>
      <pubDate>Sat, 26 Sep 2026 19:49:43 +0800</pubDate>
      <guid>https://www.qbitai.com/2026/09/498478.html</guid>
      <dc:creator>量子位</dc:creator>
    </item>
    <item>
      <title>AT&amp;T 与 5G</title>
      <link>https://example.com/att</link>
      <description>含实体的标题 &lt;测试&gt;</description>
      <pubDate>Sun, 27 Sep 2026 01:02:03 +0800</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>r/OpenAI</title>
  <link rel="self" href="https://www.reddit.com/r/OpenAI/hot/.rss"/>
  <entry>
    <title>Introducing ChatGPT for Financial Services</title>
    <link rel="alternate" href="https://www.reddit.com/r/OpenAI/comments/1wcsciq/introducing/"/>
    <content type="html">&lt;table&gt;&lt;tr&gt;&lt;td&gt; submitted by /u/MatricesRL &lt;a href="https://openai.com/index/introducing-chatgpt-financial-services/"&gt;[link]&lt;/a&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>
    <updated>2026-09-11T02:58:47+00:00</updated>
    <id>t3_1wcsciq</id>
  </entry>
</feed>`;

Deno.test("parseFeed - 解析 RSS 2.0（CDATA / 实体 / content:encoded）", () => {
  assertEquals(detectFeedFormat(RSS_SAMPLE), "rss");
  const feed = parseFeed(RSS_SAMPLE);
  assertEquals(feed.feedTitle, "量子位");
  assertEquals(feed.items.length, 2);
  assertEquals(feed.items[0].title, "世界模型成为新叙事");
  assertEquals(feed.items[0].link, "https://www.qbitai.com/2026/09/498478.html");
  assertEquals(feed.items[0].contentHtml, "<p>正文第一段。</p><p>正文第二段。</p>");
  assertEquals(feed.items[0].author, "量子位");
  // CDATA 里的实体不再二次解码，`&amp;` 只在最后一步还原
  assertEquals(feed.items[1].title, "AT&T 与 5G");
  assertEquals(feed.items[1].summaryHtml, "含实体的标题 <测试>");
});

Deno.test("parseFeed - 解析 Atom（link rel=alternate / id 作为 guid）", () => {
  assertEquals(detectFeedFormat(ATOM_SAMPLE), "atom");
  const feed = parseFeed(ATOM_SAMPLE);
  assertEquals(feed.feedTitle, "r/OpenAI");
  // feed 级链接要拿 rel=self 之外的那个 href，不能把 self 地址当条目链接
  assertEquals(feed.items.length, 1);
  assertEquals(
    feed.items[0].link,
    "https://www.reddit.com/r/OpenAI/comments/1wcsciq/introducing/",
  );
  assertEquals(feed.items[0].guid, "t3_1wcsciq");
  assertEquals(feed.items[0].publishedAt, "2026-09-11T02:58:47+00:00");
  // content 是转义过的 HTML，解析层原样交回，由采集器决定怎么转纯文本
  assertEquals(feed.items[0].contentHtml.includes("openai.com"), true);
});

Deno.test("parseFeed - 反爬页/网页必须报错而不是当成空 feed", () => {
  assertEquals(detectFeedFormat("<!DOCTYPE html><html><body>challenge</body></html>"), null);
  assertThrows(
    () => parseFeed("<!DOCTYPE html><html></html>"),
    Error,
    "不是 RSS/Atom feed",
  );
});

Deno.test("parseFeed - limit 生效且只截取前 N 条", () => {
  const feed = parseFeed(RSS_SAMPLE, 1);
  assertEquals(feed.items.length, 1);
  assertEquals(feed.items[0].title, "世界模型成为新叙事");
});
