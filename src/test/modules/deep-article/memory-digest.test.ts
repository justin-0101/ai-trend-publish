import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.221.0/assert/mod.ts";
import {
  buildMemoryDigest,
  DEFAULT_MEMORY_ALLOW,
  DEFAULT_MEMORY_DENY,
  parseSections,
} from "../../../modules/deep-article/memory-digest.ts";
import {
  discoverMemoryPack,
  loadAuthorContext,
} from "../../../services/author-context.ts";

/** 模拟记忆包的形状：既有观点/原则，也有时间线、家庭与财务这类事实。 */
const memoryPack = [
  "# 某人 · Agent 记忆包",
  "",
  "## 一、时间线",
  "1999—2003 就读某商学院。2020-06 至今在某公司负责商务。",
  "",
  "## 二、家庭与现状（敏感）",
  "两个孩子，一个读高三。负债 60 多万，月收入 7 千。",
  "",
  "## 三、性格结构",
  "",
  "### 3.1 稳定优势",
  "做事先拆成本，习惯把判断写成条件句。",
  "",
  "### 3.3 MBTI 交叉验证要点",
  "自测 INTJ-A。",
  "",
  "## 四、世界观 / 人生观",
  "世界不欠谁一个解法，能改的是可观察的那几个变量。",
  "",
  "## 五、职业操作系统",
  "",
  "### 5.5 职业决策默认原则",
  "先算最坏损失能不能承受，再谈收益。",
  "",
  "### 5.6 项目评分表",
  "每项 0—5 分，七项加总。",
  "",
  "## 六、表达层",
  "",
  "### 6.4 语言偏好",
  "短句，先结论后依据，慎用绝对词。",
  "",
  "### 6.5 分场景规则",
  "对内一条消息一个动作。",
  "",
  "## 十一、附录",
  "",
  "### 11.1 价值冲突时的默认排序",
  "现金流 > 家庭 > 长期复利。",
  "",
  "### 11.3 权限边界",
  "不得代发消息。",
].join("\n");

Deno.test("章节切分：子标题各自成块，并带祖先链", () => {
  const sections = parseSections(memoryPack);
  const leaf = sections.find((s) => s.heading.includes("5.5"));
  assertEquals(leaf !== undefined, true);
  assertEquals(
    leaf!.path.join(" > "),
    "五、职业操作系统 > 5.5 职业决策默认原则",
    "H1 文档标题不应出现在祖先链里",
  );
  assertStringIncludes(leaf!.body, "先算最坏损失");

  const top = sections.find((s) => s.heading.includes("四、世界观"));
  assertEquals(top!.body.includes("世界不欠谁"), true);
  assertEquals(top!.path.length, 1);
});

Deno.test("默认全不放行：只留下认知、观点、价值观、原则类章节", () => {
  const digest = buildMemoryDigest(memoryPack);
  assertEquals(digest.available, true);

  const kept = digest.kept.map((item) => item.heading).join("|");
  assertStringIncludes(kept, "3.1 稳定优势");
  assertStringIncludes(kept, "四、世界观 / 人生观");
  assertStringIncludes(kept, "5.5 职业决策默认原则");
  assertStringIncludes(kept, "6.4 语言偏好");
  assertStringIncludes(kept, "11.1 价值冲突时的默认排序");

  assertEquals(kept.includes("MBTI"), false, "MBTI 在拒绝清单里");
  assertEquals(kept.includes("评分表"), false, "评分表在拒绝清单里");
  assertEquals(kept.includes("分场景规则"), false);
  assertEquals(kept.includes("权限边界"), false);
});

Deno.test("事实性章节一个字都不进摘要", () => {
  const digest = buildMemoryDigest(memoryPack);
  for (const forbidden of ["1999", "商学院", "60 多万", "7 千", "高三", "某公司"]) {
    assertEquals(
      digest.text.includes(forbidden),
      false,
      `摘要里不应出现「${forbidden}」`,
    );
  }
  assertEquals(digest.text.includes("时间线"), false);
  assertEquals(digest.text.includes("家庭与现状"), false);
});

Deno.test("被跳过的章节都留下原因，便于审计", () => {
  const digest = buildMemoryDigest(memoryPack);
  const byHeading = new Map(
    digest.dropped.map((item) => [item.heading, item.reason]),
  );
  assertEquals(byHeading.get("一、时间线"), "命中拒绝清单");
  assertEquals(byHeading.get("二、家庭与现状（敏感）"), "命中拒绝清单");
  assertEquals(byHeading.get("3.3 MBTI 交叉验证要点"), "命中拒绝清单");
  assertEquals(byHeading.get("5.6 项目评分表"), "命中拒绝清单");
});

