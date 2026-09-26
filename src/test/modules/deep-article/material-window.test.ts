import { assertEquals } from "@std/assert";
import {
  DEFAULT_MAX_AGE_DAYS,
  filterByAgeWindow,
  parsePublishDate,
} from "../../../modules/deep-article/material-date.ts";
import {
  extractLinks,
  hasFetchableCandidateLink,
  isFetchableCandidateLink,
  pickSupplementLinks,
} from "../../../modules/deep-article/source-link.ts";
import { ScrapedContent } from "../../../modules/interfaces/scraper.interface.ts";

const at = (publishDate: string): ScrapedContent => ({
  id: publishDate,
  title: `标题 ${publishDate}`,
  content: "正文",
  url: "https://example.com/x",
  publishDate,
  metadata: {},
});

Deno.test("日期解析：认得各 scraper 写出的 YYYY/MM/DD HH:mm:ss", () => {
  const date = parsePublishDate("2026/09/26 01:00:00");
  assertEquals(date?.getFullYear(), 2026);
  assertEquals(date?.getMonth(), 8);
  assertEquals(date?.getDate(), 26);
  assertEquals(date?.getHours(), 1);

  assertEquals(parsePublishDate("2026/09/26")?.getDate(), 26);
  assertEquals(parsePublishDate("2026-09-26 01:00:00")?.getDate(), 26);
  assertEquals(
    parsePublishDate("2026-09-26 01:00:00.123")?.getMilliseconds(),
    123,
  );
  assertEquals(parsePublishDate("2026-09-26T01:00:00Z")?.getUTCDate(), 26);
  assertEquals(
    parsePublishDate("2026-09-26T01:00:00Z")?.toISOString(),
    "2026-09-26T01:00:00.000Z",
    "带时区的时间戳必须按 UTC 解析，不能被当成本地时间",
  );
});

Deno.test("日期解析：缺失与非法一律返回 null，不猜", () => {
  assertEquals(parsePublishDate(""), null);
  assertEquals(parsePublishDate(null), null);
  assertEquals(parsePublishDate(undefined), null);
  assertEquals(parsePublishDate("不是日期"), null);
  assertEquals(
    parsePublishDate("2026/09/26 01:00:00 unknown"),
    null,
    "合法日期前缀后的垃圾字符不能被静默吞掉",
  );
  assertEquals(parsePublishDate("2026/13/45"), null, "月份 13 不是合法日期");
  assertEquals(
    parsePublishDate("2026/09/26 01:99:00"),
    null,
    "分钟 99 不是合法时间",
  );
  assertEquals(
    parsePublishDate("2026/09/26 01:00:99"),
    null,
    "秒 99 不是合法时间",
  );
});

Deno.test("时效窗口：真跑实测的那条一年前推文必须被筛掉", () => {
  const now = new Date(2026, 8, 26, 12, 0, 0); // 2026-09-26
  const contents = [
    at("2026/09/26 08:00:00"), // 今天
    at("2026/09/23 02:14:02"), // 3 天前
    at("2025/09/10 23:59:42"), // 381 天前 ← 被选中的那条 MCP 推文
    at("2023/12/15 02:17:41"), // 三年前
  ];
  const result = filterByAgeWindow(contents, { maxAgeDays: 180, now });

  assertEquals(result.kept.length, 2);
  assertEquals(result.expired.length, 2);
  assertEquals(result.expired.map((item) => item.ageDays), [381, 1017]);
  assertEquals(result.undated.length, 0);
});

Deno.test("时效窗口：默认 180 天（约 6 个月）", () => {
  assertEquals(DEFAULT_MAX_AGE_DAYS, 180);
  const now = new Date(2026, 8, 26, 12, 0, 0);
  // 179 天前保留，181 天前筛掉
  assertEquals(
    filterByAgeWindow([at("2026/03/31 12:00:00")], { now }).kept.length,
    1,
  );
  assertEquals(
    filterByAgeWindow([at("2026/03/28 12:00:00")], { now }).expired.length,
    1,
  );
});

Deno.test("时效窗口：刚超过 180 天显示为 181 天，避免审计矛盾", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");
  const justExpired = new Date(
    now.getTime() - (180 * 86_400_000 + 3_600_000),
  ).toISOString();
  const result = filterByAgeWindow([at(justExpired)], {
    maxAgeDays: 180,
    now,
  });
  assertEquals(result.expired.length, 1);
  assertEquals(result.expired[0].ageDays, 181);
});

