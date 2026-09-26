import { assertEquals, assertRejects } from "@std/assert";
import { JevClient, JevHttpError } from "../../../providers/system-one/jev.client.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const okBody = {
  model: "jev-1.13.0",
  answers: {
    innovation: {
      type: "score",
      score: 2,
      confidence: 0.9,
      legend: { "0": "a", "1": "b", "2": "c", "3": "d" },
      probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
    },
  },
  usage: { input_tokens: 100, output_tokens: 5 },
};

const makeStub = (handler: (call: Call, index: number) => Response) => {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(call);
    const response = handler(call, calls.length - 1);
    if (response instanceof Error) throw response;
    return Promise.resolve(response);
  }) as typeof fetch;
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { calls, sleeps, fetchImpl, sleep };
};

const clientOf = (stub: ReturnType<typeof makeStub>, overrides = {}) =>
  new JevClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-key",
    model: "jev-1.13.0",
    fetchImpl: stub.fetchImpl,
    sleep: stub.sleep,
    ...overrides,
  });

// JEV 契约按 https://api.typesafe.ai/openapi.json 钉死，这里覆盖最容易被改坏的部分。

Deno.test("jev client - 成功：POST /v1/systemone，Authorization 按请求传，body 带 model", async () => {
  const stub = makeStub(() => jsonResponse(okBody));
  const client = clientOf(stub);
  const { response, attempts } = await client.evaluate({
    state: "标题: 测试",
    questions: {
      innovation: { type: "score", criteria: ["a", "b", "c", "d"] },
    },
  });

  assertEquals(attempts, 0);
  assertEquals(response.model, "jev-1.13.0");
  assertEquals(stub.calls.length, 1);
  assertEquals(stub.calls[0].url, "https://api.example.test/v1/systemone");
  assertEquals(stub.calls[0].method, "POST");
  assertEquals(stub.calls[0].headers.Authorization, "Bearer test-key");
  const body = JSON.parse(String(stub.calls[0].body));
  assertEquals(body.model, "jev-1.13.0");
  assertEquals(body.state, "标题: 测试");
});

Deno.test("jev client - 401（key 无效）：只发一次，不重试", async () => {
  const stub = makeStub(() => jsonResponse({ detail: "invalid key" }, 401));
  const client = clientOf(stub);
  const error = await assertRejects(
    () => client.evaluate({ state: "x", questions: {} }),
    JevHttpError,
  );
  assertEquals(stub.calls.length, 1);
  assertEquals(error.status, 401);
  assertEquals(error.retryable, false);
  assertEquals(stub.sleeps.length, 0);
});

Deno.test("jev client - 402（余额不足）：只发一次，不重试", async () => {
  const stub = makeStub(() => jsonResponse({ detail: "insufficient balance" }, 402));
  const client = clientOf(stub);
  const error = await assertRejects(
    () => client.evaluate({ state: "x", questions: {} }),
    JevHttpError,
  );
  assertEquals(stub.calls.length, 1);
  assertEquals(error.status, 402);
  assertEquals(error.retryable, false);
});

Deno.test("jev client - 400（请求体不合法）：只发一次，不重试", async () => {
  const stub = makeStub(() => jsonResponse({ detail: "bad request" }, 400));
  const client = clientOf(stub);
  const error = await assertRejects(
    () => client.evaluate({ state: "x", questions: {} }),
    JevHttpError,
  );
  assertEquals(stub.calls.length, 1);
  assertEquals(error.retryable, false);
});

Deno.test("jev client - 429：读 retry-after 后重试，成功即停", async () => {
  const stub = makeStub((_call, index) =>
    index === 0
      ? jsonResponse({ detail: "rate limited" }, 429, { "retry-after": "2" })
      : jsonResponse(okBody)
  );
  const client = clientOf(stub);
  const { attempts } = await client.evaluate({ state: "x", questions: {} });
  assertEquals(stub.calls.length, 2);
  assertEquals(attempts, 1);
  // retry-after: 2 秒 → 等 2000ms，不是指数退避的 1000ms
  assertEquals(stub.sleeps, [2000]);
});

Deno.test("jev client - 5xx：指数退避重试到上限后失败（连带首次共 4 次请求）", async () => {
  const stub = makeStub(() => jsonResponse({ detail: "boom" }, 503));
  const client = clientOf(stub);
  const error = await assertRejects(
    () => client.evaluate({ state: "x", questions: {} }),
    JevHttpError,
  );
  assertEquals(stub.calls.length, 4); // 首次 + 3 次重试
  assertEquals(stub.sleeps, [1000, 2000, 4000]);
  assertEquals(error.status, 503);
  assertEquals(error.retryable, true);
});

Deno.test("jev client - retry-after 过大：立即失败，不拖垮 5 分钟的 step", async () => {
  const stub = makeStub(() => jsonResponse({ detail: "slow down" }, 429, { "retry-after": "600" }));
  const client = clientOf(stub);
  const error = await assertRejects(
    () => client.evaluate({ state: "x", questions: {} }),
    JevHttpError,
  );
  assertEquals(stub.calls.length, 1);
  assertEquals(error.retryable, false);
});

Deno.test("jev client - 网络异常/超时：按可重试处理", async () => {
  const stub = makeStub((_call, index) => {
    if (index < 2) {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      return abort as unknown as Response;
    }
    return jsonResponse(okBody);
  });
  const client = clientOf(stub);
  const { attempts } = await client.evaluate({ state: "x", questions: {} });
  assertEquals(stub.calls.length, 3);
  assertEquals(attempts, 2);
});

Deno.test("jev client - 响应不是 JSON 或缺 answers：非重试失败，一次即止", async () => {
  const stub = makeStub(() => new Response("<html>challenge</html>", { status: 200 }));
  const client = clientOf(stub);
  const error = await assertRejects(
    () => client.evaluate({ state: "x", questions: {} }),
    JevHttpError,
  );
  assertEquals(stub.calls.length, 1);
  assertEquals(error.retryable, false);
});

Deno.test("jev client - 缺 apiKey 时构造即失败（不允许静默匿名调用）", () => {
  let threw = false;
  try {
    new JevClient({ baseUrl: "https://x.test", apiKey: "", model: "m" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("jev client - listModels：用 GET 打通鉴权自检，不发送素材", async () => {
  const stub = makeStub(() => jsonResponse([{ name: "jev-1.13.0" }]));
  const client = clientOf(stub);
  const models = await client.listModels();
  assertEquals(models[0].name, "jev-1.13.0");
  assertEquals(stub.calls[0].method, "GET");
  assertEquals(stub.calls[0].url, "https://api.example.test/v1/models");
});
