import { assertEquals } from "https://deno.land/std@0.221.0/assert/mod.ts";
import {
  asArray,
  asRecord,
  clampScore,
  hasContent,
  LlmJsonError,
  parseLooseJson,
  toText,
  toStringArray,
} from "../../../modules/deep-article/llm-json.ts";
import { reconcileLlmPrivacyHits } from "../../../modules/deep-article/privacy.ts";
import { normalizeParagraphMarkers } from "../../../services/weixin-deep-article.workflow.ts";

Deno.test("parseLooseJson：剥代码围栏、取首个 JSON 块", () => {
  assertEquals(parseLooseJson<{ a: number }>("```json\n{\"a\":1}\n```").a, 1);
  assertEquals(parseLooseJson<{ a: number }>("好的：\n{\"a\":2}\n以上。").a, 2);
  assertEquals(parseLooseJson<number[]>("[1,2,3]").length, 3);
});

Deno.test("parseLooseJson：不是 JSON 时报错且带上原文片段", () => {
  let message = "";
  try {
    parseLooseJson("这不是 JSON", "第 3 步");
  } catch (error) {
    assertEquals(error instanceof LlmJsonError, true);
    message = (error as Error).message;
  }
  assertEquals(message.includes("第 3 步"), true);
  assertEquals(message.includes("这不是 JSON"), true);
});

Deno.test("toText：对象与数组一律走兜底，不产生 [object Object]", () => {
  assertEquals(toText("  你好  "), "你好");
  assertEquals(toText(42), "42");
  assertEquals(toText(true), "true");
  assertEquals(toText({ paragraphs: ["a"] }), "", "对象不得被 String() 成 [object Object]");
  assertEquals(toText(["a", "b"]), "");
  assertEquals(toText({}, "兜底"), "兜底");
  assertEquals(toText(null, "兜底"), "兜底");
  assertEquals(toText(Number.NaN, "兜底"), "兜底");
  assertEquals(toText(undefined), "");
});

Deno.test("asRecord / asArray：非目标类型时收成空值而不是抛错", () => {
  assertEquals(asRecord({ a: 1 }), { a: 1 });
  assertEquals(asRecord([1, 2]), {});
  assertEquals(asRecord("x"), {});
  assertEquals(asRecord(null), {});
  assertEquals(asRecord(undefined), {});

  assertEquals(asArray<number>([1, 2]), [1, 2]);
  assertEquals(asArray("x"), []);
  assertEquals(asArray({ a: 1 }), []);
  assertEquals(asArray(undefined), []);
});

Deno.test("hasContent：空对象、空数组、空串都算空", () => {
  assertEquals(hasContent({}), false);
  assertEquals(hasContent({ a: "" }), false);
  assertEquals(hasContent({ a: "  " }), false);
  assertEquals(hasContent({ a: [] }), false);
  assertEquals(hasContent({ a: null }), false);
  assertEquals(hasContent({ a: {} }), false);
  assertEquals(hasContent({ a: "x" }), true);
  assertEquals(hasContent({ a: [1] }), true);
  assertEquals(hasContent({ a: { b: "x" } }), true);
  assertEquals(hasContent({ a: 0 }), true, "数字 0 是有内容的字段");
});

Deno.test("clampScore：边界与非法值", () => {
  assertEquals(clampScore(0, 20), 0);
  assertEquals(clampScore(20, 20), 20);
  assertEquals(clampScore(20.1, 20), 20);
  assertEquals(clampScore("12.34", 20), 12.3);
  assertEquals(clampScore({}, 20), 0);
  assertEquals(clampScore([], 20), 0);
});

Deno.test("toStringArray：非字符串项与空项都被剔掉", () => {
  assertEquals(toStringArray([" a ", "", "  ", "b"]), ["a", "b"]);
  assertEquals(toStringArray("单条"), ["单条"]);
  assertEquals(toStringArray(null), []);
  assertEquals(toStringArray({ a: 1 }), []);
  assertEquals(toStringArray([null, undefined, 1]), ["1"]);
});

Deno.test("模型层隐私命中：只有正文里确实出现的才算数", () => {
  const content = "我朋友张三上个月遇到过同样的问题。";
  const hits = reconcileLlmPrivacyHits(
    [
      { category: "家人姓名", text: "我朋友张三" },
      { category: "幻觉项", text: "我儿子某某" },
      "我朋友张三",
      { category: "过短", text: "我" },
      { category: "没有文本字段" },
    ],
    content,
  );
  assertEquals(hits.length, 2, "两项文本确实在正文里、且长度足够");
  assertEquals(hits.map((hit) => hit.text), ["我朋友张三", "我朋友张三"]);
});

Deno.test("模型层隐私命中：非数组输入返回空数组，不抛错", () => {
  assertEquals(reconcileLlmPrivacyHits("未发现", "正文"), []);
  assertEquals(reconcileLlmPrivacyHits(null, "正文"), []);
  assertEquals(reconcileLlmPrivacyHits(undefined, "正文"), []);
  assertEquals(reconcileLlmPrivacyHits({ a: 1 }, "正文"), []);
  assertEquals(reconcileLlmPrivacyHits([], ""), []);
});

Deno.test("段落标记归一化：容忍模型写出的各种变体", () => {
  assertEquals(
    normalizeParagraphMarkers("a<next_paragraph/>b"),
    "a<next_paragraph />b",
  );
  assertEquals(
    normalizeParagraphMarkers("a<NEXT_PARAGRAPH />b"),
    "a<next_paragraph />b",
  );
  assertEquals(
    normalizeParagraphMarkers("a< next_paragraph / >b"),
    "a<next_paragraph />b",
  );
  assertEquals(
    normalizeParagraphMarkers("a</next_paragraph>b"),
    "a<next_paragraph />b",
  );
  assertEquals(
    normalizeParagraphMarkers("a<next_paragraph />b"),
    "a<next_paragraph />b",
    "已经正确的形式不得被改坏",
  );
  assertEquals(normalizeParagraphMarkers(""), "");
});
