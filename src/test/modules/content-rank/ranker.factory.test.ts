import { assertEquals, assertRejects } from "@std/assert";
import {
  FallbackRanker,
  resolveRankerEngine,
  toBoolean,
  toNumber,
} from "../../../modules/content-rank/ranker.factory.ts";
import {
  RankerLike,
  RankResult,
} from "../../../modules/interfaces/content-ranker.interface.ts";
import { ScrapedContent } from "../../../modules/interfaces/scraper.interface.ts";

const contents = (n: number): ScrapedContent[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    title: `t${i}`,
    content: "c",
    url: `https://example.test/${i}`,
    publishDate: "2026-09-27",
    metadata: {},
  }));

const results = (ids: string[]): RankResult[] =>
  ids.map((id, i) => ({ id, score: 100 - i }));

const stubRanker = (impl: () => Promise<RankResult[]>) => {
  const calls: { keywords?: string[]; count: number }[] = [];
  const ranker: RankerLike = {
    rankContents: (_contents, keywords) => {
      calls.push({ keywords, count: _contents.length });
      return impl();
    },
  };
  return { ranker, calls };
};

Deno.test("factory - 引擎判定：缺失/写错一律回 LLM，只有显式 JEV 才切", () => {
  assertEquals(resolveRankerEngine(undefined), "LLM");
  assertEquals(resolveRankerEngine(null), "LLM");
  assertEquals(resolveRankerEngine(""), "LLM");
  assertEquals(resolveRankerEngine("llm"), "LLM");
  assertEquals(resolveRankerEngine("JEV "), "JEV");
  assertEquals(resolveRankerEngine("jev"), "JEV");
  // 拼错不能静默启用新引擎
  assertEquals(resolveRankerEngine("JEVV"), "LLM");
  assertEquals(resolveRankerEngine(true), "LLM");
});

Deno.test("factory - 配置解析：非法值走默认值，不抛错", () => {
  assertEquals(toNumber(undefined, 5), 5);
  assertEquals(toNumber("", 5), 5);
  assertEquals(toNumber("abc", 5), 5);
  assertEquals(toNumber("0.9", 5), 0.9);
  assertEquals(toBoolean(undefined, true), true);
  assertEquals(toBoolean("false", true), false);
  assertEquals(toBoolean("0", true), false);
  assertEquals(toBoolean("TRUE", false), true);
  assertEquals(toBoolean("随便写", true), true);
});

Deno.test("factory - 成功率达标：用 JEV 结果，缺失条目不做二次补 0", async () => {
  const primary = stubRanker(() => Promise.resolve(results(["id-0", "id-1"])));
  const fallback = stubRanker(() => Promise.resolve(results(["id-0", "id-1", "id-2"])));
  const ranker = new FallbackRanker(
    primary.ranker,
    fallback.ranker,
    0.5,
    true,
  );
  const out = await ranker.rankContents(contents(4), ["k"]);
  assertEquals(out.map((r) => r.id), ["id-0", "id-1"]);
  assertEquals(fallback.calls.length, 0);
  assertEquals(primary.calls[0].keywords, ["k"]);
});

Deno.test("factory - 成功率低于阈值：整批丢弃并回落 LLM（关键词照传）", async () => {
  const primary = stubRanker(() => Promise.resolve(results(["id-0"])));
  const fallback = stubRanker(() => Promise.resolve(results(["id-0", "id-1", "id-2", "id-3"])));
  const ranker = new FallbackRanker(primary.ranker, fallback.ranker, 0.9, true);
  const out = await ranker.rankContents(contents(4), ["GEO"]);
  assertEquals(out.length, 4);
  assertEquals(fallback.calls.length, 1);
  assertEquals(fallback.calls[0].keywords, ["GEO"]);
  assertEquals(fallback.calls[0].count, 4);
});

Deno.test("factory - 主引擎抛异常：回落 LLM", async () => {
  const primary = stubRanker(() => Promise.reject(new Error("Jev 返回 402（余额不足）")));
  const fallback = stubRanker(() => Promise.resolve(results(["id-0"])));
  const ranker = new FallbackRanker(primary.ranker, fallback.ranker, 0.9, true);
  const out = await ranker.rankContents(contents(1));
  assertEquals(out.length, 1);
  assertEquals(fallback.calls.length, 1);
});

Deno.test("factory - 关闭回落时：失败必须显式抛错，不静默降级", async () => {
  const primary = stubRanker(() => Promise.resolve([]));
  const fallback = stubRanker(() => Promise.resolve(results(["id-0"])));
  const ranker = new FallbackRanker(primary.ranker, fallback.ranker, 0.9, false);
  await assertRejects(
    () => ranker.rankContents(contents(2)),
    Error,
    "JEV_FALLBACK_TO_LLM=false",
  );
  assertEquals(fallback.calls.length, 0);
});

Deno.test("factory - 空输入不发请求", async () => {
  const primary = stubRanker(() => Promise.resolve([]));
  const fallback = stubRanker(() => Promise.resolve([]));
  const ranker = new FallbackRanker(primary.ranker, fallback.ranker, 0.9, true);
  assertEquals(await ranker.rankContents([]), []);
  assertEquals(primary.calls.length, 0);
});
