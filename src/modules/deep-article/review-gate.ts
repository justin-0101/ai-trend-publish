import { clampScore } from "./llm-json.ts";

/**
 * 审稿闸门（纯函数）。
 *
 * 对应 skill 的 `references/review-rubric.md`：总分 ≥80，且「材料」「观点机制」
 * 「作者性」三项各 ≥12，才算通过量表。
 *
 * 两条不可协商的约定：
 *   1. 总分由代码相加，不采用模型自报的总分；
 *   2. 通过量表只表示「机器达标」，**不表示可以发布**。skill 明确写了作者本人的
 *      阅读反馈高于量表分数，所以 `publishStatus` 永远停在「需作者阅读确认」，
 *      自动化流程不得自行升格。
 */

export const RUBRIC_MAX = {
  materials: 20,
  mechanism: 20,
  authorship: 20,
  evidence: 15,
  structure: 10,
  usefulness: 10,
  titlePublish: 5,
} as const;

export type RubricDimension = keyof typeof RUBRIC_MAX;

export const RUBRIC_TOTAL_MAX = Object.values(RUBRIC_MAX).reduce(
  (sum, value) => sum + value,
  0,
);

export const PUBLISH_MIN_TOTAL = 80;
export const KEY_DIMENSION_MIN = 12;

/** 三项关键维度：任一项低于 12，总分再高也不得通过 */
export const KEY_DIMENSIONS: RubricDimension[] = [
  "materials",
  "mechanism",
  "authorship",
];

export const DIMENSION_LABELS: Record<RubricDimension, string> = {
  materials: "材料与具体性",
  mechanism: "观点与机制",
  authorship: "作者性",
  evidence: "证据与边界",
  structure: "结构与节奏",
  usefulness: "对读者的用处",
  titlePublish: "标题与发布",
};

export type MachineStatus = "机器达标" | "未达标" | "硬门槛失败";

/** 自动化流程能给出的最高状态。发布状态只有作者本人能给。 */
export const AUTOMATION_PUBLISH_STATUS = "需作者阅读确认（机器不代签）";

export interface GateInput {
  /** 任一硬门槛被触发时填原因；非空则停止评分 */
  hardGateFailed?: string;
  /** 需要退回的阶段，硬门槛失败时一并带出 */
  returnStage?: string;
  dimensions?: Partial<Record<RubricDimension, unknown>>;
}

export interface GateResult {
  /** 是否进入评分。硬门槛失败时为 false */
  scored: boolean;
  dimensions: Record<RubricDimension, number>;
  total: number;
  totalMax: number;
  machinePass: boolean;
  status: MachineStatus;
  publishStatus: string;
  /** 未通过的具体原因 */
  reasons: string[];
  hardGateFailed?: string;
  returnStage?: string;
}

export const evaluateGate = (input: GateInput = {}): GateResult => {
  const dimensions = {} as Record<RubricDimension, number>;
  for (const key of Object.keys(RUBRIC_MAX) as RubricDimension[]) {
    dimensions[key] = clampScore(input.dimensions?.[key], RUBRIC_MAX[key]);
  }

  const total = Math.round(
    (Object.values(dimensions).reduce((sum, value) => sum + value, 0)) * 10,
  ) / 10;

  const hardGateFailed = input.hardGateFailed?.trim();
  if (hardGateFailed) {
    return {
      scored: false,
      dimensions,
      total: 0,
      totalMax: RUBRIC_TOTAL_MAX,
      machinePass: false,
      status: "硬门槛失败",
      publishStatus: AUTOMATION_PUBLISH_STATUS,
      reasons: [`触发发布硬门槛，停止评分：${hardGateFailed}`],
      hardGateFailed,
      returnStage: input.returnStage?.trim() || undefined,
    };
  }

  const reasons: string[] = [];
  if (total < PUBLISH_MIN_TOTAL) {
    reasons.push(`总分 ${total} 低于 ${PUBLISH_MIN_TOTAL}`);
  }
  for (const key of KEY_DIMENSIONS) {
    if (dimensions[key] < KEY_DIMENSION_MIN) {
      reasons.push(
        `${DIMENSION_LABELS[key]} ${dimensions[key]} 低于 ${KEY_DIMENSION_MIN}`,
      );
    }
  }

  const machinePass = reasons.length === 0;
  return {
    scored: true,
    dimensions,
    total,
    totalMax: RUBRIC_TOTAL_MAX,
    machinePass,
    status: machinePass ? "机器达标" : "未达标",
    publishStatus: AUTOMATION_PUBLISH_STATUS,
    reasons,
  };
};

/** 从模型输出里抽出硬门槛字段；rounds 为各轮审稿返回的对象。 */
export const collectHardGateFailures = (
  rounds: Array<unknown>,
): { hardGateFailed?: string; returnStage?: string } => {
  for (const round of rounds) {
    const record = round as { hardGateFailed?: unknown; returnStage?: unknown } | null;
    const reason = typeof record?.hardGateFailed === "string"
      ? record.hardGateFailed.trim()
      : "";
    if (reason) {
      const stage = typeof record?.returnStage === "string"
        ? record.returnStage.trim()
        : "";
      return { hardGateFailed: reason, returnStage: stage || undefined };
    }
  }
  return {};
};

/** 渲染成可粘进审稿报告的文本。 */
export const formatGateReport = (result: GateResult): string => {
  const lines = [
    `## 审稿闸门`,
    ``,
    `- 状态：**${result.status}**`,
    `- 总分：${result.total} / ${result.totalMax}（通过线 ${PUBLISH_MIN_TOTAL}）`,
    `- 关键三项下限：${KEY_DIMENSION_MIN}`,
    `- 发布状态：${result.publishStatus}`,
    ``,
    `| 维度 | 得分 | 上限 |`,
    `|---|---:|---:|`,
  ];
  for (const key of Object.keys(RUBRIC_MAX) as RubricDimension[]) {
    lines.push(`| ${DIMENSION_LABELS[key]} | ${result.dimensions[key]} | ${RUBRIC_MAX[key]} |`);
  }
  if (result.reasons.length > 0) {
    lines.push(``, `未通过原因：`);
    for (const reason of result.reasons) lines.push(`- ${reason}`);
  }
  if (result.returnStage) {
    lines.push(``, `需退回阶段：${result.returnStage}`);
  }
  lines.push(
    ``,
    `> 说明：机器达标只代表通过量表。skill 规定作者本人实际阅读反馈高于量表分数，` +
      `因此本状态不等于可发布；发布前需作者阅读确认。`,
  );
  return lines.join("\n");
};
