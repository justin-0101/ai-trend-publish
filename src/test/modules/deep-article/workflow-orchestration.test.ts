import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { WeixinDeepArticleWorkflow } from "../../../services/weixin-deep-article.workflow.ts";
import { WeixinArticleTemplateRenderer } from "../../../modules/render/article.renderer.ts";
import { WorkflowTerminateError } from "../../../works/workflow-error.ts";
import {
  DeepArticleRunnerLike,
  StepRunOptions,
  StepRunResult,
} from "../../../modules/deep-article/step-runner.ts";
import { ScrapedContent } from "../../../modules/interfaces/scraper.interface.ts";

/**
 * 编排测试：用桩 runner 替换 LLM，验证 13 步的顺序、数据传递与三道闸门。
 * 不调模型、不联网、不发公众号；只会在 output/ 下产生留档目录，测试结束会清理。
 */

const materials: ScrapedContent[] = [
  {
    id: "m1",
    title: "定价页改了计价单位",
    content: "官方定价页把计价单位换成每百万 token，并注明缓存命中单独计价。"
      .repeat(3),
    url: "https://example.com/a",
    publishDate: "2026-09-26",
    metadata: {},
  },
  {
    id: "m2",
    title: "某报告讨论迁移成本",
    content: "报告访谈了 40 家企业，其中 27 家说低估了改造工时。".repeat(3),
    url: "https://example.com/b",
    publishDate: "2026-09-26",
    metadata: {},
  },
];

/**
 * 一条够长的 X 推文正文。
 *
 * X 素材要先过 `DEEP_ARTICLE_MIN_TWEET_CHARS`（默认 120 字）才会进主题包。
 * 桩里写「正文附有 <链接>」只有十几个字，会被当成短推文筛掉，
 * 于是测试根本走不到要测的那一步（真跑里那条 20 字的回复就是这么被排除的）。
 */
const tweetBody = (link: string): string =>
  "我聊过 10 家以上的服务商，感觉大部分还是同一套路子：黑盒、批量投放，价格还不低。" +
  "短期可能有用，长期很难走远。我们自己的做法是把内容和核验流程分开记账，至少能对上账。" +
  `原始页面见 ${link} 。`;

interface StubOptions {
  /** 覆盖默认素材，测素材相关闸门时用 */
  materials?: ScrapedContent[];
  /** 让 fireCrawl 抓取抛错，测补料失败路径 */
  fireCrawlFails?: boolean;
  /** material-gap 的充分度判定 */
  gapSufficiency?: "充足" | "部分" | "不足";
  /** material-gap 对真实 URL 的来源资格判断 */
  gapSourceAssessment?: unknown;
  /** 定向页面抓取返回值；用于测试空正文素材的重新补抓 */
  supplementPageResult?: ScrapedContent;
  /** 定向页面抓取成功但正文为空 */
  supplementPageReturnsNull?: boolean;
  /** 采集器不提供 scrapePage 能力，必须失败而不能回退 feed scrape */
  disableDirectPage?: boolean;
  /** review-score 返回的分项分 */
  dimensions?: Record<string, number>;
  /** review-1 触发的硬门槛 */
  hardGateFailed?: string;
  /** 第三轮审稿后的正文 */
  finalContent?: string;
  /** 首页主题包里的最高分给谁 */
  topPackageName?: string;
  /** 第三轮审稿报的隐私命中（故意允许传非数组，测健壮性） */
  privacyHits?: unknown;
  /** 起草步骤返回的 content（故意允许传对象，测类型收口） */
  draftContent?: unknown;
}

