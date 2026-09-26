import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.221.0/assert/mod.ts";
import {
  AUTOMATION_PUBLISH_STATUS,
  collectHardGateFailures,
  evaluateGate,
  formatGateReport,
  KEY_DIMENSION_MIN,
  PUBLISH_MIN_TOTAL,
  RUBRIC_TOTAL_MAX,
} from "../../../modules/deep-article/review-gate.ts";

const fullMarks = {
  materials: 20,
  mechanism: 20,
  authorship: 20,
  evidence: 15,
  structure: 10,
  usefulness: 10,
  titlePublish: 5,
};

Deno.test("量表上限合计 100，通过线 80，关键项下限 12", () => {
  assertEquals(RUBRIC_TOTAL_MAX, 100);
  assertEquals(PUBLISH_MIN_TOTAL, 80);
  assertEquals(KEY_DIMENSION_MIN, 12);
});

Deno.test("满分 → 机器达标", () => {
  const result = evaluateGate({ dimensions: fullMarks });
  assertEquals(result.scored, true);
  assertEquals(result.total, 100);
  assertEquals(result.machinePass, true);
  assertEquals(result.status, "机器达标");
  assertEquals(result.reasons, []);
});

Deno.test("总分由代码相加，忽略超范围的分值", () => {
  const result = evaluateGate({
    dimensions: {
      materials: 999,
      mechanism: 20,
      authorship: 20,
      evidence: 15,
      structure: 10,
      usefulness: 10,
      titlePublish: 5,
    },
  });
  assertEquals(result.dimensions.materials, 20, "材料分必须夹到 20");
  assertEquals(result.total, 100);
});

Deno.test("总分低于 80 → 未达标，理由是总分不足", () => {
  const result = evaluateGate({
    dimensions: { ...fullMarks, structure: 0, usefulness: 0, titlePublish: 0, evidence: 10 },
  });
  assertEquals(result.total, 85 - 5 - 10, "20+20+20+10+0+0+0");
  assertEquals(result.machinePass, false);
  assertEquals(result.reasons.some((r) => r.includes("总分")), true);
});

Deno.test("关键三项任一项低于 12：总分再高也不通过", () => {
  const cases = [
    { materials: 11, expected: "材料与具体性" },
    { mechanism: 5, expected: "观点与机制" },
    { authorship: 9, expected: "作者性" },
  ];
  for (const testCase of cases) {
    const result = evaluateGate({
      dimensions: { ...fullMarks, ...testCase },
    });
    assertEquals(result.machinePass, false, `${testCase.expected} 低分必须拦住`);
    assertEquals(
      result.reasons.some((r) => r.includes(testCase.expected)),
      true,
      `理由里要点名 ${testCase.expected}，实际：${result.reasons.join("；")}`,
    );
  }
});

Deno.test("总分高但作者性只有 11 → 仍然不通过（观察者位最容易踩的坑）", () => {
  const result = evaluateGate({
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
  assertEquals(result.total, 91, "总分 91 高于 80");
  assertEquals(result.machinePass, false, "作者性 11 < 12 必须拦住");
  assertEquals(result.status, "未达标");
});

Deno.test("硬门槛失败 → 不评分，并带出需退回阶段", () => {
  const result = evaluateGate({
    hardGateFailed: "正文能把公开故事改写成作者亲历",
    returnStage: "起草",
    dimensions: fullMarks,
  });
  assertEquals(result.scored, false);
  assertEquals(result.machinePass, false);
  assertEquals(result.status, "硬门槛失败");
  assertEquals(result.total, 0, "不评分时总分不呈现，避免被误读成通过了");
  assertEquals(result.returnStage, "起草");
  assertStringIncludes(result.reasons.join(""), "硬门槛");
});

Deno.test("发布状态永远停在需作者阅读确认，不会被模型分数升格", () => {
  const pass = evaluateGate({ dimensions: fullMarks });
  const fail = evaluateGate({ dimensions: { materials: 1 } });
  const hard = evaluateGate({ hardGateFailed: "泄露未成年人信息" });
  for (const result of [pass, fail, hard]) {
    assertEquals(result.publishStatus, AUTOMATION_PUBLISH_STATUS);
    assertStringIncludes(result.publishStatus, "需作者阅读确认");
  }
});

Deno.test("从三轮审稿输出里汇总硬门槛", () => {
  assertEquals(collectHardGateFailures([{ scored: true }, { scored: true }]), {});
  assertEquals(
    collectHardGateFailures([
      { scored: true },
      { hardGateFailed: "标题承诺正文没有回答的问题", returnStage: "起草" },
      { hardGateFailed: "后一条不该覆盖前一条" },
    ]),
    { hardGateFailed: "标题承诺正文没有回答的问题", returnStage: "起草" },
  );
  assertEquals(
    collectHardGateFailures([{ hardGateFailed: "   " }, { scored: true }]),
    {},
  );
});

Deno.test("闸门报告可用于审稿报告落盘", () => {
  const report = formatGateReport(evaluateGate({ dimensions: fullMarks }));
  assertStringIncludes(report, "机器达标");
  assertStringIncludes(report, "100 / 100");
  assertStringIncludes(report, "材料与具体性");
  assertStringIncludes(report, "不等于可发布");

  const failed = formatGateReport(
    evaluateGate({ hardGateFailed: "缺少核心判断", returnStage: "立论" }),
  );
  assertStringIncludes(failed, "需退回阶段：立论");
});
