/**
 * TypeSafe System One（Jev）HTTP 契约。
 *
 * 依据：`https://api.typesafe.ai/openapi.json`（匿名可读，2026-09-27 抓取，14KB）。
 * 字段名**不是**照官方文档页猜的 —— 那份 API reference 页抽取后字段有歧义，
 * 这里以 OpenAPI 为准，落地前不需要再发一次真实请求校准：
 *
 *   ScoreQuestion: { type: "score", criteria: Content[]（必填）, instructions?: Content|null }
 *   ScoreAnswer:   { type: "score", score: number, confidence: number,
 *                    legend: Record<string, Content>, probabilities: Record<string, number> }
 *   SystemOneRequest:  { state, model, questions }  三者皆必填
 *   SystemOneResponse: { model, answers, usage }    usage 必填
 *
 * 注意两个易错点（原执行方案 4.1 节写错过）：
 *   1. `noul` 问题**没有** `noul` 字段，问句写在 `instructions` 里，可选 `criteria:{true,false}`；
 *   2. `NoulAnswer` **没有** confidence —— 官方只对 score / choice 返回置信度。
 */

/** 档位描述、问句、state 都允许 string / object / array 三种形态 */
export type SystemOneContent =
  | string
  | Record<string, unknown>
  | unknown[];

export interface ScoreQuestion {
  type: "score";
  /** 让模型评什么 */
  instructions?: SystemOneContent | null;
  /**
   * 有序档位：位置即分数，从 0 起，低档在前。
   * OpenAPI 的 minItems 是 1，官方文档建议至少 2 档；上限 10 档。
   */
  criteria: SystemOneContent[];
}

export interface NoulCriteria {
  /** 什么算「是」 */
  true?: SystemOneContent | null;
  /** 什么算「否」 */
  false?: SystemOneContent | null;
}

export interface NoulQuestion {
  type: "noul";
  instructions?: SystemOneContent | null;
  criteria?: NoulCriteria | null;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions?: SystemOneContent | null;
  /** 选项名 → 什么情况下选它（值可为 null，只用名字） */
  criteria: Record<string, SystemOneContent | null>;
}

export type SystemOneQuestion = ScoreQuestion | NoulQuestion | ChoiceQuestion;

export interface SystemOneRequest {
  /** 所有问题共同针对的内容 */
  state: SystemOneContent;
  model: string;
  questions: Record<string, SystemOneQuestion>;
}

export interface ScoreAnswer {
  type: "score";
  /** 档位轴上的概率加权平均，可落在两档之间，范围 0 .. criteria.length - 1 */
  score: number;
  /** 0–1，越大越确定 */
  confidence: number;
  /** 档位编号（字符串 key）→ 档位描述 */
  legend: Record<string, SystemOneContent>;
  /** 档位编号（字符串 key）→ 该档概率，合计约 1 */
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: "noul";
  /** 0–1，越接近 1 越像「是」 */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export type SystemOneAnswer = ScoreAnswer | NoulAnswer | ChoiceAnswer;

export interface SystemOneUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResponse {
  /** 实际作答的版本号，例如 jev-1.13.0（可能与请求里的别名不同） */
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: SystemOneUsage;
}

/** `GET /v1/models` 返回的一项 */
export interface SystemOneModelMetadata {
  name: string;
  description: string;
  release_date: string;
}
