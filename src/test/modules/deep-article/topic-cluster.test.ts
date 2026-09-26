import { assertEquals } from "@std/assert";
import {
  applyMaterialBudget,
  buildMaterialPayload,
  findUnassignedMaterialIds,
  MaterialBudget,
  normalizeAndRankPackages,
  SCORE_MAX,
  TOPIC_SCORE_TOTAL_MAX,
} from "../../../services/topic-cluster.ts";
import { clampScore } from "../../../modules/deep-article/llm-json.ts";
import { ScrapedContent } from "../../../modules/interfaces/scraper.interface.ts";

const LANES = [
  "AI + 家庭教育",
  "AI + 人生或职业规划",
  "AI + 认知升级与自我学习",
  "AI 工具",
  "AI 行业与技术观察",
];

const material = (id: string, length = 100): ScrapedContent => ({
  id,
  title: `标题 ${id}`,
  content: "正".repeat(length),
  url: `https://example.com/${id}`,
  publishDate: "2026-09-26",
  metadata: {},
});

const rawPackage = (overrides: Record<string, unknown> = {}) => ({
  name: "主题",
  materialIds: ["a"],
  primarySources: ["官方文档"],
  coreFacts: ["某个数字"],
  widelyRepeated: "媒体说法",
  omittedConditions: ["条件"],
  controversy: "有反方",
  lane: "AI 行业与技术观察",
  laneReason: "理由",
  authorEntry: "判断入口",
  gaps: [],
  scores: {
    gap: 20,
    relevance: 15,
    controversy: 10,
    material: 15,
    writable: 15,
  },
  deduction: "扣分理由",
  ...overrides,
});

Deno.test("分值夹取：超范围夹到上限，负数与非数字归零", () => {
  assertEquals(SCORE_MAX.gap, 25);
  assertEquals(TOPIC_SCORE_TOTAL_MAX, 100);
  assertEquals(clampScore(40, 25), 25, "模型给 40 必须夹到 25");
  assertEquals(clampScore(-5, 20), 0);
  assertEquals(clampScore("abc", 20), 0);
  assertEquals(clampScore("13.37", 20), 13.4, "保留一位小数");
  assertEquals(clampScore(undefined, 20), 0);
});

Deno.test("总分由代码相加，不采用模型自报的 total", () => {
  const [pkg] = normalizeAndRankPackages(
    { packages: [rawPackage({ total: 999 })] },
    [material("a")],
    LANES,
  );
  assertEquals(pkg.total, 75, "20+15+10+15+15");
  assertEquals(pkg.eliminated, undefined);
});

Deno.test("领域名不是五领域之一时不在这步淘汰，交给领域路由裁决", () => {
  const pkg = normalizeAndRankPackages(
    { packages: [rawPackage({ lane: "AI 模型服务与商业化" })] },
    [material("a")],
    LANES,
  )[0];
  assertEquals(pkg.eliminated, undefined, "自创领域名不得在这里被误杀");
  assertEquals(pkg.lane, "", "未验证时 lane 置空，避免下游当成权威领域用");
  assertEquals(pkg.laneUnverified, true);
  assertEquals(pkg.laneRaw, "AI 模型服务与商业化");

  const standard = normalizeAndRankPackages(
    { packages: [rawPackage({ lane: "AI 行业与技术观察" })] },
    [material("a")],
    LANES,
  )[0];
  assertEquals(standard.lane, "AI 行业与技术观察");
  assertEquals(standard.laneUnverified, undefined);
});

Deno.test("硬淘汰：既无一手来源也无补料入口 / 领域缺失 / 没有核心事实", () => {
  const socialOnly: ScrapedContent = {
    ...material("a"),
    content: "没有外链",
    url: "https://x.com/a/status/1",
  };
  const noSource = normalizeAndRankPackages(
    { packages: [rawPackage({ primarySources: ["无"] })] },
    [socialOnly],
    LANES,
  )[0];
  assertEquals(noSource.eliminated, "没有一手来源，也没有可抓取的补料入口");

  const emptySource = normalizeAndRankPackages(
    { packages: [rawPackage({ primarySources: [] })] },
    [socialOnly],
    LANES,
  )[0];
  assertEquals(emptySource.eliminated, "没有一手来源，也没有可抓取的补料入口");

  const hasEntry = normalizeAndRankPackages(
    { packages: [rawPackage({ primarySources: ["无"] })] },
    [material("a")],
    LANES,
  )[0];
  assertEquals(
    hasEntry.eliminated,
    undefined,
    "真实补料入口应交给 material-gap 资格判断",
  );
  assertEquals(hasEntry.supplementEntryLinks, ["https://example.com/a"]);

  const noLane = normalizeAndRankPackages(
    { packages: [rawPackage({ lane: "" })] },
    [material("a")],
    LANES,
  )[0];
  assertEquals(noLane.eliminated, "没有标注最近领域");

  const noFacts = normalizeAndRankPackages(
    { packages: [rawPackage({ coreFacts: [] })] },
    [material("a")],
    LANES,
  )[0];
  assertEquals(noFacts.eliminated, "没有可核验的核心事实");
});

Deno.test("防幻觉：引用不存在的素材 id 被剔除，全无效则淘汰", () => {
  const partial = normalizeAndRankPackages(
    { packages: [rawPackage({ materialIds: ["a", "ghost-1", "ghost-2"] })] },
    [material("a")],
    LANES,
  )[0];
  assertEquals(partial.materialIds, ["a"]);
  assertEquals(partial.invalidMaterialIds, ["ghost-1", "ghost-2"]);
  assertEquals(partial.eliminated, undefined);

  const allGhost = normalizeAndRankPackages(
    { packages: [rawPackage({ materialIds: ["ghost-1"] })] },
    [material("a")],
    LANES,
  )[0];
  assertEquals(allGhost.eliminated?.startsWith("引用的素材 id 均不存在"), true);
  assertEquals(allGhost.materialIds, []);
});