const createRunner = (
  options: StubOptions = {},
): DeepArticleRunnerLike & { calls: string[]; options: StepRunOptions[] } => {
  const calls: string[] = [];
  const seen: StepRunOptions[] = [];

  const data: Record<string, unknown> = {
    "topic-package": {
      packages: [
        {
          name: options.topPackageName ?? "计价单位变更",
          materialIds: ["m1"],
          primarySources: ["官方定价页"],
          coreFacts: ["单位从每次改为每百万 token"],
          widelyRepeated: "整体降幅 40%",
          omittedConditions: ["缓存命中单独计价"],
          controversy: "有反方",
          lane: "AI 行业与技术观察",
          laneReason: "行业动作",
          authorEntry: "成本结构判断",
          gaps: [],
          scores: {
            gap: 20,
            relevance: 18,
            controversy: 12,
            material: 16,
            writable: 16,
          },
          deduction: "扣分理由",
        },
        {
          name: "低分主题",
          materialIds: ["m2"],
          primarySources: ["机构报告"],
          coreFacts: ["27/40 家低估工时"],
          widelyRepeated: "无",
          omittedConditions: [],
          controversy: "无",
          lane: "AI 行业与技术观察",
          laneReason: "行业动作",
          authorEntry: "项目经验",
          gaps: [],
          scores: {
            gap: 10,
            relevance: 10,
            controversy: 5,
            material: 10,
            writable: 10,
          },
          deduction: "扣分理由",
        },
      ],
    },
    "material-gap": {
      gaps: [
        {
          缺什么: "官方文档页",
          服务哪条关系: "计价单位是否真的变了",
          缺口归属: "公开材料",
        },
      ],
      sufficiency: options.gapSufficiency ?? "充足",
      coreFactsMissing: [],
      sourceAssessment: options.gapSourceAssessment ?? [
        {
          url: "https://example.com/a",
          sourceType: "一手",
          usableAsEvidence: true,
          why: "测试默认的一手页面",
        },
        {
          url: "https://openai.com/index/mcp-write-actions/",
          sourceType: "一手",
          usableAsEvidence: true,
          why: "测试补抓页面",
        },
      ],
      linkCandidates: [],
      narrowedClaim: "若补不到文档，只说单位变更，不谈降幅",
      note: "",
    },
    "lane-routing": {
      primaryLane: "AI 行业与技术观察",
      secondaryLane: "",
      核心问题: "这个变化改变了谁的哪一种成本",
      依据: ["定价页", "报告"],
      写作入口: "计价单位",
      置信度: "高",
      不确定来源: "无",
    },
    "author-stance": {
      whyNoticed: "成本结构是作者长期关注的判断入口",
      stance: "先看计价单位，再看迁移成本",
      keep: ["单位切换"],
      reserve: ["降幅数字"],
      reject: [],
      boundary: ["只对开发者与企业采购成立"],
      readerQuestion: "让做技术选型的人在降价面前看清哪一段成本降了",
      innerUnderstanding: "内部核验段",
    },
    "evidence-lock": {
      statements: [{
        text: "单位已切换",
        type: "事实",
        source: "定价页",
        strength: "强",
      }],
      locks: { 事实: ["单位切换"], 数字: [], 术语: ["每百万 token"] },
      unsupported: [],
    },
    thesis: {
      tension: "降价与迁移成本",
      lenses: ["成本转移"],
      mainMechanism: "成本从试用门槛转到迁移成本",
      claim:
        "大多数人以为 X；在 Y 条件下真正起作用的是 Z；因为 M；但当 B 时这个判断不成立",
      counterArgument: "若迁移工具成熟，则迁移成本不成立",
      closure: {
        现实问题: "a",
        机制: "b",
        证据或案例: "c",
        现实价值: "d",
        行动: "e",
        边界: "f",
      },
      closureGaps: [],
    },
    "archetype-craft": {
      archetype: "观察评论",
      authorPosition: "观察者",
      tone: "克制",
      openingFunction: "先给被转述的说法",
      mainTechnique: "成本拆解",
      auxTechnique: "",
      conceptPlan: [],
      sectionPlan: [{ task: "摆事实", 内容: "计价单位的变化" }],
      headingCount: 2,
      endingFunction: "给一个判断标准",
      forbidden: ["预测"],
      propagation: { enabled: false, reason: "默认关闭" },
    },
    draft: {
      title: "降价降的是哪一段成本",
      subtitle: "先说被广泛转述的说法",
      content: options.draftContent ??
        "第一段。<next_paragraph />第二段。<next_paragraph />第三段。",
      titles: ["候选一", "候选二"],
      selfCheck: "逐句校准完成",
    },
    "fact-recheck": {
      issues: [],
      content:
        "第一段。<next_paragraph />第二段修正后。<next_paragraph />第三段。",
      changedFacts: [],
    },
    "review-1": {
      scored: true,
      items: [{ check: "材料可核验", pass: true, evidence: "第 1 段" }],
      hardGateFailed: options.hardGateFailed ?? "",
      // 真实审稿会在触发硬门槛时一并给出需要退回的阶段，桩也要这样
      returnStage: options.hardGateFailed ? "起草" : "",
    },
    "review-2": {
      scored: true,
      items: [{ check: "作者性", pass: true, evidence: "第 2 段" }],
      authorityVerdict: {
        positionClear: true,
        tradeoffConcrete: true,
        boundaryHonest: true,
        authorlessWouldCollapse: true,
        reason: "有取舍",
      },
      hardGateFailed: "",
    },
    "review-3": {
      scored: true,
      items: [{ check: "语言", pass: true, evidence: "全文" }],
      privacyHits: options.privacyHits ?? [],
      compressionRate: 0.2,
      content: options.finalContent ??
        "第一段。<next_paragraph />第二段修正后。<next_paragraph />第三段。",
      titles: ["修订候选一"],
      hardGateFailed: "",
    },
    "review-score": {
      dimensions: options.dimensions ?? {
        materials: 18,
        mechanism: 17,
        authorship: 15,
        evidence: 12,
        structure: 8,
        usefulness: 8,
        titlePublish: 4,
      },
      twoStrongest: ["机制清楚", "边界诚实"],
      twoRisks: ["数字少", "标题一般"],
      publishJudgement: "可交付作者阅读",
      notes: "",
    },
  };

  return {
    calls,
    options: seen,
    runJson: <T>(stepOptions: StepRunOptions): Promise<StepRunResult<T>> => {
      calls.push(stepOptions.stepKey);
      seen.push(stepOptions);
      const payload = data[stepOptions.stepKey];
      if (payload === undefined) {
        return Promise.reject(new Error(`桩未定义步骤 ${stepOptions.stepKey}`));
      }
      return Promise.resolve({
        data: payload as T,
        meta: {
          stepKey: stepOptions.stepKey,
          title: stepOptions.stepKey,
          provider: "stub",
          systemChars: 0,
          userChars: 0,
          systemParts: [],
        },
      });
    },
  };
};

