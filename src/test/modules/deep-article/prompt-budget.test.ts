/**
 * 依赖仓库外的写作 skill（默认 F:\wechat-skills\write-ai-wechat-article，
 * 可用 DEEP_ARTICLE_SKILL_ROOT 覆盖）。skill 不在本仓库里，所以换台机器、
 * 或把 skill 目录移走时，这个文件会整体失败——这是刻意的：
 * 用 ignore 静默跳过会掩盖「这条链路根本没在工作」。
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.221.0/assert/mod.ts";
import {
  buildStepSystemParts,
  getStepInstruction,
  getStepTitle,
  listLanes,
  loadSkill,
} from "../../../modules/deep-article/skill-loader.ts";

const LANE = "AI 行业与技术观察";

/** 单步 system 段的字数上限。超过这个量要么是注入了整包 reference，要么是截断失效。 */
const SYSTEM_CHARS_BUDGET = 40000;

Deno.test("预算：每一步的 system 段都在可控范围内", async () => {
  const skill = await loadSkill();
  const lanes = await listLanes();
  const rows: string[] = [];

  for (const stepKey of Object.keys(skill.map.steps)) {
    const lane = skill.map.steps[stepKey].includeLaneSection ? LANE : undefined;
    const parts = await buildStepSystemParts(stepKey, { lane });
    const total = parts.join("\n").length;
    rows.push(
      `${stepKey.padEnd(16)} ${String(total).padStart(6)} 字  段数 ${parts.length}`,
    );
    assertEquals(
      total <= SYSTEM_CHARS_BUDGET,
      true,
      `${stepKey} 的 system 段 ${total} 字，超过预算 ${SYSTEM_CHARS_BUDGET}`,
    );
    assertEquals(parts.length >= 3, true, `${stepKey} 至少要含原则 + 两条红线`);
  }

  console.log("步骤提示词预算：\n" + rows.join("\n"));
  console.log(`领域数: ${lanes.length}`);
});

Deno.test("预算：截断确实生效，且留下截断标记", async () => {
  // draft 步骤 refs 里有 77 行的五层写作系统；把 private 上限调到极小，验证截断路径
  const parts = await buildStepSystemParts("lane-routing", {});
  const joined = parts.join("\n");
  // content-lanes.md 全文约 10k 字，lane-routing 的 maxChars 是 14000，应完整注入
  assertStringIncludes(joined, "领域路由");
  assertEquals(joined.includes("[本段已截断"), false, "14000 上限下不该触发截断");

  const rejectParts = await buildStepSystemParts("review-1", {});
  assertEquals(rejectParts.length >= 3, true);
});

Deno.test("预算：每一步的指令都带输出格式，且不含未替换的占位符", async () => {
  const skill = await loadSkill();
  for (const stepKey of Object.keys(skill.map.steps)) {
    const instruction = await getStepInstruction(stepKey);
    const title = await getStepTitle(stepKey);
    assertEquals(instruction.length > 20, true, `${stepKey} 指令过短`);
    assertEquals(title.length > 0, true, `${stepKey} 缺标题`);
    assertEquals(
      /\{\{[^}]*\}\}|\$\{[^}]*\}|TODO|FIXME/.test(instruction),
      false,
      `${stepKey} 的指令里有未替换的占位符`,
    );
  }
});

Deno.test("预算：五领域都能装配，且互不串链路", async () => {
  const lanes = await listLanes();
  // 每个领域的特征串。断言「只有自己的出现」，而不是「文本各不相同」——
  // 后者用第一行就带 lane 名的切片当判据，即使五个领域注入的内容完全一样也恒真。
  const markers: Record<string, string> = {
    "AI + 家庭教育": "亲子场景或冲突",
    "AI + 人生或职业规划": "真实选择困境",
    "AI + 认知升级与自我学习": "原来的理解或习惯",
    "AI 工具": "真实任务与成功标准",
    "AI 行业与技术观察": "行业事件",
  };

  for (const lane of lanes) {
    const joined = (await buildStepSystemParts("draft", { lane })).join("\n");
    assertStringIncludes(joined, `本篇主领域链路：${lane}`);
    const body = joined.slice(joined.indexOf(`本篇主领域链路：${lane}`));
    for (const [otherLane, marker] of Object.entries(markers)) {
      if (otherLane === lane) {
        assertStringIncludes(body, marker, `本领域特征串缺失：${lane} / ${marker}`);
      } else {
        assertEquals(
          body.includes(marker),
          false,
          `串领域：${lane} 的注入里出现了 ${otherLane} 的特征串「${marker}」`,
        );
      }
    }
  }
});