Deno.test("排序：未淘汰在前，按总分降序，同分按素材数降序", () => {
  const ranked = normalizeAndRankPackages(
    {
      packages: [
        rawPackage({
          name: "淘汰的",
          materialIds: ["x"],
          primarySources: [],
          scores: {
            gap: 25,
            relevance: 20,
            controversy: 15,
            material: 20,
            writable: 20,
          },
        }),
        rawPackage({
          name: "低分",
          materialIds: ["a"],
          scores: {
            gap: 5,
            relevance: 5,
            controversy: 5,
            material: 5,
            writable: 5,
          },
        }),
        rawPackage({
          name: "高分少素材",
          materialIds: ["a"],
          scores: {
            gap: 20,
            relevance: 18,
            controversy: 12,
            material: 18,
            writable: 18,
          },
        }),
        rawPackage({
          name: "高分多素材",
          materialIds: ["a", "b", "c"],
          scores: {
            gap: 20,
            relevance: 18,
            controversy: 12,
            material: 18,
            writable: 18,
          },
        }),
      ],
    },
    [
      material("a"),
      material("b"),
      material("c"),
      {
        ...material("x"),
        content: "没有外链",
        url: "https://x.com/x/status/1",
      },
    ],
    LANES,
  );

  assertEquals(ranked.map((item) => item.name), [
    "高分多素材",
    "高分少素材",
    "低分",
    "淘汰的",
  ]);
});

Deno.test("主题包模型输入显式携带素材真实 URL 与代码时间基准", () => {
  const payload = buildMaterialPayload([material("m1")]);
  assertEquals(payload.includes("素材URL: https://example.com/m1"), true);
  // 时间基准只能由代码给：模型自推“今天”会把已发布素材当成未来数据。
  assertEquals(payload.includes("【当前日期】"), true);
  assertEquals(payload.includes("（距当前 "), true);
});

Deno.test("材料门槛：单素材且无可抓取链接时淘汰（真跑踩过的坑）", () => {
  // 真跑实测：@OpenAIDevs 时间线里每条推文各成一个主题包，每条只有 1 条素材，
  // 链接又都是 x.com（抓不到），于是选谁都不可能满足材料门槛。
  const socialOnly = normalizeAndRankPackages(
    { packages: [rawPackage({ materialIds: ["x1"] })] },
    [{
      id: "x1",
      title: "MCP write actions",
      content: "正文",
      url: "https://x.com/OpenAIDevs/status/1",
      publishDate: "2026-09-26",
      metadata: {},
    }],
    LANES,
  )[0];
  assertEquals(
    socialOnly.eliminated,
    "素材只有 1 条，且没有可抓取的补料入口（材料门槛未满足）",
  );

  // 同样单条素材，但带官方文档链接 → 有补料路径，放行
  const withPrimary = normalizeAndRankPackages(
    { packages: [rawPackage({ materialIds: ["p1"] })] },
    [{
      id: "p1",
      title: "官方发布说明",
      content: "正文",
      url: "https://openai.com/index/mcp-write-actions/",
      publishDate: "2026-09-26",
      metadata: {},
    }],
    LANES,
  )[0];
  assertEquals(withPrimary.eliminated, undefined);
});

Deno.test("材料门槛：两条素材时不再要求一手链接", () => {
  const twoSocial = normalizeAndRankPackages(
    { packages: [rawPackage({ materialIds: ["x1", "x2"] })] },
    [
      {
        id: "x1",
        title: "推文一",
        content: "甲正文，讲的是单位变更。",
        url: "https://x.com/a/status/1",
        publishDate: "2026-09-26",
        metadata: {},
      },
      {
        id: "x2",
        title: "推文二",
        content: "乙正文，讲的是另一件事，内容足够长。",
        url: "https://x.com/b/status/2",
        publishDate: "2026-09-26",
        metadata: {},
      },
    ],
    LANES,
  )[0];
  assertEquals(twoSocial.materialIds.length, 2);
  assertEquals(twoSocial.eliminated, undefined);
});

Deno.test("未归属素材能被发现（模型整簇漏聚类时可见）", () => {
  const contents = [material("a"), material("b"), material("c")];
  const packages = normalizeAndRankPackages(
    { packages: [rawPackage({ materialIds: ["a"] })] },
    contents,
    LANES,
  );
  assertEquals(findUnassignedMaterialIds(packages, contents), ["b", "c"]);
});

Deno.test("素材预算：超条数与超字符都截断，且丢弃数可见", () => {
  const contents = Array.from({ length: 10 }, (_, i) => material(`m${i}`, 500));
  const budget: MaterialBudget = {
    maxMaterials: 4,
    perMaterialChars: 100,
    totalChars: 100000,
  };
  const byCount = applyMaterialBudget(contents, budget);
  assertEquals(byCount.kept.length, 4);
  assertEquals(byCount.dropped, 6);

  const tight: MaterialBudget = {
    maxMaterials: 60,
    perMaterialChars: 500,
    totalChars: 1200,
  };
  const byChars = applyMaterialBudget(contents, tight);
  assertEquals(byChars.kept.length < 10, true);
  assertEquals(byChars.dropped, 10 - byChars.kept.length);
});

Deno.test("模型输出缺 packages 字段时返回空数组，不抛异常", () => {
  assertEquals(normalizeAndRankPackages({}, [material("a")], LANES), []);
  assertEquals(normalizeAndRankPackages(null, [material("a")], LANES), []);
  assertEquals(normalizeAndRankPackages({ packages: "nope" }, [], LANES), []);
});