/**
 * 渲染器全文件复用一个实例。
 *
 * BaseTemplateRenderer 在构造时就开始读模板文件（不 await）。每个 harness 都新建一个的话，
 * 「没走到渲染就终止」的用例会留下未完成的读操作，被 Deno 判成 leak，
 * 而 leak 归到哪个用例是不确定的——测试会随机变红。复用后只要第一个用例渲染过一次，
 * 这些读操作就已经完成。
 */
let sharedRenderer: WeixinArticleTemplateRenderer | null = null;
const getRenderer = (): WeixinArticleTemplateRenderer =>
  sharedRenderer ??= new WeixinArticleTemplateRenderer(false);

const createHarness = (options: StubOptions = {}) => {
  const runner = createRunner(options);
  const drafts: Array<{ title: string; html: string }> = [];
  const published: Array<Record<string, unknown>> = [];
  const notices: Array<{ level: string; title: string; content: string }> = [];
  const supplementPageCalls: string[] = [];
  const feedScrapeCalls: string[] = [];

  const scrapers = new Map<
    string,
    {
      scrape: (id: string) => Promise<ScrapedContent[]>;
      scrapePage?: (id: string) => Promise<ScrapedContent | null>;
    }
  >();
  const scraped = options.materials ?? materials;
  for (
    const key of [
      "fireCrawl",
      "twitter",
      "twitter-cookie",
      "twitter-frontend",
      "x-search",
    ]
  ) {
    scrapers.set(key, {
      scrape: (id: string) => {
        if (key === "fireCrawl") feedScrapeCalls.push(id);
        return Promise.resolve(scraped);
      },
      ...(key === "fireCrawl" && !options.disableDirectPage
        ? {
          scrapePage: (id: string) => {
            supplementPageCalls.push(id);
            if (
              options.fireCrawlFails &&
              id.includes("/index/mcp-write-actions/")
            ) {
              return Promise.reject(new Error("补料抓取失败（桩）"));
            }
            if (options.supplementPageReturnsNull) {
              return Promise.resolve(null);
            }
            return Promise.resolve(
              options.supplementPageResult ?? scraped[0] ?? null,
            );
          },
        }
        : {}),
    });
  }

  const workflow = new WeixinDeepArticleWorkflow({
    id: "deep-test",
    env: {
      name: "deep-test",
      draftWriter: (draft) => {
        drafts.push({ title: draft.title, html: draft.html });
        return Promise.resolve({ id: "draft-1" });
      },
      draftStatusWriter: () => Promise.resolve(),
    },
  }, {
    runner,
    scrapers: scrapers as never,
    // 关掉图片处理：真实渲染器会在 doRender 里构造 WeixinPublisher 去传图，
    // 那需要微信配置，测试里没有也不应该有。
    renderer: getRenderer(),
    authorContextLoader: (() =>
      Promise.resolve({
        summary: "",
        sources: [],
        skipped: [],
        removed: [],
        privacyTermSource: "test",
        privacyTerms: [],
        available: false,
        memory: {
          text: "",
          kept: [],
          dropped: [],
          available: false,
          path: "(未读取)",
          removedBySanitizer: 0,
        },
      })) as never,
    publisher: {
      publish: (_html: string, options?: Record<string, unknown>) => {
        published.push(options ?? {});
        return Promise.resolve({ success: true });
      },
      uploadThumb: () => Promise.resolve("thumb-1"),
      refresh: () => Promise.resolve(),
    } as never,
    notifier: {
      info: (title: string, content: string) => {
        notices.push({ level: "info", title, content });
        return Promise.resolve(true);
      },
      success: (title: string, content: string) => {
        notices.push({ level: "success", title, content });
        return Promise.resolve(true);
      },
      warning: (title: string, content: string) => {
        notices.push({ level: "warning", title, content });
        return Promise.resolve(true);
      },
      error: (title: string, content: string) => {
        notices.push({ level: "error", title, content });
        return Promise.resolve(true);
      },
    } as never,
  });

  return {
    workflow,
    runner,
    drafts,
    published,
    notices,
    supplementPageCalls,
    feedScrapeCalls,
  };
};

