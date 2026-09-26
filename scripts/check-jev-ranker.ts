/**
 * Jev 排序 A/B 自检：同一批真实素材，同时跑 LLM 路径与 Jev 路径，输出对照表。
 *
 * 与 `scripts/check-keyword-relevance.ts` 同一风格：读真实采集数据，不造样本。
 *
 * 用法：
 *   # 1) 只看「会往外发什么」——不发任何请求，不需要 key（对外传输前先自己看一眼）
 *   deno run --allow-env --allow-read --env scripts/check-jev-ranker.ts --dry-run
 *
 *   # 2) 只验 key 与连通性（GET /v1/models，不发送素材）
 *   deno run --allow-env --allow-read --allow-net --env scripts/check-jev-ranker.ts --env-check
 *
 *   # 3) 真跑 A/B（**会把素材正文发到 api.typesafe.ai**，需本人先确认）
 *   deno run --allow-env --allow-read --allow-net --env scripts/check-jev-ranker.ts --n 30
 *
 * 素材来源（按优先级）：
 *   --file <path>  指定文件；x-search 采集日志（{ posts: [...] }）或 ScrapedContent[]
 *   缺省           取 logs/ 下最新的 x-search-*.json
 */
import {
  keywordTerms,
  prioritizeByKeywordRelevance,
} from "../src/services/weixin-article.workflow.ts";
import { ContentRanker } from "../src/modules/content-rank/ai.content-ranker.ts";
import { JevContentRanker } from "../src/modules/content-rank/jev.content-ranker.ts";
import { JevClient } from "../src/providers/system-one/jev.client.ts";
import {
  DIMENSION_KEYS,
  DIMENSIONS,
  IMAGE_BONUS,
} from "../src/prompts/content-ranker.rubric.ts";
import { RankResult } from "../src/modules/interfaces/content-ranker.interface.ts";
import { ScrapedContent } from "../src/modules/interfaces/scraper.interface.ts";
import { ConfigManager } from "../src/utils/config/config-manager.ts";
import { EnvConfigSource } from "../src/utils/config/sources/env-config.source.ts";
import { readOptionalConfig } from "../src/utils/config/optional-config.ts";

const argOf = (name: string): string | undefined => {
  const index = Deno.args.indexOf(name);
  if (index === -1) return undefined;
  const value = Deno.args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
};
const flag = (name: string) => Deno.args.includes(name);

const TOP_N = Number(argOf("--n") ?? 10);
const DRY_RUN = flag("--dry-run");
const ENV_CHECK = flag("--env-check");

/** 官方挂价：输入 $0.042 / 百万 token，输出免费 */
const USD_PER_M_INPUT_TOKENS = 0.042;

const pad = (text: string, width: number) => {
  const chars = [...text];
  return chars.length >= width ? chars.slice(0, width).join("") : text + " ".repeat(width - chars.length);
};

// ---------------------------------------------------------------- 素材

const newestXSearchLog = (): string => {
  const files: string[] = [];
  for (const entry of Deno.readDirSync("logs")) {
    if (entry.isFile && entry.name.startsWith("x-search-") && entry.name.endsWith(".json")) {
      files.push(`logs/${entry.name}`);
    }
  }
  if (!files.length) throw new Error("logs/ 下没有 x-search-*.json，请用 --file 指定素材");
  return files.sort().at(-1)!;
};

const loadMaterials = (path: string): ScrapedContent[] => {
  const raw = JSON.parse(Deno.readTextFileSync(path));

  // 已是 ScrapedContent[]
  if (Array.isArray(raw)) return raw as ScrapedContent[];

  // x-search 采集日志
  const posts: Array<{ ref?: string; text?: string; publishDate?: string }> = raw.posts ?? [];
  const extractId = (ref?: string) => String(ref ?? "").match(/\/status\/(\d+)/)?.[1] ?? null;
  return posts
    .map((post) => {
      const text = String(post.text ?? "").trim();
      const id = extractId(post.ref);
      if (!id || !text) return null;
      return {
        id,
        title: text.split("\n")[0].slice(0, 120),
        content: text,
        url: String(post.ref ?? ""),
        publishDate: post.publishDate ?? "未知",
        metadata: { platform: "x-search" },
      } as ScrapedContent;
    })
    .filter((item): item is ScrapedContent => item !== null);
};

// ---------------------------------------------------------------- 指标

