import { assertEquals } from "@std/assert";
import { JevContentRanker } from "../../../modules/content-rank/jev.content-ranker.ts";
import { JevClient, JevHttpError } from "../../../providers/system-one/jev.client.ts";
import { CRITERIA, DIMENSION_KEYS } from "../../../prompts/content-ranker.rubric.ts";
import { ScrapedContent } from "../../../modules/interfaces/scraper.interface.ts";
import { SystemOneResponse } from "../../../providers/interfaces/system-one.interface.ts";

/** criterion 档位数：4 档 → 归一化分母 3 */
const LEVELS = CRITERIA.innovation.length;
const MAX_LEVEL = LEVELS - 1;

const scoreAnswer = (score: number, confidence = 0.8) => ({
  type: "score" as const,
  score,
  confidence,
  legend: Object.fromEntries(
    CRITERIA.innovation.map((text, i) => [String(i), text]),
  ),
  probabilities: { "0": 0.2, "1": 0.2, "2": 0.3, "3": 0.3 },
});

/** 4 个维度同一档位 */
const answersAt = (level: number, confidence = 0.8): SystemOneResponse => ({
  model: "jev-1.13.0",
  answers: Object.fromEntries(
    DIMENSION_KEYS.map((key) => [key, scoreAnswer(level, confidence)]),
  ),
  usage: { input_tokens: 100, output_tokens: 5 },
});

const content = (
  overrides: Partial<ScrapedContent> & { id: string },
): ScrapedContent => ({
  title: `标题 ${overrides.id}`,
  content: "正文内容",
  url: `https://example.test/${overrides.id}`,
  publishDate: "2026-09-27",
  metadata: {},
  ...overrides,
});

/** 只实现 evaluate 的假客户端 */
class FakeClient {
  public calls: Array<{ state: string; questionKeys: string[] }> = [];
  constructor(
    private readonly handler: (
      state: string,
      index: number,
    ) => SystemOneResponse | Error,
  ) {}
  evaluate(request: {
    state: string;
    questions: Record<string, unknown>;
  }) {
    const index = this.calls.length;
    this.calls.push({
      state: String(request.state),
      questionKeys: Object.keys(request.questions),
    });
    const result = this.handler(String(request.state), index);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({ response: result, attempts: 0, durationMs: 1 });
  }
}

const rankerWith = (
  handler: (state: string, index: number) => SystemOneResponse | Error,
  options: { concurrency?: number } = {},
) => {
  const fake = new FakeClient(handler);
  const ranker = new JevContentRanker(fake as unknown as JevClient, options);
  return { ranker, fake };
};

Deno.test("jev ranker - 满分素材：四个维度都在最高档 → 100 分（含图也封顶 100）", async () => {
  const { ranker } = rankerWith(() => answersAt(MAX_LEVEL));
  const results = await ranker.rankContents([
    content({ id: "a", media: [{ url: "https://x.test/1.png", type: "image", size: { width: 1, height: 1 } }] }),
  ]);
  assertEquals(results.length, 1);
  assertEquals(results[0].score, 100);
  assertEquals(results[0].engine, "JEV");
  assertEquals(results[0].detail?.imageBonus, 10);
  assertEquals(results[0].detail?.dims.utility.normalized, 1);
  assertEquals(Math.round((results[0].confidence ?? 0) * 100) / 100, 0.8);
});

