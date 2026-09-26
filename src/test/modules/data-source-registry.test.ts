import { assertEquals, assertExists } from "@std/assert";
import {
  applyDataSourcePreferences,
  deleteDataSourcePreference,
  makeDataSourceKey,
  normalizeDataSource,
  readDataSourcePreferences,
  validateDataSource,
} from "../../services/data-source-registry.ts";

Deno.test("data source registry validates and normalizes source input", () => {
  assertEquals(
    normalizeDataSource(" Twitter ", " https://x.com/example "),
    { platform: "twitter", identifier: "https://x.com/example" },
  );
  assertEquals(normalizeDataSource("unknown", "https://example.com"), null);
  assertEquals(normalizeDataSource("firecrawl", "not-a-url"), null);
  assertEquals(normalizeDataSource("firecrawl", "file:///tmp/example"), null);
});

Deno.test("data source registry - 新增类型：RSS 必须是地址，reddit/B站/知乎 可用关键字", () => {
  // RSS 只接受可抓取的 feed 地址
  assertEquals(
    normalizeDataSource("rss", "https://www.qbitai.com/feed"),
    { platform: "rss", identifier: "https://www.qbitai.com/feed" },
  );
  assertEquals(normalizeDataSource("rss", "qbitai"), null);

  // 这三类的标识由采集器自己拼成接口地址，不能强迫用户填 URL
  assertEquals(normalizeDataSource("reddit", "r/OpenAI"), {
    platform: "reddit",
    identifier: "r/OpenAI",
  });
  assertEquals(normalizeDataSource("bilibili", "popular"), {
    platform: "bilibili",
    identifier: "popular",
  });
  assertEquals(normalizeDataSource("bilibili", "newlist:188"), {
    platform: "bilibili",
    identifier: "newlist:188",
  });
  assertEquals(normalizeDataSource("zhihu", "hot"), {
    platform: "zhihu",
    identifier: "hot",
  });

  // 关键字标识要拦住带空格/非法字符的输入，否则会拼出坏 URL
  assertEquals(normalizeDataSource("reddit", "r/Open AI"), null);
  assertEquals(normalizeDataSource("zhihu", "hot daily"), null);
});

Deno.test("data source registry - 校验失败时给出可读原因", () => {
  assertEquals(validateDataSource("", "x").reason, "未选择采集类型");
  assertEquals(validateDataSource("rss", "  ").reason, "采集源地址为空");
  assertEquals(
    validateDataSource("unknown", "https://example.com").reason,
    "不支持的采集类型：unknown",
  );
  // 平台与地址格式的错要分开说，否则用户不知道改哪个字段
  assertEquals(
    validateDataSource("rss", "qbitai").reason,
    "rss 需要 http/https 地址（当前填的是：qbitai）",
  );
  assertEquals(validateDataSource("reddit", "r/OpenAI").reason, "");
});

Deno.test("data source preferences merge custom sources and hide deleted sources", () => {
  const base = {
    firecrawl: [{ identifier: "https://example.com/default" }],
    twitter: [{ identifier: "https://x.com/default" }],
  };
  const result = applyDataSourcePreferences(base, {
    customDataSources: [
      { platform: "firecrawl", identifier: "https://example.com/custom" },
      { platform: "firecrawl", identifier: "https://example.com/custom" },
    ],
    deletedDataSources: [
      makeDataSourceKey("twitter", "https://x.com/default"),
    ],
  });

  assertEquals(result.firecrawl, [
    { identifier: "https://example.com/default" },
    { identifier: "https://example.com/custom" },
  ]);
  assertEquals(result.twitter, []);
});

Deno.test("data source preference writes preserve other UI settings", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/ui-config.json`;
  const source = {
    platform: "rss",
    identifier: "https://www.qbitai.com/feed",
  };
  const key = makeDataSourceKey(source.platform, source.identifier);

  try {
    // 界面已不再写入 customDataSources（采集源改为固定预置），这里直接造出
    // 「旧版本里加过自定义源」的配置，验证删除只影响被删的那一条。
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        workflowSettings: { run: { publish: false } },
        customDataSources: [
          source,
          { platform: "reddit", identifier: "r/LocalLLaMA" },
        ],
        sourceRules: { [key]: { maxArticles: 5 } },
      }),
    );

    const before = await readDataSourcePreferences(path);
    assertEquals(before.customDataSources?.length, 2);

    await deleteDataSourcePreference(source, path);
    const removed = await readDataSourcePreferences(path);
    assertEquals(removed.customDataSources, [
      { platform: "reddit", identifier: "r/LocalLLaMA" },
    ]);
    assertEquals(removed.deletedDataSources, [key]);

    const stored = JSON.parse(await Deno.readTextFile(path));
    assertEquals(stored.workflowSettings, { run: { publish: false } });
    assertExists(stored.sourceRules);
    assertEquals(stored.sourceRules[key], undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