const topIds = (ranked: RankResult[], n: number) =>
  [...ranked].sort((a, b) => b.score - a.score).slice(0, n).map((r) => String(r.id));

const overlapRate = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  return a.filter((id) => setB.has(id)).length / Math.max(a.length, b.length);
};

const spread = (scores: number[]) =>
  scores.length ? Math.max(...scores) - Math.min(...scores) : 0;

const tieCount = (scores: number[]) => {
  const seen = new Map<number, number>();
  for (const s of scores) seen.set(s, (seen.get(s) ?? 0) + 1);
  return [...seen.values()].filter((n) => n > 1).reduce((acc, n) => acc + n, 0);
};

// ---------------------------------------------------------------- 主流程

const bootstrap = async () => {
  const configManager = ConfigManager.getInstance();
  configManager.clearSources();
  configManager.addSource(new EnvConfigSource());

  const file = argOf("--file") ?? newestXSearchLog();
  const materials = loadMaterials(file).slice(0, TOP_N);
  if (!materials.length) throw new Error(`从 ${file} 没有解析出任何素材`);

  console.log(`素材文件: ${file}`);
  console.log(`素材条数: ${materials.length}（--n ${TOP_N}）`);
  console.log(
    `关键词: ${JSON.stringify(keywordTerms(argOf("--keywords") ? [argOf("--keywords")!] : []))}`,
  );

  const apiKey = String((await readOptionalConfig("JEV_API_KEY")) ?? "");
  const model = String((await readOptionalConfig("JEV_MODEL")) ?? "jev-1.13.0");

  // ---- 1) 只预览发出去的内容
  if (DRY_RUN || !apiKey) {
    const builder = new JevContentRanker(null as unknown as JevClient);
    let chars = 0;
    for (const item of materials) chars += builder.buildState(item).length;
    const questions = builder.buildQuestions();
    const sample = builder.buildState(materials[0]);
    console.log(`\n[Jev 请求预览] model=${model}｜每篇 1 次请求｜共 ${materials.length} 次请求`);
    console.log(`问题（4 个维度，各带自己的档位）:`);
    for (const key of DIMENSION_KEYS) {
      const q = questions[key] as { instructions: string; criteria: string[] };
      console.log(`  - ${key}（权重 ${DIMENSIONS[key]}）: ${q.instructions}`);
      console.log(`      档位: ${q.criteria.join(" → ")}`);
    }
    console.log(`\n首篇 state 原文（每篇截断 12000 字符）:\n---\n${sample}\n---`);
    console.log(
      `\n合计送入字符数 ≈ ${chars}（粗估 ${
        Math.round(chars / 1.6)
      } 输入 token → 约 $${(
        (chars / 1.6 / 1_000_000) * USD_PER_M_INPUT_TOKENS
      ).toFixed(6)}）`,
    );
    if (!apiKey) {
      console.log("\n⚠️  未配置 JEV_API_KEY：以上仅为预览，未发送任何请求。");
    } else {
      console.log("\n以上为 --dry-run 预览，未发送任何请求。");
    }
    return;
  }

  const client = new JevClient({
    baseUrl: String((await readOptionalConfig("JEV_BASE_URL")) ?? "https://api.typesafe.ai"),
    apiKey,
    model,
    timeoutMs: Number((await readOptionalConfig("JEV_TIMEOUT_MS")) ?? 15000),
  });

  // ---- 2) 只验连通性
  if (ENV_CHECK) {
    const models = await client.listModels();
    console.log(`[连通性] 鉴权通过，可用模型: ${models.map((m) => m.name).join(", ")}`);
    return;
  }

  // ---- 3) 真跑 A/B
  const concurrency = Number((await readOptionalConfig("JEV_CONCURRENCY")) ?? 5);
  const jevRanker = new JevContentRanker(client, { concurrency });
  const llmRanker = new ContentRanker();

  console.log("\n[开始] LLM 路径…");
  const llmStarted = Date.now();
  let llmResults: RankResult[] = [];
  let llmError = "";
  try {
    llmResults = await llmRanker.rankContents(materials, []);
  } catch (error) {
    llmError = error instanceof Error ? error.message : String(error);
  }
  const llmMs = Date.now() - llmStarted;

  console.log("[开始] Jev 路径…");
  const jevStarted = Date.now();
  const jevResults = await jevRanker.rankContents(materials, []);
  const jevMs = Date.now() - jevStarted;
  const failures = jevRanker.getLastRunFailures();

  const llmTop = topIds(llmResults, TOP_N);
  const jevTop = topIds(jevResults, TOP_N);
  const jevScores = jevResults.map((r) => r.score);
  const jevTopScores = topIds(jevResults, TOP_N)
    .map((id) => jevResults.find((r) => String(r.id) === id)?.score ?? 0);

  const dimConfidence = DIMENSION_KEYS.map((key) => {
    const values = jevResults
      .map((r) => r.detail?.dims[key]?.confidence)
      .filter((v): v is number => typeof v === "number");
    const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return { key, avg, n: values.length };
  });

  console.log("\n================ 指标 ================");
  console.log(
    `Top-${TOP_N} 重合率        : ${
      (overlapRate(llmTop, jevTop) * 100).toFixed(1)
    }%（观测值；两条路径输入信息不同，低不等于失败）`,
  );
  console.log(`LLM 漏评条数          : ${materials.length - llmResults.length}${llmError ? `（整批失败: ${llmError}）` : ""}`);
  console.log(`Jev 漏评条数          : ${failures.failures.length}/${failures.total}`);
  console.log(`Jev 分维度平均置信度  : ${dimConfidence.map((d) => `${d.key}=${d.avg.toFixed(2)}(n=${d.n})`).join(" ")}`);
  console.log(`Jev 分数区分度        : Top-${TOP_N} 极差 ${spread(jevTopScores).toFixed(1)} 分，并列 ${tieCount(jevScores)} 条`);
  console.log(`耗时                  : LLM ${llmMs}ms｜Jev ${jevMs}ms`);
  console.log(
    `Jev 成本              : 输入 token 未在本次统计（客户端已返回 usage，可扩展记账）｜价格 $${USD_PER_M_INPUT_TOKENS}/M`,
  );
  console.log(`含图加分              : +${IMAGE_BONUS}（代码计算，Jev 读不到图）`);

  console.log("\n================ 逐篇对照 ================");
  console.log(
    `${pad("标题", 30)} ${pad("LLM", 6)} ${pad("Jev", 6)} ${
      DIMENSION_KEYS.map((k) => pad(k.slice(0, 5), 6)).join("")
    } ${pad("conf", 5)} 维度置信度`,
  );
  for (const item of materials) {
    const id = String(item.id);
    const llm = llmResults.find((r) => String(r.id) === id);
    const jev = jevResults.find((r) => String(r.id) === id);
    const dims = DIMENSION_KEYS.map((k) =>
      pad(jev?.detail?.dims[k] ? jev.detail.dims[k].raw.toFixed(1) : "-", 6)
    ).join("");
    const confs = DIMENSION_KEYS.map((k) =>
      jev?.detail?.dims[k] ? `${k.slice(0, 5)}=${jev.detail.dims[k].confidence.toFixed(2)}` : `${k.slice(0, 5)}=-`
    ).join(" ");
    console.log(
      `${pad(item.title, 30)} ${pad(llm ? llm.score.toFixed(1) : "漏", 6)} ${
        pad(jev ? jev.score.toFixed(1) : "缺", 6)
      } ${dims} ${pad(jev?.confidence?.toFixed(2) ?? "-", 5)} ${confs}`,
    );
  }

  // 关键词重排后（两条路径都要过这一步）的前 N 名对照 —— 这才是「成稿主题命中」的真实口径
  const terms = keywordTerms(argOf("--keywords") ? [argOf("--keywords")!] : []);
  if (terms.length) {
    const llmOrder = prioritizeByKeywordRelevance(
      [...llmResults].sort((a, b) => b.score - a.score),
      materials,
      terms,
    ).slice(0, TOP_N).map((r) => String(r.id));
    const jevOrder = prioritizeByKeywordRelevance(
      [...jevResults].sort((a, b) => b.score - a.score),
      materials,
      terms,
    ).slice(0, TOP_N).map((r) => String(r.id));
    console.log(
      `\n关键词重排后 Top-${TOP_N} 重合率: ${
        (overlapRate(llmOrder, jevOrder) * 100).toFixed(1)
      }%  ← 决定成稿主题命中，是真正的上线判据`,
    );
  }
};

bootstrap().catch((error) => {
  console.error("自检失败:", error);
  Deno.exit(1);
});