Deno.test("jev ranker - 只有实用价值满分：按 45 权重得 45 分", async () => {
  const { ranker } = rankerWith(() => ({
    model: "jev-1.13.0",
    answers: {
      innovation: scoreAnswer(0),
      utility: scoreAnswer(MAX_LEVEL),
      influence: scoreAnswer(0),
      freshness: scoreAnswer(0),
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const results = await ranker.rankContents([content({ id: "a" })]);
  assertEquals(results[0].score, 45);
  assertEquals(results[0].detail?.imageBonus, 0);
});

Deno.test("jev ranker - 含图且非满分：在合成分上补 10 分", async () => {
  const { ranker } = rankerWith(() => answersAt(0));
  const results = await ranker.rankContents([
    content({ id: "a", media: [{ url: "x", type: "image", size: { width: 1, height: 1 } }] }),
  ]);
  assertEquals(results[0].score, 10);
});

Deno.test("jev ranker - 单篇失败不抛异常：缺席交给工作流的「漏评补 0」兜底", async () => {
  const { ranker } = rankerWith((state) => {
    if (state.includes("b")) {
      return new JevHttpError("Jev 返回 401", { status: 401, retryable: false });
    }
    return answersAt(MAX_LEVEL);
  });
  const results = await ranker.rankContents([
    content({ id: "a" }),
    content({ id: "b" }),
    content({ id: "c" }),
  ]);
  assertEquals(results.map((r) => r.id), ["a", "c"]);
  const failures = ranker.getLastRunFailures();
  assertEquals(failures.total, 3);
  assertEquals(failures.succeeded, 2);
  assertEquals(failures.failures.length, 1);
  assertEquals(failures.failures[0].id, "b");
});

Deno.test("jev ranker - 返回类型不是 score（例如 noul）也按失败处理", async () => {
  const { ranker } = rankerWith(() => ({
    model: "jev-1.13.0",
    answers: {
      innovation: { type: "noul", noul: 0.9 },
      utility: scoreAnswer(1),
      influence: scoreAnswer(1),
      freshness: scoreAnswer(1),
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const results = await ranker.rankContents([content({ id: "a" })]);
  assertEquals(results.length, 0);
  assertEquals(ranker.getLastRunFailures().failures.length, 1);
});

Deno.test("jev ranker - 结果顺序跟输入一致（并发不改变顺序）", async () => {
  const { ranker } = rankerWith((state) => answersAt(state.includes("c") ? MAX_LEVEL : 0), {
    concurrency: 3,
  });
  const results = await ranker.rankContents([
    content({ id: "a" }),
    content({ id: "b" }),
    content({ id: "c" }),
    content({ id: "d" }),
  ]);
  assertEquals(results.map((r) => r.id), ["a", "b", "c", "d"]);
  // 分数确实随内容不同（c 满分、其余 0），说明没串行复用同一结果
  assertEquals(results.map((r) => r.score), [0, 0, 100, 0]);
});

Deno.test("jev ranker - 问题结构：4 个 score 问题，各带自己的档位，一次请求共用 state", async () => {
  const { ranker, fake } = rankerWith(() => answersAt(1));
  await ranker.rankContents([content({ id: "a" })]);
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0].questionKeys, [...DIMENSION_KEYS]);

  const questions = ranker.buildQuestions();
  for (const key of DIMENSION_KEYS) {
    const question = questions[key] as { type: string; criteria: string[] };
    assertEquals(question.type, "score");
    assertEquals(question.criteria.length, CRITERIA[key].length);
  }
});

Deno.test("jev ranker - 送入的 state 只含判定所需字段，且正文截断", async () => {
  const { ranker, fake } = rankerWith(() => answersAt(1));
  const long = content({ id: "a", content: "字".repeat(50000) });
  await ranker.rankContents([long]);
  const state = fake.calls[0].state;
  assertEquals(state.includes("标题: "), true);
  assertEquals(state.includes("发布时间: 2026-09-27"), true);
  assertEquals(state.includes("https://example.test/a"), false); // 不带 url
  if (state.length > 12000 + 200) {
    throw new Error(`state 未截断，长度 ${state.length}`);
  }
});

Deno.test("jev ranker - 空输入不发请求", async () => {
  const { ranker, fake } = rankerWith(() => answersAt(1));
  assertEquals(await ranker.rankContents([]), []);
  assertEquals(fake.calls.length, 0);
});

Deno.test("jev ranker - 关键词不参与 Jev 打分（一期约定），仅由代码层兜", async () => {
  const { ranker, fake } = rankerWith(() => answersAt(MAX_LEVEL));
  const results = await ranker.rankContents([content({ id: "a" })], ["GEO", "生成式引擎优化"]);
  assertEquals(fake.calls[0].state.includes("GEO"), false);
  assertEquals(results[0].score, 100);
});