Deno.test("时效窗口：日期缺失按保留处理，但计入 undated", () => {
  const result = filterByAgeWindow([at(""), at("不是日期")], {
    maxAgeDays: 180,
  });
  assertEquals(result.kept.length, 2, "未知不能当成过期");
  assertEquals(result.expired.length, 0);
  assertEquals(result.undated.length, 2);
});

Deno.test("时效窗口：未来日期不被当成过期", () => {
  const now = new Date(2026, 8, 26, 12, 0, 0);
  const result = filterByAgeWindow([at("2026/12/31 00:00:00")], {
    maxAgeDays: 180,
    now,
  });
  assertEquals(result.kept.length, 1);
  assertEquals(result.expired.length, 0);
});

Deno.test("补料候选链接：社交平台与静态资源不能直接抓", () => {
  assertEquals(
    isFetchableCandidateLink("https://openai.com/index/gpt-5/"),
    true,
  );
  assertEquals(isFetchableCandidateLink("https://github.com/o/r"), true);
  assertEquals(
    isFetchableCandidateLink("https://arxiv.org/abs/1234.5678"),
    true,
  );

  assertEquals(
    isFetchableCandidateLink("https://x.com/OpenAIDevs/status/123"),
    false,
  );
  assertEquals(isFetchableCandidateLink("https://t.co/abc"), false);
  assertEquals(isFetchableCandidateLink("https://weibo.com/1/2"), false);
  assertEquals(
    isFetchableCandidateLink("https://cdn.example.com/a.png"),
    false,
  );
  assertEquals(isFetchableCandidateLink("ftp://example.com/a"), false);
  assertEquals(isFetchableCandidateLink(""), false);
  assertEquals(isFetchableCandidateLink(undefined), false);
  assertEquals(isFetchableCandidateLink("不是链接"), false);

  assertEquals(
    hasFetchableCandidateLink(["https://x.com/a", "https://openai.com/b"]),
    true,
  );
  assertEquals(hasFetchableCandidateLink(["https://x.com/a"]), false);
  assertEquals(hasFetchableCandidateLink([]), false);
});

Deno.test("链接提取：去掉尾随标点、按出现顺序去重", () => {
  assertEquals(
    extractLinks("see https://openai.com/a. and https://openai.com/b，"),
    ["https://openai.com/a", "https://openai.com/b"],
  );
  assertEquals(extractLinks("https://a.com/x https://a.com/x"), [
    "https://a.com/x",
  ]);
  assertEquals(extractLinks("没有链接"), []);
  assertEquals(extractLinks(null), []);
});

Deno.test("链接提取：修复 X innerText 把 URL 拆成多行", () => {
  assertEquals(
    extractLinks([
      "https://",
      "github.com/GEO-SEO/geo-co",
      "ntent-writer",
      "…",
    ].join("\n")),
    ["https://github.com/GEO-SEO/geo-content-writer"],
  );
  assertEquals(
    extractLinks([
      "1、资料一",
      "https://",
      "doc.laoyao.cn/9fl0bc",
      "2、《资料二》",
      "https://",
      "doc.laoyao.cn/t754wa",
    ].join("\n")),
    ["https://doc.laoyao.cn/9fl0bc", "https://doc.laoyao.cn/t754wa"],
    "不得把下一条中文列表标题拼进 URL",
  );
  assertEquals(
    extractLinks([
      "https://",
      "growth-hackers.net/generative-eng",
      "ine-optimization-services-how-pick-best-geo-service-provider/?ref=quuu",
      "…",
    ].join("\n")),
    [
      "https://growth-hackers.net/generative-engine-optimization-services-how-pick-best-geo-service-provider/?ref=quuu",
    ],
  );
});

Deno.test("补料候选：素材自身 url 优先，排除社交平台与已抓过的", () => {
  const picked = pickSupplementLinks(
    [
      {
        url: "https://x.com/o/status/1",
        content: "正文 https://openai.com/docs",
      },
      {
        url: "https://example.com/notice",
        content: "见 https://github.com/o/r",
      },
    ],
    { limit: 3 },
  );
  assertEquals(picked, [
    "https://openai.com/docs",
    "https://example.com/notice",
    "https://github.com/o/r",
  ]);
});

Deno.test("补料候选：limit 与 exclude 生效", () => {
  const materials = [
    { url: "https://a.com/1", content: "" },
    { url: "https://a.com/2", content: "" },
    { url: "https://a.com/3", content: "" },
  ];
  assertEquals(pickSupplementLinks(materials, { limit: 2 }).length, 2);
  assertEquals(
    pickSupplementLinks(materials, { limit: 3, exclude: ["https://a.com/2"] }),
    ["https://a.com/1", "https://a.com/3"],
  );
  assertEquals(pickSupplementLinks([], { limit: 3 }), []);
});
