/**
 * 依赖仓库外的写作 skill（默认 F:\wechat-skills\write-ai-wechat-article，
 * 可用 DEEP_ARTICLE_SKILL_ROOT 覆盖）。skill 不在本仓库里，所以换台机器、
 * 或把 skill 目录移走时，这个文件会整体失败——这是刻意的：
 * 用 ignore 静默跳过会掩盖「这条链路根本没在工作」。
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildStepSystemParts,
  extractMarkdownSection,
  getSkillRoot,
  getStepInstruction,
  listLanes,
  loadSkill,
  SkillLoaderError,
  truncateAtParagraph,
} from "../../../modules/deep-article/skill-loader.ts";

Deno.test("skill-loader - 能定位 skill 根并读到步骤表", async () => {
  const skill = await loadSkill();
  const root = await getSkillRoot();
  assertEquals(root, skill.root);
  assertEquals(skill.map.name, "write-ai-wechat-article");
  const stepKeys = Object.keys(skill.map.steps);
  for (
    const required of [
      "topic-package",
      "author-stance",
      "lane-routing",
      "material-gap",
      "evidence-lock",
      "thesis",
      "archetype-craft",
      "draft",
      "fact-recheck",
      "review-1",
      "review-2",
      "review-3",
      "review-score",
    ]
  ) {
    assertEquals(stepKeys.includes(required), true, `缺少步骤 ${required}`);
  }
  console.log(`✓ skill 根: ${skill.root}，步骤数: ${stepKeys.length}`);
});

Deno.test("skill-loader - 五领域都在 laneSections 里", async () => {
  const lanes = await listLanes();
  assertEquals(lanes.length, 5);
  assertStringIncludes(lanes.join("|"), "AI 行业与技术观察");
  console.log(`✓ 五领域: ${lanes.join(" / ")}`);
});

Deno.test("skill-loader - extractMarkdownSection 取到正确章节且不越界", () => {
  const md = [
    "# 标题",
    "",
    "## 甲",
    "",
    "甲的内容",
    "",
    "### 甲的细节",
    "",
    "细节内容",
    "",
    "## 乙",
    "",
    "乙的内容",
  ].join("\n");

  const jia = extractMarkdownSection(md, "## 甲");
  assertEquals(jia?.includes("甲的内容"), true);
  assertEquals(jia?.includes("细节内容"), true, "应包含更深层子标题");
  assertEquals(jia?.includes("乙的内容"), false, "不应越界到同级标题");

  const yi = extractMarkdownSection(md, "## 乙");
  assertEquals(yi?.includes("甲的内容"), false);

  assertEquals(extractMarkdownSection(md, "## 丙"), null);
  // 命中行不是标题（没有 # 号）时必须返回 null，而不是把剩余全文当一章送出去
  assertEquals(extractMarkdownSection(md, "甲的内容"), null);
  assertEquals(extractMarkdownSection(md, ""), null);
});

Deno.test("skill-loader - truncateAtParagraph 只在段落边界截断并留标记", () => {
  const text = ["A".repeat(100), "B".repeat(100), "C".repeat(100)].join("\n\n");

  const untouched = truncateAtParagraph(text, 10000);
  assertEquals(untouched, text);

  const cut = truncateAtParagraph(text, 150);
  assertEquals(cut.endsWith("[本段已截断：完整内容见 skill 原文]"), true);
  assertEquals(
    cut.includes("B".repeat(100)),
    false,
    "超出上限的段落必须被切掉",
  );
  assertEquals(cut.startsWith("A".repeat(100)), true);
});

Deno.test("skill-loader - 每次注入都带隐私红线与观察者位", async () => {
  const parts = await buildStepSystemParts("author-stance", {
    lane: "AI 行业与技术观察",
  });
  const joined = parts.join("\n");
  assertStringIncludes(joined, "红线：references/privacy-redaction.md");
  assertStringIncludes(joined, "红线：references/observer-stance.md");
  assertStringIncludes(joined, "写作原则");
  console.log(
    `✓ author-stance 注入 ${parts.length} 段，共 ${joined.length} 字`,
  );
});

Deno.test("skill-loader - includeLaneSection 的步骤会注入对应领域链路", async () => {
  const parts = await buildStepSystemParts("draft", {
    lane: "AI + 家庭教育",
  });
  const joined = parts.join("\n");
  assertStringIncludes(joined, "本篇主领域链路：AI + 家庭教育");
  assertStringIncludes(joined, "亲子场景或冲突");
  assertEquals(joined.includes("AI 行业与技术观察"), false, "不应混入其他领域");

  const other = (await buildStepSystemParts("draft", {
    lane: "AI 行业与技术观察",
  })).join("\n");
  assertStringIncludes(other, "行业事件");
  console.log("✓ 领域链路按 lane 精确注入，不串领域");
});

Deno.test("skill-loader - material-gap 明确区分可抓取与一手来源", async () => {
  const parts = await buildStepSystemParts("material-gap");
  const joined = parts.join("\n");
  assertStringIncludes(joined, "页面可打开不等于一手来源");
  const instruction = await getStepInstruction("material-gap");
  assertStringIncludes(instruction, "可抓取不等于一手来源");
  assertStringIncludes(instruction, "单条素材若只是媒体");
});

Deno.test("skill-loader - 需要领域却没给、或领域名不存在时明确报错", async () => {
  await assertRejects(
    () => buildStepSystemParts("draft"),
    SkillLoaderError,
    "需要主领域",
  );
  await assertRejects(
    () => buildStepSystemParts("draft", { lane: "AI + 玄学" }),
    SkillLoaderError,
    "不在 laneSections 里",
  );
});

Deno.test("skill-loader - 未知步骤报错并列出可用步骤", async () => {
  await assertRejects(
    () => getStepInstruction("not-a-step"),
    SkillLoaderError,
    "可用步骤",
  );
});

Deno.test("skill-loader - 每步指令都要求 JSON 输出", async () => {
  const skill = await loadSkill();
  for (const [key, step] of Object.entries(skill.map.steps)) {
    assertStringIncludes(
      step.instruction,
      "JSON",
      `步骤 ${key} 未要求 JSON 输出`,
    );
  }
});