Deno.test("deny 优先于 allow：同一章节同时命中两边时拒收", () => {
  const digest = buildMemoryDigest(
    ["## 原则与来源", "这条不应被送出。"].join("\n"),
    { allow: ["原则"], deny: ["来源"] },
  );
  assertEquals(digest.available, false);
  assertEquals(digest.dropped[0].reason, "命中拒绝清单");
});

Deno.test("无匹配、空输入都返回 available=false，而不是回退送全文", () => {
  assertEquals(buildMemoryDigest("").available, false);
  assertEquals(buildMemoryDigest("## 随便一节\n内容").available, false);
  assertEquals(
    buildMemoryDigest("## 随便一节\n内容", { allow: ["随便"] }).available,
    true,
  );
});

Deno.test("字数上限在段落边界截断，并标注已截断", () => {
  const long = [
    "## 四、世界观 / 人生观",
    "第一段".repeat(60),
    "",
    "第二段".repeat(60),
    "",
    "第三段".repeat(60),
  ].join("\n");
  const digest = buildMemoryDigest(long, { maxChars: 400 });
  assertEquals(digest.text.length <= 400 + 40, true);
  assertStringIncludes(digest.text, "已按字数上限截断");
  assertStringIncludes(digest.text, "第一段");
});

Deno.test("默认清单本身是可读的常量，便于人工核对", () => {
  assertEquals(DEFAULT_MEMORY_ALLOW.includes("世界观"), true);
  assertEquals(DEFAULT_MEMORY_DENY.includes("家庭与现状"), true);
  assertEquals(DEFAULT_MEMORY_DENY.includes("时间线"), true);
});

Deno.test("作者背景：记忆包摘要只含观点，事实与金额不进 summary", async () => {
  const silent = { info: () => {}, warn: () => {} };
  const dir = await Deno.makeTempDir({ prefix: "author-ctx-memory-" });
  try {
    const pack = `${dir}/memory.md`;
    await Deno.writeTextFile(pack, memoryPack);

    const result = await loadAuthorContext(
      {
        roots: [`${dir}/not-exist`],
        memoryPack: pack,
        memoryChars: 5000,
      },
      silent,
    );

    assertEquals(result.available, true, "只有记忆包也算有背景");
    assertEquals(result.memory.available, true);
    assertStringIncludes(result.summary, "<作者认知与原则");
    assertStringIncludes(result.summary, "先算最坏损失");
    assertStringIncludes(result.summary, "世界不欠谁");
    for (const forbidden of ["60 多万", "7 千", "商学院", "时间线"]) {
      assertEquals(
        result.summary.includes(forbidden),
        false,
        `注入内容里不应出现「${forbidden}」`,
      );
    }
    assertEquals(result.memory.path, pack);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("作者背景：记忆包路径不存在时降级，不回退送整包", async () => {
  const silent = { info: () => {}, warn: () => {} };
  const dir = await Deno.makeTempDir({ prefix: "author-ctx-memory-" });
  try {
    const result = await loadAuthorContext(
      {
        roots: [`${dir}/not-exist`],
        memoryPack: `${dir}/no-such-memory.md`,
      },
      silent,
    );
    assertEquals(result.available, false);
    assertEquals(result.memory.available, false);
    assertEquals(result.memory.text, "");
    assertEquals(result.summary, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("作者背景：记忆包章节筛选后再过一遍脱敏（第二道网）", async () => {
  const silent = { info: () => {}, warn: () => {} };
  const dir = await Deno.makeTempDir({ prefix: "author-ctx-memory-" });
  try {
    const pack = `${dir}/memory.md`;
    await Deno.writeTextFile(
      pack,
      [
        "## 四、世界观 / 人生观",
        "我在我们公司形成的判断是：先看成本。",
        "判断标准本身是干净的。",
      ].join("\n"),
    );

    const result = await loadAuthorContext(
      { roots: [`${dir}/not-exist`], memoryPack: pack },
      silent,
    );

    assertEquals(result.memory.available, true);
    assertEquals(result.memory.removedBySanitizer >= 1, true);
    assertEquals(result.summary.includes("我们公司"), false);
    assertStringIncludes(result.summary, "判断标准本身是干净的");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("记忆包发现：按 memory 文件名与最新修改时间挑选", async () => {
  const dir = await Deno.makeTempDir({ prefix: "memory-discover-" });
  try {
    await Deno.writeTextFile(`${dir}/other.md`, "x");
    await Deno.writeTextFile(`${dir}/chen-memory.md`, "y");
    const found = await discoverMemoryPack(dir);
    assertEquals(found?.endsWith("chen-memory.md"), true);

    assertEquals(await discoverMemoryPack(`${dir}/not-exist`), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
