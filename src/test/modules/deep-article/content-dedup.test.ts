import { assertEquals } from "https://deno.land/std@0.221.0/assert/mod.ts";
import {
  dedupeContents,
  dedupeScrapedContents,
} from "../../../services/content-dedup.ts";
import { ScrapedContent } from "../../../modules/interfaces/scraper.interface.ts";

/**
 * 造素材。
 *
 * 默认正文与标题都从 **id** 派生：不能从 url 派生——指纹会把 url 剔掉，
 * 两个不同 url 的正文会归一化成同一串，于是「无重复」的用例会被 same-text 误判成重复。
 */
const item = (
  id: string,
  url: string,
  content = `关于「${id}」的一条独立正文，讲一件与别条不同的事，长度足够以便算出稳定的二元组指纹。`,
  title = `标题 ${id}`,
): ScrapedContent => ({
  id,
  title,
  content,
  url,
  publishDate: "2026-09-26",
  metadata: {},
});

Deno.test("真跑回归：id 重复时必须真的去重（旧写法会全部捞回来）", () => {
  // 真实数据形状：同一条推文被 twitter 与 twitter-cookie 两个源各抽一次，id 取的就是 url
  const shared = "https://x.com/someone/status/1234567890";
  const other = "https://x.com/other/status/999";
  const contents = [
    item(shared, shared),
    item(shared, shared),
    item(shared, shared),
    // 标题与正文必须显式不同：默认值从 id 派生，而 id 就是 url，
    // 指纹会把 url 剔掉，于是标题/正文归一化后与上面三条一模一样，
    // 被 same-title / same-text 规则提前吃掉，就测不到 url 规则了。
    item(other, other, "另一条推文的正文，讲的是完全不同的一件事。", "另一条推文"),
  ];

  const { kept, dropped } = dedupeScrapedContents(contents);
  assertEquals(kept.length, 2, "三条同 id 同 url 只应保留一条");
  assertEquals(dropped.length, 2);
  assertEquals(dropped.every((entry) => entry.reason === "url"), true);

  // 保留的必须是原文对象本身（id 不变），否则下游按 id 找素材会找不到
  assertEquals(kept.map((entry) => entry.id), [shared, other]);
});

Deno.test("真跑回归：按 id 过滤存活项的老写法确实会失效（说明为什么换实现）", () => {
  const shared = "https://x.com/dup/1";
  const contents = [item(shared, shared), item(shared, shared)];

  const ordered = contents.map((content, index) => ({
    id: String(content.id ?? index),
    score: 0,
  }));
  const legacy = dedupeContents(ordered, contents);
  assertEquals(legacy.kept.length, 1, "旧函数本身算出的是 1 条");

  // 但调用方若用 kept 的 id 去过滤原文，重复项的 id 与代表项相同 → 两条都会被留下
  const keptIds = new Set(legacy.kept.map((entry) => String(entry.id)));
  const naiveFilter = contents.filter((content) => keptIds.has(String(content.id)));
  assertEquals(naiveFilter.length, 2, "这就是真跑里「保留 21、送出 41」的成因");

  // 新实现按位置过滤，与 id 是否重复无关
  assertEquals(dedupeScrapedContents(contents).kept.length, 1);
});

Deno.test("不同 id 但同一 url：仍然只保留一条，保留先出现的那条", () => {
  const url = "https://example.com/a";
  const contents = [item("id-1", url), item("id-2", url)];
  const { kept, dropped } = dedupeScrapedContents(contents);
  assertEquals(kept.length, 1);
  assertEquals(kept[0].id, "id-1");
  assertEquals(dropped[0].duplicateOf, "id-1");
  assertEquals(dropped[0].reason, "url");
});

Deno.test("正文只差一个字、url 与标题都不同：走相似度规则", () => {
  // 正文要够长：指纹用的是「标题+正文」的二元组，标题不同会占掉几个二元组，
  // 正文太短时那一两个字就能把相似度压到 0.9 以下（实测 32/36 ≈ 0.889）。
  const base =
    "一份报告访谈了四十家企业，其中二十七家表示低估了数据迁移与权限改造的工时。" +
    "另一句用于把正文拉长，让标题的差异不至于把相似度压到阈值以下。";
  const contents = [
    item("a", "https://example.com/a", base, "报告 A"),
    item(
      "b",
      "https://example.com/b",
      base.replace("四十家", "五十家"),
      "报告 B",
    ),
  ];
  const { kept, dropped } = dedupeScrapedContents(contents);
  assertEquals(kept.length, 1);
  assertEquals(dropped[0].reason, "similar");
  assertEquals(typeof dropped[0].similarity, "number");
});

Deno.test("一边完整包含另一边：走 contained 规则", () => {
  const base = "一份报告访谈了四十家企业，其中二十七家表示低估了改造工时。";
  const contents = [
    item("a", "https://example.com/a", base, "报告 A"),
    item("b", "https://example.com/b", `${base}（转载自某处）`, "报告 B"),
  ];
  const { kept, dropped } = dedupeScrapedContents(contents);
  assertEquals(kept.length, 1);
  assertEquals(dropped[0].reason, "contained");
});

Deno.test("无重复时全部保留，且 dropped 为空", () => {
  const contents = [
    item("a", "https://example.com/a", "第一篇讲定价单位从按次改成按 token。"),
    item("b", "https://example.com/b", "第二篇讲开源基准测试里被调过的提示词。"),
  ];
  const { kept, dropped } = dedupeScrapedContents(contents);
  assertEquals(kept.length, 2);
  assertEquals(dropped.length, 0);
});

Deno.test("空输入与单条输入", () => {
  assertEquals(dedupeScrapedContents([]), { kept: [], dropped: [] });
  assertEquals(
    dedupeScrapedContents([item("a", "https://example.com/a")]).kept.length,
    1,
  );
});

Deno.test("id 缺失时也不误合并（按下标互不影响）", () => {
  const contents = [
    item("", "https://example.com/1", "第一条内容，讲定价单位变更。", "标题一"),
    item("", "https://example.com/2", "第二条内容，讲企业侧迁移成本。", "标题二"),
  ];
  const { kept } = dedupeScrapedContents(contents);
  assertEquals(kept.length, 2, "两条不同 url 的内容不得因为空 id 被合并");
});