const listRunDirs = async (): Promise<string[]> => {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${Deno.cwd()}/output`)) {
      if (entry.isDirectory && entry.name.startsWith("deep-article-")) {
        found.push(entry.name);
      }
    }
  } catch {
    // output 目录不存在时视为空
  }
  return found;
};

const cleanupNewRunDirs = async (before: string[]): Promise<void> => {
  for (const name of await listRunDirs()) {
    if (!before.includes(name)) {
      await Deno.remove(`${Deno.cwd()}/output/${name}`, { recursive: true });
    }
  }
};

/**
 * 取本次新建的留档目录。
 *
 * 不写 `created.length === 1` 这类计数断言（output/ 是共享目录，会被残留目录搞成 flake），
 * 但也**不做「没新建就回退取历史目录」的降级**——那会把「没落盘」这种回归变成测试通过。
 * 没新建就直接失败。
 */
const newestRunDir = async (before: string[]): Promise<string> => {
  const created = (await listRunDirs()).filter((name) =>
    !before.includes(name)
  );
  if (created.length === 0) {
    throw new Error(
      `本次没有新建任何留档目录（跑之前已有：${before.join(", ") || "无"}）`,
    );
  }
  return `${Deno.cwd()}/output/${[...created].sort().pop()}`;
};

const runWorkflow = async (
  harness: ReturnType<typeof createHarness>,
  payload: Record<string, unknown>,
) => {
  await harness.workflow.execute({
    payload: { sourceType: "firecrawl", includeKeywords: [], ...payload },
    id: "evt-1",
    timestamp: Date.now(),
  });
};

Deno.test("编排：13 步按序执行，默认不发布但会归档草稿与留档", async () => {
  const before = await listRunDirs();
  const harness = createHarness();
  try {
    await runWorkflow(harness, {});

    // 顺序按 skill 第 5-7 步：素材补料 → 证据分层 → 作者立场
    assertEquals(harness.runner.calls, [
      "topic-package",
      "lane-routing",
      "material-gap",
      "evidence-lock",
      "author-stance",
      "thesis",
      "archetype-craft",
      "draft",
      "fact-recheck",
      "review-1",
      "review-2",
      "review-3",
      "review-score",
    ]);

    const topicCall = harness.runner.options.find((o) =>
      o.stepKey === "topic-package"
    );
    assertStringIncludes(
      topicCall?.payload ?? "",
      "素材URL: https://example.com/a",
    );
    const gapCall = harness.runner.options.find((o) =>
      o.stepKey === "material-gap"
    );
    assertStringIncludes(
      gapCall?.payload ?? "",
      "素材URL: https://example.com/a",
    );
    // 时间基准只由代码给：模型曾自己猜“今天是 5 月 7 日”，把 5 月 8 日发布的素材
    // 判成“未来数据、不可用”。锚点必须落在真实步骤输入里。
    assertStringIncludes(gapCall?.payload ?? "", "【当前日期】");
    assertStringIncludes(gapCall?.payload ?? "", "（距当前 ");
    assertStringIncludes(topicCall?.payload ?? "", "【当前日期】");

    assertEquals(harness.published.length, 0, "默认不得自动发布");
    assertEquals(harness.drafts.length, 1, "必须留一份本地草稿");
    assertEquals(harness.drafts[0].title, "降价降的是哪一段成本");
    assertEquals(
      harness.drafts[0].html.includes("发布前需作者本人阅读确认"),
      true,
      "成稿必须自带机器不代签的声明",
    );

    const warning = harness.notices.find((n) => n.level === "warning");
    assertEquals(warning !== undefined, true, "跳过发布必须发通知说明原因");
    assertEquals(warning!.content.includes("需作者本人阅读后决定"), true);

    const dir = await newestRunDir(before);
    for (
      const file of [
        "00-素材清单.md",
        "01-主题包清单.md",
        "02-作者背景.md",
        "03-领域判断卡.md",
        "04-素材缺口与补料.md",
        "09-初稿.md",
        "14-审稿闸门.md",
        "15-隐私后检.md",
        "16-成稿.md",
        "README.md",
      ]
    ) {
      const stat = await Deno.stat(`${dir}/${file}`);
      assertEquals(stat.isFile, true, `缺少留档 ${file}`);
    }
    const index = await Deno.readTextFile(`${dir}/README.md`);
    assertEquals(index.includes("机器不代签"), true);
    const gapReport = await Deno.readTextFile(`${dir}/04-素材缺口与补料.md`);
    assertStringIncludes(gapReport, "选中主题已有可抓取页面（1 个）");
    assertStringIncludes(gapReport, "https://example.com/a");
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：高总分救不了作者性低于 12，请求发布也拦住", async () => {
  const before = await listRunDirs();
  const harness = createHarness({
    dimensions: {
      materials: 20,
      mechanism: 20,
      authorship: 11,
      evidence: 15,
      structure: 10,
      usefulness: 10,
      titlePublish: 5,
    },
  });
  try {
    await assertRejects(
      () => runWorkflow(harness, { publish: true }),
      WorkflowTerminateError,
      "作者性 11 低于 12",
    );
    assertEquals(harness.published.length, 0, "量表不达标不得发布");
    assertEquals(harness.drafts.length, 1, "不达标也要把稿子留下");
    const warnings = harness.notices.filter((n) => n.level === "warning");
    assertEquals(warnings.length >= 1, true);
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：硬门槛失败时不进入打分，且不发布", async () => {
  const before = await listRunDirs();
  const harness = createHarness({
    hardGateFailed: "标题承诺正文没有回答的问题",
  });
  try {
    await assertRejects(
      () => runWorkflow(harness, { publish: true }),
      WorkflowTerminateError,
      "硬门槛",
    );
    assertEquals(
      harness.runner.calls.includes("review-score"),
      false,
      "硬门槛失败后不得再打分",
    );
    assertEquals(harness.published.length, 0);

    const gate = await Deno.readTextFile(
      `${await newestRunDir(before)}/14-审稿闸门.md`,
    );
    assertEquals(gate.includes("硬门槛失败"), true);
    assertEquals(gate.includes("需退回阶段"), true);
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：隐私命中时即使量表满分也不发布", async () => {
  const before = await listRunDirs();
  const harness = createHarness({
    finalContent:
      "第一段。<next_paragraph />我朋友张三的做法是这样。<next_paragraph />第三段。",
  });
  try {
    await assertRejects(
      () => runWorkflow(harness, { publish: true }),
      WorkflowTerminateError,
      "隐私后检拦截",
    );
    assertEquals(harness.published.length, 0, "隐私命中不得发布");
    assertEquals(harness.drafts.length, 1);

    const privacy = await Deno.readTextFile(
      `${await newestRunDir(before)}/15-隐私后检.md`,
    );
    assertEquals(privacy.includes("拦截"), true);
    assertEquals(privacy.includes("家人姓名"), true);
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：三道条件都满足时才发布，并带上封面", async () => {
  const before = await listRunDirs();
  const harness = createHarness();
  try {
    await runWorkflow(harness, { publish: true });

    assertEquals(harness.published.length, 1, "满足条件应发布一次");
    assertEquals(
      "thumbMediaId" in harness.published[0],
      true,
      "发布必须带封面字段",
    );
    const success = harness.notices.find((n) => n.level === "success");
    assertEquals(success !== undefined, true, "发布成功要发通知");
    assertEquals(success!.content.includes("发布: 成功"), true);
    assertEquals(success!.content.includes("机器达标"), true);
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：模型层隐私命中与正文对账后才触发拦截", async () => {
  const before = await listRunDirs();
  // 命中文本确实在正文里 → 必须拦住
  const real = createHarness({
    finalContent:
      "第一段。<next_paragraph />我在某家公司做企业侧项目。<next_paragraph />第三段。",
    privacyHits: [
      {
        category: "关联单位",
        text: "我在某家公司做企业侧项目",
        fix: "改成行业角色",
      },
    ],
  });
  try {
    await assertRejects(
      () => runWorkflow(real, { publish: true }),
      WorkflowTerminateError,
      "模型层隐私命中",
    );
    assertEquals(
      real.published.length,
      0,
      "对账后成立的模型层命中必须拦住发布",
    );
    assertEquals(real.drafts.length, 1, "拦住也要把稿子留下");
    const report = await Deno.readTextFile(
      `${await newestRunDir(before)}/15-隐私后检.md`,
    );
    assertStringIncludes(report, "与正文对账后成立 1 项");
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：模型层误报（正文里找不到命中文本）不阻发布", async () => {
  const before = await listRunDirs();
  const hallucinated = createHarness({
    privacyHits: [
      { category: "家人姓名", text: "我儿子某某某", fix: "改用关系词" },
      "一段不存在的命中",
    ],
  });
  try {
    await runWorkflow(hallucinated, { publish: true });
    assertEquals(
      hallucinated.published.length,
      1,
      "误报不应把闸门拖死，否则闸门会被关掉",
    );
    const report = await Deno.readTextFile(
      `${await newestRunDir(before)}/15-隐私后检.md`,
    );
    assertStringIncludes(report, "报 2 项");
    assertStringIncludes(report, "忽略 2 项");
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：review-3 的 privacyHits 不是数组时不崩、照常落盘", async () => {
  const before = await listRunDirs();
  const harness = createHarness({ privacyHits: "未发现隐私问题" });
  try {
    await runWorkflow(harness, {});
    assertEquals(harness.drafts.length, 1, "字符串型 privacyHits 不得导致丢稿");
    const report = await Deno.readTextFile(
      `${await newestRunDir(before)}/15-隐私后检.md`,
    );
    assertStringIncludes(report, "报 0 项");
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：正文是对象时不把 [object Object] 当稿子", async () => {
  const before = await listRunDirs();
  const harness = createHarness({
    draftContent: { paragraphs: ["第一段", "第二段"] },
  });
  try {
    await assertRejects(
      () => runWorkflow(harness, {}),
      WorkflowTerminateError,
      "起草失败",
    );
    assertEquals(harness.drafts.length, 0, "坏稿不得进草稿箱");
    assertEquals(
      harness.notices.some((n) => n.level === "warning"),
      true,
      "不得静默",
    );
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：中间卡为空时终止，不留半成品稿", async () => {
  const before = await listRunDirs();
  const harness = createHarness();
  const original = harness.runner.runJson;
  harness.runner.runJson = ((stepOptions: StepRunOptions) => {
    if (stepOptions.stepKey === "thesis") {
      harness.runner.calls.push(stepOptions.stepKey);
      return Promise.resolve({
        data: {},
        meta: {
          stepKey: "thesis",
          title: "立论",
          provider: "stub",
          systemChars: 0,
          userChars: 0,
          systemParts: [],
        },
      });
    }
    return original(stepOptions);
  }) as never;

  try {
    await assertRejects(
      () => runWorkflow(harness, {}),
      WorkflowTerminateError,
      "为空",
    );
    assertEquals(harness.drafts.length, 0);
    assertEquals(
      harness.runner.calls.includes("draft"),
      false,
      "地基为空时不该继续起草",
    );
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：领域路由判定不匹配时不出稿，并留下终止原因", async () => {
  const before = await listRunDirs();
  const harness = createHarness();
  // 只替换 lane-routing 的返回，其余步骤仍走桩数据（否则连主题包都拿不到）
  const original = harness.runner.runJson;
  harness.runner.runJson = ((stepOptions: StepRunOptions) => {
    if (stepOptions.stepKey === "lane-routing") {
      harness.runner.calls.push(stepOptions.stepKey);
      return Promise.resolve({
        data: { primaryLane: "", 不确定来源: "五个领域都不匹配" },
        meta: {
          stepKey: "lane-routing",
          title: "领域路由",
          provider: "stub",
          systemChars: 0,
          userChars: 0,
          systemParts: [],
        },
      });
    }
    return original(stepOptions);
  }) as never;

  try {
    await assertRejects(
      () => runWorkflow(harness, {}),
      WorkflowTerminateError,
      "不落在五个领域内",
    );
    const reason = await Deno.readTextFile(
      `${await newestRunDir(before)}/99-终止原因.md`,
    );
    assertEquals(reason.includes("五领域都不匹配"), true);
    assertEquals(harness.published.length, 0);
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：单个可抓取网页不自动等于一手材料充足", async () => {
  const before = await listRunDirs();
  const harness = createHarness({ gapSufficiency: "部分" });
  try {
    await assertRejects(
      () => runWorkflow(harness, {}),
      WorkflowTerminateError,
      "素材资格不足",
    );
    assertEquals(harness.drafts.length, 0);
    const reason = await Deno.readTextFile(
      `${await newestRunDir(before)}/99-终止原因.md`,
    );
    assertStringIncludes(reason, "已有可抓取页面：1 个");
    assertStringIncludes(reason, "素材缺口充分度：部分");
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：单素材自身 URL 正文为空时会重新补抓", async () => {
  const before = await listRunDirs();
  const sourceUrl = "https://openai.com/index/mcp-write-actions/";
  const harness = createHarness({
    gapSufficiency: "充足",
    materials: [
      {
        id: "m1",
        title: "只有标题没有正文",
        content: "",
        url: sourceUrl,
        publishDate: "2026-09-26",
        metadata: {},
      },
      {
        id: "m2",
        title: "另一个主题",
        content: "另一条不属于入选主题的材料。",
        url: "https://example.com/other",
        publishDate: "2026-09-26",
        metadata: {},
      },
    ],
    supplementPageResult: {
      id: "fetched-page",
      title: "官方文档正文",
      content: "这是从指定 URL 重新抓到的官方文档正文。".repeat(20),
      url: sourceUrl,
      publishDate: "2026-09-26",
      metadata: { source: "fireCrawl-page" },
    },
  });
  try {
    await runWorkflow(harness, {});
    assertEquals(harness.supplementPageCalls, [sourceUrl]);
    const evidenceCall = harness.runner.options.find((o) =>
      o.stepKey === "evidence-lock"
    );
    assertStringIncludes(
      evidenceCall?.payload ?? "",
      "这是从指定 URL 重新抓到的官方文档正文",
    );
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：抓到二手页面也不能冒充一手来源进入证据链", async () => {
  const before = await listRunDirs();
  const sourceUrl = "https://openai.com/index/mcp-write-actions/";
  const harness = createHarness({
    gapSufficiency: "充足",
    gapSourceAssessment: [{
      url: sourceUrl,
      sourceType: "二手",
      usableAsEvidence: false,
      why: "只是转述页",
    }],
    materials: [{
      id: "m1",
      title: "社交平台单条素材",
      content: tweetBody(sourceUrl),
      url: "https://x.com/OpenAIDevs/status/1",
      publishDate: "2026-09-26",
      metadata: {},
    }],
    supplementPageResult: {
      id: "secondary",
      title: "二手转述",
      content: "这是一篇能抓到正文、但不是一手来源的二手转述。".repeat(20),
      url: sourceUrl,
      publishDate: "2026-09-26",
      metadata: {},
    },
  });
  try {
    await assertRejects(
      () => runWorkflow(harness, {}),
      WorkflowTerminateError,
      "没有经素材缺口卡确认的一手来源",
    );
    assertEquals(harness.runner.calls.includes("evidence-lock"), false);
    const report = await Deno.readTextFile(
      `${await newestRunDir(before)}/04-素材缺口与补料.md`,
    );
    assertStringIncludes(report, "抓到的候选补料（1 条");
    assertStringIncludes(report, "确认可进入证据链的一手 URL（0 个）");
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：即使抓到一手页，material-gap 判不足仍停止", async () => {
  const before = await listRunDirs();
  const sourceUrl = "https://openai.com/index/mcp-write-actions/";
  const harness = createHarness({
    gapSufficiency: "不足",
    materials: [{
      id: "m1",
      title: "社交平台单条素材",
      content: tweetBody(sourceUrl),
      url: "https://x.com/OpenAIDevs/status/1",
      publishDate: "2026-09-26",
      metadata: {},
    }],
    supplementPageResult: {
      id: "primary",
      title: "官方页",
      content: "这是官方页，但还不足以支撑文章的核心机制。".repeat(20),
      url: sourceUrl,
      publishDate: "2026-09-26",
      metadata: {},
    },
  });
  try {
    await assertRejects(
      () => runWorkflow(harness, {}),
      WorkflowTerminateError,
      "材料充分度为「不足」",
    );
    assertEquals(harness.runner.calls.includes("evidence-lock"), false);
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：缺少 scrapePage 时不回退列表页 feed 抓取", async () => {
  const before = await listRunDirs();
  const sourceUrl = "https://openai.com/index/mcp-write-actions/";
  const harness = createHarness({
    disableDirectPage: true,
    materials: [{
      id: "m1",
      title: "社交平台单条素材",
      content: tweetBody(sourceUrl),
      url: "https://x.com/OpenAIDevs/status/1",
      publishDate: "2026-09-26",
      metadata: {},
    }],
  });
  try {
    await assertRejects(
      () => runWorkflow(harness, {}),
      WorkflowTerminateError,
      "素材资格不足",
    );
    const report = await Deno.readTextFile(
      `${await newestRunDir(before)}/04-素材缺口与补料.md`,
    );
    assertStringIncludes(report, "不支持直接页面抓取");
    assertEquals(harness.supplementPageCalls.length, 0);
    assertEquals(
      harness.feedScrapeCalls.includes(sourceUrl),
      false,
      "补料 URL 不得传给列表页 feed scrape()",
    );
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：补料步骤把抓到的一手材料写进留档并带入证据与起草", async () => {
  const before = await listRunDirs();
  const harness = createHarness({
    materials: [
      {
        id: "m1",
        title: "MCP 写操作公告",
        content: tweetBody("https://openai.com/index/mcp-write-actions/"),
        url: "https://x.com/OpenAIDevs/status/1",
        publishDate: "2026-09-26",
        metadata: {},
      },
      {
        id: "m2",
        title: "另一条素材",
        content: "另一件事的正文，内容足够长以避免被相似度合并。",
        url: "https://example.com/b",
        publishDate: "2026-09-26",
        metadata: {},
      },
    ],
  });
  try {
    await runWorkflow(harness, {});

    const dir = await newestRunDir(before);
    const gapReport = await Deno.readTextFile(`${dir}/04-素材缺口与补料.md`);
    assertStringIncludes(
      gapReport,
      "https://openai.com/index/mcp-write-actions/",
    );
    assertEquals(harness.supplementPageCalls, [
      "https://openai.com/index/mcp-write-actions/",
    ], "补料必须走直接页面抓取，不能复用列表页的今日新闻提取");
    assertStringIncludes(gapReport, "代码挑出并抓取的链接");
    assertStringIncludes(gapReport, "模型给出的候选链接（仅记录，未采信）");

    // 补料必须进入证据锁定与起草的输入
    const evidenceCall = harness.runner.options.find((o) =>
      o.stepKey === "evidence-lock"
    );
    assertStringIncludes(
      evidenceCall?.payload ?? "",
      "已确认可进入证据链的补料",
    );
    const stanceCall = harness.runner.options.find((o) =>
      o.stepKey === "author-stance"
    );
    assertStringIncludes(
      stanceCall?.payload ?? "",
      "已确认可进入证据链的补料",
    );
    assertStringIncludes(stanceCall?.payload ?? "", "证据与事实锁定表");
    const draftCall = harness.runner.options.find((o) => o.stepKey === "draft");
    assertStringIncludes(
      draftCall?.payload ?? "",
      "已确认可进入证据链的补料",
    );
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：定向页面返回空正文时仍按补料失败处理", async () => {
  const before = await listRunDirs();
  const harness = createHarness({
    supplementPageReturnsNull: true,
    materials: [
      {
        id: "m1",
        title: "社交平台单条素材",
        content: tweetBody("https://openai.com/index/mcp-write-actions/"),
        url: "https://x.com/OpenAIDevs/status/1",
        publishDate: "2026-09-26",
        metadata: {},
      },
    ],
  });
  try {
    await assertRejects(
      () => runWorkflow(harness, {}),
      WorkflowTerminateError,
      "素材资格不足",
    );
    assertEquals(harness.supplementPageCalls.length, 1);
    assertEquals(harness.drafts.length, 0);
  } finally {
    await cleanupNewRunDirs(before);
  }
});

Deno.test("编排：选中主题仅一条素材且补料失败时提前终止，不被素材总数绕过", async () => {
  const before = await listRunDirs();
  const harness = createHarness({
    fireCrawlFails: true,
    materials: [
      {
        id: "m1",
        title: "单条主题素材",
        content: tweetBody("https://openai.com/index/mcp-write-actions/") +
          "这条抓不到。",
        url: "https://x.com/OpenAIDevs/status/1",
        publishDate: "2026-09-26",
        metadata: {},
      },
      {
        id: "m2",
        title: "另一个主题的素材",
        content: "这条不属于入选主题；存在它也不能冒充入选主题已有两条材料。",
        url: "https://example.com/unrelated",
        publishDate: "2026-09-26",
        metadata: {},
      },
    ],
  });
  try {
    await assertRejects(
      () => runWorkflow(harness, {}),
      WorkflowTerminateError,
      "素材资格不足",
    );
    assertEquals(
      harness.runner.calls.includes("draft"),
      false,
      "材料地基不足时不该继续起草",
    );
    assertEquals(harness.drafts.length, 0);
    const reason = await Deno.readTextFile(
      `${await newestRunDir(before)}/99-终止原因.md`,
    );
    assertStringIncludes(reason, "素材地基不足");
    assertStringIncludes(reason, "选中主题关联素材：1 条");
  } finally {
    await cleanupNewRunDirs(before);
  }
});
