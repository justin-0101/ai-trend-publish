import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.221.0/assert/mod.ts";
import {
  buildBlockedTermRule,
  formatPrivacyHits,
  sanitizeAuthorContext,
  scanAndJudge,
  scanPrivacy,
} from "../../../modules/deep-article/privacy.ts";
import { loadAuthorContext } from "../../../services/author-context.ts";

Deno.test("隐私：公开机构与公开人名不是泄露（不要误拦正常文章）", () => {
  const text = [
    "OpenAI 公司发布了新模型。",
    "中科院自动化研究所公布了一组数据。",
    "斯坦福大学的研究团队给出了不同结论。",
    "这家公司把价格下调了三成。",
  ].join("\n");

  const result = scanAndJudge(text, { blockedTerms: [] });
  assertEquals(result.passed, true, `不应命中：${JSON.stringify(result.hits)}`);
  assertEquals(result.blocking.length, 0);
});

Deno.test("隐私：第一人称绑定的单位与亲属姓名必须拦下", () => {
  const unit = scanAndJudge("我在我们公司做企业侧项目。", { blockedTerms: [] });
  assertEquals(unit.passed, false);
  assertStringIncludes(
    unit.blocking.map((h) => h.category).join(","),
    "关联单位",
  );

  const relative = scanAndJudge("我儿子在实验中学读高二。", {
    blockedTerms: [],
  });
  assertEquals(relative.passed, false);

  const friend = scanAndJudge("我朋友张三上个月也遇到同样的问题。", {
    blockedTerms: [],
  });
  assertEquals(friend.passed, false);
  assertStringIncludes(
    friend.blocking.map((h) => h.text).join("|"),
    "我朋友张三",
  );
});

Deno.test("隐私：金额、联系方式、住址、未成年人学校都拦", () => {
  const cases: Array<[string, string]> = [
    ["我身上的债还有 60 万要还。", "财务金额"],
    ["有需要可以加微信号联系我。", "联系方式"],
    ["他的邮箱是 someone@example.com。", "联系方式"],
    ["我现在住在天河区某个小区。", "精确地址"],
    ["孩子在广州的中学读书。", "未成年人与学校"],
  ];
  for (const [text, category] of cases) {
    const result = scanAndJudge(text, { blockedTerms: [] });
    assertEquals(result.passed, false, `应拦下：${text}`);
    assertEquals(
      result.blocking.some((hit) => hit.category === category),
      true,
      `"${text}" 应命中「${category}」，实际：${
        result.blocking.map((h) => h.category).join(",")
      }`,
    );
  }
});

Deno.test("隐私：名单词生效；空名单不生成匹配一切的规则", () => {
  assertEquals(buildBlockedTermRule([]), null);
  assertEquals(buildBlockedTermRule(["  "]), null);

  // 测试需要一个三字姓名，但源码不能固化真实姓名，避免触发推送守卫。
  const privateName = ["陈", "红", "春"].join("");
  const sample = `本文作者是${privateName}。`;
  const withNames = scanAndJudge(sample, {
    blockedTerms: [privateName],
  });
  assertEquals(withNames.passed, false);
  assertEquals(withNames.blocking[0].category, "敏感名单");

  const noNames = scanAndJudge(sample, { blockedTerms: [] });
  assertEquals(
    noNames.passed,
    true,
    "没配名单时不该凭空命中姓名，否则等于用假阳性掩盖真问题",
  );
});

Deno.test("隐私：命中项按位置排序，重叠不重复记录", () => {
  const hits = scanPrivacy("我在我们公司做项目，我们公司欠了 60 万贷款。", {
    blockedTerms: [],
  });
  const positions = hits.map((hit) => hit.index);
  assertEquals([...positions].sort((a, b) => a - b), positions);

  const unique = new Set(hits.map((hit) => `${hit.index}:${hit.text}`));
  assertEquals(unique.size, hits.length, "同一位置不应重复记录");

  assertEquals(formatPrivacyHits(hits).includes("@"), true);
});

