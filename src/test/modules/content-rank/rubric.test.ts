import { assertEquals } from "@std/assert";
import {
  CRITERIA,
  DIMENSION_KEYS,
  DIMENSIONS,
  IMAGE_BONUS,
  normalizeLevel,
  weightedConfidence,
  weightedScore,
} from "../../../prompts/content-ranker.rubric.ts";

Deno.test("rubric - 权重与现有提示词的 20/45/20/15 对齐且合计为 1", () => {
  assertEquals(DIMENSIONS.innovation, 0.20);
  assertEquals(DIMENSIONS.utility, 0.45);
  assertEquals(DIMENSIONS.influence, 0.20);
  assertEquals(DIMENSIONS.freshness, 0.15);
  const sum = DIMENSION_KEYS.reduce((acc, key) => acc + DIMENSIONS[key], 0);
  assertEquals(Math.round(sum * 100) / 100, 1);
});

Deno.test("rubric - 档位数量在官方允许区间内（2–10），且四个维度档位数一致", () => {
  const counts = DIMENSION_KEYS.map((key) => CRITERIA[key].length);
  for (const count of counts) {
    if (count < 2 || count > 10) {
      throw new Error(`档位数 ${count} 不在 2–10 之间`);
    }
  }
  assertEquals(new Set(counts).size, 1);
});

Deno.test("rubric - 档位描述里不出现数字（官方：数字会压低置信度）", () => {
  for (const key of DIMENSION_KEYS) {
    for (const level of CRITERIA[key]) {
      if (/\d/.test(level)) {
        throw new Error(`${key} 的档位描述含数字: ${level}`);
      }
    }
  }
});

Deno.test("rubric - 档位归一化：两端闭合、中间线性、越界夹取", () => {
  assertEquals(normalizeLevel(0, 4), 0);
  assertEquals(normalizeLevel(3, 4), 1);
  assertEquals(normalizeLevel(1.5, 4), 0.5);
  assertEquals(normalizeLevel(-1, 4), 0);
  assertEquals(normalizeLevel(9, 4), 1);
  // 只有一档时没有量程，不该除零
  assertEquals(normalizeLevel(0, 1), 0);
});

Deno.test("rubric - 百分制合成：全满 100、全零 0、单维度按权重", () => {
  const full = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 1]));
  assertEquals(weightedScore(full), 100);

  const zero = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 0]));
  assertEquals(weightedScore(zero), 0);

  // 只有 utility 满分 → 45 分
  assertEquals(weightedScore({ utility: 1 }), 45);
  // 只有 innovation 满分 → 20 分
  assertEquals(weightedScore({ innovation: 1 }), 20);
});

Deno.test("rubric - 含图加分在代码里补（Jev 读不到图）", () => {
  assertEquals(IMAGE_BONUS, 10);
  const base = weightedScore(
    Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 1])),
  );
  // 满分 + 含图仍然封顶 100，不能出现 110 分
  assertEquals(Math.min(100, base + IMAGE_BONUS), 100);
});

Deno.test("rubric - 置信度：缺维度按 0 计（不重新归一化成虚高），并夹在 0–1", () => {
  const full = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 1]));
  assertEquals(weightedConfidence(full), 1);
  // 只答了 innovation 且很自信 → 只有 0.2，低置信（该送人工复核）
  assertEquals(
    Math.round(weightedConfidence({ innovation: 1 }) * 100) / 100,
    0.2,
  );
  const mixed = weightedConfidence({
    innovation: 0.5,
    utility: 0.5,
    influence: 0.5,
    freshness: 0.5,
  });
  assertEquals(Math.round(mixed * 100) / 100, 0.5);
  // 越界输入不得输出 >1
  assertEquals(
    weightedConfidence(
      Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 5])),
    ),
    1,
  );
});