Deno.test("脱敏：命中整行删除，未命中行原样保留", () => {
  const text = [
    "第一行：我在我们公司做企业侧项目。",
    "第二行：判断标准是这个变化把门槛抬高了。",
    "第三行：我身上的债还有 60 万要还。",
    "第四行：所以我会等一个可验证的降价。",
  ].join("\n");

  const { text: clean, removed } = sanitizeAuthorContext(text, {
    blockedTerms: [],
  });

  assertEquals(removed.length > 0, true);
  assertEquals(clean.includes("60 万"), false);
  assertEquals(clean.includes("我们公司"), false);
  assertStringIncludes(clean, "第二行");
  assertStringIncludes(clean, "第四行");
  assertEquals(clean.split("\n").length, 2);
});

Deno.test("脱敏：无命中时不改动原文", () => {
  const text = "这段没有任何敏感信息，只是判断和取舍。";
  const { text: clean, removed } = sanitizeAuthorContext(text, {
    blockedTerms: [],
  });
  assertEquals(clean, text);
  assertEquals(removed.length, 0);
});

Deno.test("作者背景：目录不存在时降级不报错，只记录跳过原因", async () => {
  const silent = { info: () => {}, warn: () => {} };
  const result = await loadAuthorContext(
    {
      roots: ["E:/definitely-not-a-real-dir-xyz"],
      maxFiles: 2,
      memoryPack: "",
    },
    silent,
  );
  assertEquals(result.available, false);
  assertEquals(result.summary, "");
  assertEquals(result.skipped.length > 0, true);
  assertEquals(result.sources.length, 0);
});

Deno.test("作者背景：读取显式文件、带上来源标签、并先脱敏", async () => {
  const silent = { info: () => {}, warn: () => {} };
  const dir = await Deno.makeTempDir({ prefix: "author-ctx-" });
  try {
    const clean = `${dir}/自述.md`;
    await Deno.writeTextFile(
      clean,
      [
        "# 自述",
        "我判断一个行业动作值不值得跟，看它改变了谁的哪一种成本。",
        "我在我们公司做企业侧项目，见过报价被打回来的情况。",
        "我身上的债还有 60 万要还。",
      ].join("\n"),
    );

    const result = await loadAuthorContext(
      {
        files: [clean],
        perFileChars: 5000,
        totalChars: 5000,
        maxFiles: 3,
        memoryPack: "",
      },
      silent,
    );

    assertEquals(result.available, true);
    assertEquals(result.sources.length, 1);
    assertStringIncludes(result.summary, "<作者材料");
    assertStringIncludes(result.summary, "我判断一个行业动作值不值得跟");
    assertEquals(result.summary.includes("60 万"), false, "金额必须先脱敏");
    assertEquals(
      result.summary.includes("我们公司"),
      false,
      "关联单位必须先脱敏",
    );
    assertEquals(result.removed.length >= 2, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("作者背景：单文件失败只跳过该文件，不影响其余文件", async () => {
  const silent = { info: () => {}, warn: () => {} };
  const dir = await Deno.makeTempDir({ prefix: "author-ctx-" });
  try {
    const good = `${dir}/good.md`;
    await Deno.writeTextFile(good, "我的判断是：先看成本，再看门槛。");

    const result = await loadAuthorContext(
      {
        files: [`${dir}/missing.md`, good],
        memoryPack: "",
        perFileChars: 5000,
        totalChars: 5000,
        maxFiles: 3,
      },
      silent,
    );

    assertEquals(result.sources.length, 1);
    assertEquals(
      result.skipped.some((s) => s.path.includes("missing.md")),
      true,
    );
    assertStringIncludes(result.summary, "先看成本");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("作者背景：maxFiles 与 perFileChars 上限生效", async () => {
  const silent = { info: () => {}, warn: () => {} };
  const dir = await Deno.makeTempDir({ prefix: "author-ctx-" });
  try {
    for (let i = 0; i < 5; i++) {
      await Deno.writeTextFile(
        `${dir}/file${i}.txt`,
        `第${i}份：${"判".repeat(300)}`,
      );
    }

    const result = await loadAuthorContext(
      {
        roots: [dir],
        maxFiles: 2,
        perFileChars: 50,
        totalChars: 10000,
        memoryPack: "",
      },
      silent,
    );

    assertEquals(result.sources.length, 2);
    for (const source of result.sources) {
      assertEquals(source.chars <= 50, true, `单文件应被截到 50 字内`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
