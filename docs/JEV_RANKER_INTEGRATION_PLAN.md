# Jev 接入内容排序层 —— 执行方案

- 项目：`F:\个人项目管理\ai-trend-publish`（TrendPublish 趋势发布系统）
- 日期：2026-09-27
- 范围：**只改内容排序（rank）一层**，其余链路不动
- 状态：**代码已落地（默认仍走 LLM）；真实 A/B 未跑** —— 卡在第 11 节第 1、2 条（见第 13 节）

---

## 1. 目标与判定标准

把内容排序从「让大模型吐一段文本分数」换成「调 Jev 取结构化判断」，解决三个已存在的真实缺陷：

| 现状缺陷 | 位置 | Jev 后的状态 |
|---|---|---|
| 输出是纯文本 `文章ID: 分数`，正则一不匹配就抛错 | `ai.content-ranker.ts` 的 `parseRankingResult` | 结构化返回，无解析环节，不会因格式失败 |
| 大模型会漏评，得按 0 分补齐 | `weixin-article.workflow.ts` 的 `skipped` 逻辑 | 每个问题 id 必有对应答案，漏评消失 |
| 只有分数，没有不确定度 | 全链路 | 每题返回 `confidence`，可做门禁 |
| 4 个维度只写在提示词里，无法单独查 | `content-ranker.prompt.ts` | 每维度独立问题，权重写在代码里，可单独调 |

**完成标准（可验证）**：

1. `AI_CONTENT_RANKER_ENGINE=JEV` 时能跑完一次真实出稿，且日志里 `fail=0`
2. 同批素材下，Jev 路径与 LLM 路径的 Top-10 重合率 ≥ 80%
3. `AI_CONTENT_RANKER_ENGINE=LLM` 时行为与改动前完全一致（回归）
4. 任一环节失败时，出稿不被阻塞（自动回落 LLM）

---

## 2. 明确不做的事

- 不改 `ai.summarizer`（要写正文，Jev 不生成文本）
- 不改 `content-dedup`（你们特意从 LLM 挪回代码，可审计，别退回去）
- 不改图片生成、模板渲染、发布通道
- 不动 `default.generator.ts` / `hellogithub.generator.ts`（它们也读 `AI_CONTENT_RANKER_LLM_PROVIDER`，所以**新开关必须另起名字**）
- 一期不把关键词相关度换成 Jev 判断（`prioritizeByKeywordRelevance` 现在是对的，先别碰）

---

## 3. 为什么不能走现有 provider 通道

现有抽象是 `LLMProvider.createChatCompletion(messages)`（`src/providers/interfaces/llm.interface.ts`），`OpenAICompatibleLLM` 打的是 `{baseURL}/chat/completions`。

Jev 是 `POST https://api.typesafe.ai/v1/systemone`，请求体是 `{ state, model, questions }`，返回 `answers` 映射。**它不是 OpenAI 兼容协议。**

硬塞进 `LLMFactory` 的 `CUSTOM` 分支，等于把结构化答案再拼回 `文章ID: 分数` 文本，Jev 的全部收益都被扔掉。所以新增一层独立能力接口，两条路径并存。

### 3.1 执行期必须避开的两个坑（已核对源码）

**坑 1：`HttpClient` 是单例，Authorization 是全局的。**

`src/utils/http/http-client.ts` 的 `setDefaultHeader` 改的是实例级 `defaultHeaders`；而 `OpenAICompatibleLLM.refresh()` 就会调它设 `Bearer ${apiKey}`。

→ **Jev 适配器绝对不能用 `setDefaultHeader`**，否则会把大模型的 key 覆盖掉。Jev 必须按请求传 header。

**坑 2：`HttpClient.retryFetch` 对任何非 2xx 都重试 3 次，且忽略 `retry-after`。**

401/402（余额不足）会被无意义重试 3 次；429 不会按服务端要求等待。而且 `request()` 把错误包成不含 status 的 `Error`，代码里没法区分状态码。

→ **Jev 适配器自带 fetch 与重试策略**，不复用 `HttpClient`。重试规则见 6.3。

---

## 4. 数据契约

### 4.1 请求

```ts
// src/providers/interfaces/system-one.interface.ts
export interface ScoreQuestion {
  type: "score";
  /** 让模型评什么 */
  instructions: string | Record<string, unknown> | unknown[];
  /** 档位描述，从低到高；2–10 档 */
  criteria: Array<string | Record<string, unknown> | unknown[]>;
}

export interface NoulQuestion {
  type: "noul";
  noul: string | Record<string, unknown> | unknown[];
}

export type SystemOneQuestion = ScoreQuestion | NoulQuestion;

export interface SystemOneRequest {
  state: string | Record<string, unknown> | unknown[];
  model: string;
  questions: Record<string, SystemOneQuestion>;
}
```

```ts
export interface ScoreAnswer {
  type: "score";
  /** 落在档位编号轴上，范围 0 .. (criteria.length - 1)，可以落在两档之间 */
  score: number;
  /** 0–1，由 probabilities 的分散程度算出 */
  confidence: number;
  /** 每个档位的概率，key 是档位编号字符串 */
  probabilities: Record<string, number>;
  /** 档位编号 → 档位描述 */
  legend: Record<string, string>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
  confidence?: number;
}

export type SystemOneAnswer = ScoreAnswer | NoulAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}
```

> ⚠️ **字段名必须先用一次真实最小请求钉死再写实现。**
> 官方 `docs.typesafe.ai/primitives/score` 明确写 `type` / `instructions` / `criteria`；但 API reference 页被抽取后字段名有歧义（可能叫 `score`）。不要照猜，先跑通再落地。
>
> ✅ **2026-09-27 已解**：不用发真实请求 —— `https://api.typesafe.ai/openapi.json`
> 匿名可读（14KB，OpenAPI 3.1），已抓取核对并作为唯一契约来源：
> `ScoreQuestion{type,criteria,instructions?}`、`ScoreAnswer{type,score,confidence,legend,probabilities}`、
> `SystemOneResponse{model,answers,usage}`（usage 必填）。同时**发现本节两处写错**：
> - `NoulQuestion` 没有 `noul` 字段（问句在 `instructions`，可选 `criteria:{true,false}`）；
> - `NoulAnswer` 没有 `confidence`（官方只对 score / choice 返回置信度）。
>
> 落地代码按 OpenAPI 写，见 `src/providers/interfaces/system-one.interface.ts`。风险清单第 8 条关闭。

### 4.2 Score 的两条硬规则（官方文档）

1. **档位描述要写「情形」，不要写「程度」。**
   - ✅「已有产品的常规更新，没有新方法」
   - ❌「中等创新」
   而且**描述里不要出现数字**——文档明确说数字对模型没帮助，还会让置信度掉下来（同一份报告，纯数字档位置信度从 1.0 掉到 0.35）。

2. **一个问题只测一个维度。**
   描述里写成「既新又实用又热门」会让模型无法定位，置信度下降。正确做法是拆成多个 Score，在代码里加权合并（官方叫 composite scoring）。

   → **这正好对上你们现有的 20/45/20/15 权重体系。**

3. 归一化：`score / (criteria.length - 1)` 得到 0–1，再乘权重。不同档位数的 Scale 必须先归一化，否则权重不成立。

### 4.3 排序结果的扩展

```ts
// src/modules/interfaces/content-ranker.interface.ts
export interface RankResult {
  id: string;
  /** 0–100，保持与现有一致，下游不用改 */
  score: number;
  /** 新增：0–1，仅 JEV 引擎提供 */
  confidence?: number;
  /** 新增：哪个引擎给的这条分数 */
  engine?: "LLM" | "JEV";
  /** 新增：分维度原始值与概率，仅用于审计和调参，下游不依赖 */
  detail?: {
    dims: Record<string, { raw: number; normalized: number; confidence: number }>;
    probabilities?: Record<string, Record<string, number>>;
    imageBonus?: number;
  };
}
```

`score` 仍是 0–100，下游的 `ranked.sort((a, b) => b.score - a.score)`、`prioritizeByKeywordRelevance`、`dedupeContents` 全都不用改。

---

## 5. 评分规则（替换现有提示词里的评分标准）

权重放在代码里，和现有提示词的 20/45/20/15 一一对应：

```ts
// src/prompts/content-ranker.rubric.ts
export const DIMENSIONS = {
  innovation: 0.20,   // 技术创新与突破性
  utility:    0.45,   // 实用价值与应用场景
  influence:  0.20,   // 市场影响力与发展潜力
  freshness:  0.15,   // 时效性与热度
} as const;

export const CRITERIA: Record<keyof typeof DIMENSIONS, string[]> = {
  innovation: [
    "已有产品的常规更新、版本迭代或小修补，没有新方法或新能力",
    "沿用现成路线，但在效果、速度或成本上做了明确改进",
    "提出新的方法、架构或全新产品形态，与现有主流做法有明显区别",
    "开辟新方向或显著改变现有做法，同类产品短期内难以复现",
  ],
  utility: [
    "概念演示或研究预览，没有可用产品，也看不到落地路径",
    "已经可以试用，但部署或接入门槛高，或只覆盖很窄的场景",
    "有明确使用场景，普通开发者或团队能直接接入并看到效果",
    "开箱可用、接入成本低，能替代现有做法并明显提升效率",
  ],
  influence: [
    "尚无讨论度，基本只有发布者自己在说",
    "小范围关注，局限在单一社区或细分人群",
    "行业内持续讨论，多家团队开始跟进或集成",
    "被主流厂商或大量团队采纳，正在改变行业做法或竞争格局",
  ],
  freshness: [
    "陈旧内容，或与当前趋势无关",
    "发布已有一段时间，讨论正在降温",
    "近期发布，正在被讨论",
    "刚刚发布或正在快速发酵，属于当前热点",
  ],
};
```

**合成公式**（写在代码里，可查可改）：

```
raw[A] = answer[A].score / (CRITERIA[A].length - 1)      // 0..1

score100 = 100 × ( 0.20×raw.innovation
                 + 0.45×raw.utility
                 + 0.20×raw.influence
                 + 0.15×raw.freshness )

imageBonus = (content.media?.length > 0) ? 10 : 0        // 沿用现有「含图 +10」规则
finalScore = min(100, score100 + imageBonus)

confidence = 0.20×conf.innovation + 0.45×conf.utility
           + 0.20×conf.influence  + 0.15×conf.freshness
```

两点说明：

- **「含图 +10」必须在代码里算。** Jev 只吃文本，不能读图。这是现有提示词里的一条规则，不能丢。
- `confidence` 用**同样权重的加权平均**，不用 min。用 min 的话，只要一个维度描述得模糊就会把整条判成低置信，太严。但日志里要**单独打出四个维度的 confidence**，这样才能定位到底是哪个维度说不清。

> 以上档位描述是按现有提示词直译的**初稿**。官方明确说：档位措辞必须拿自己的真实语料测，两套措辞在同一批数据上表现可能明显不同。所以第 8 节的验证脚本里要能看到分维度置信度分布，据此改措辞。

---

## 6. Jev 客户端

### 6.1 文件

新增 `src/providers/system-one/jev.client.ts`，**不复用 `HttpClient`**：

```ts
export class JevClient {
  // 每个实例持有自己的 baseURL / apiKey / model，不做全局 header
  constructor(private cfg: { baseUrl: string; apiKey: string; model: string; timeoutMs: number }) {}

  async evaluate(req: Omit<SystemOneRequest, "model">): Promise<SystemOneResponse> { /* ... */ }
}
```

配置读取（注意用 `readOptionalConfig`，见 6.4）：

```ts
JEV_BASE_URL   // 默认 https://api.typesafe.ai
JEV_API_KEY    // 必填
JEV_MODEL      // 默认 jev-1.13.0（钉版本号，不用 jev-latest）
JEV_TIMEOUT_MS // 默认 15000
```

### 6.2 请求形态

**一篇一次请求，一次带 4 个维度问题。**

`state` 放这一篇的素材，`questions` 放 4 个 Score 问题。这样：

- 单篇 `state` 约 3k 字符，离 64k 上限很远，永远碰不到上下文限制
- 4 个问题共享一次 `state` 读取，仍然吃到 fan-out 的并行收益
- 失败可以按篇重试，日志能按篇定位

```ts
const questions = {
  innovation: { type: "score", instructions: "评估这项技术的创新程度", criteria: CRITERIA.innovation },
  utility:    { type: "score", instructions: "评估它的实用价值与可落地程度", criteria: CRITERIA.utility },
  influence:  { type: "score", instructions: "评估它对行业的潜在影响", criteria: CRITERIA.influence },
  freshness:  { type: "score", instructions: "评估它的时效性与当前热度", criteria: CRITERIA.freshness },
};
```

> 如果之后要改成「一批一次请求」压请求数，必须重算上下文预算：`state` + 所有问题合计不超 64k，且 `state` + 单个最长问题不超 32k。一期不做。

### 6.3 重试与失败语义

| 情况 | 处理 |
|---|---|
| `429` | 读 `retry-after` 头，按其等待后重试，最多 3 次 |
| `5xx` / 网络超时 | 指数退避重试，最多 3 次（复用 `RetryUtil`） |
| `400` / `401` / `402` | **立即失败，不重试**。402 是余额不足，重试无意义 |
| 单篇最终失败 | 记录，不抛异常，交给 6.5 的整批判定 |

### 6.4 配置读取

`ConfigManager.get` 在键缺失时会抛 `ConfigurationError`。可选键要用现成的 `src/utils/config/optional-config.ts` 的 `readOptionalConfig`：

```ts
const apiKey = await readOptionalConfig("JEV_API_KEY");
if (!apiKey) throw new Error("JEV_API_KEY 未配置");   // 只有选了 JEV 引擎才要求它
```

`.env` 通过启动参数 `--env` 加载，沿用现有方式。

### 6.5 失败回落（关键，不能不写）

Jev 是第三方托管服务。它挂了不能让你每天出不了稿。

```
先跑 Jev：
  - 成功率 ≥ 90% → 用 Jev 分数；失败的那些按 score=0 排到末尾（与现有「漏评补 0」行为一致，日志写清楚）
  - 成功率 <  90% → 整批丢弃，走 LLM 路径
  - 完全失败（网络/鉴权/余额）→ 整批丢弃，走 LLM 路径
```

回落开关：`JEV_FALLBACK_TO_LLM`（默认 `true`）。回落时日志必须显式打一行 `[排序] JEV 失败，回落 LLM`，不能静默。

---

## 7. 文件级改动清单

### 7.1 新增

| 文件 | 内容 |
|---|---|
| `src/providers/interfaces/system-one.interface.ts` | 第 4.1 节的类型 |
| `src/providers/system-one/jev.client.ts` | Jev HTTP 客户端，自带重试与状态码分流 |
| `src/modules/content-rank/jev.content-ranker.ts` | `JevContentRanker implements ContentRanker` |
| `src/modules/content-rank/ranker.factory.ts` | 按 `AI_CONTENT_RANKER_ENGINE` 返回实现，内含回落 |
| `src/prompts/content-ranker.rubric.ts` | 第 5 节的维度、权重、档位描述 |
| `scripts/check-jev-ranker.ts` | 第 8 节的 A/B 验证脚本 |

### 7.2 修改

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/modules/interfaces/content-ranker.interface.ts` | `RankResult` 加 3 个可选字段 | 低，纯增量 |
| `src/services/weixin-article.workflow.ts:180` | `new ContentRanker()` → `createRanker()` | 中 |
| `src/services/weixin-article.workflow.ts:428` | 继续调 `rankContents(contents, keywords)`，签名不变 | 低 |
| `.env` / `.env.example` | 加第 10 节的新键 | 低 |

**`weixin-article.workflow.ts:428` 之后的三段逻辑保持原样不动**：

1. `skipped` 补 0 分 —— 留着当安全网，Jev 路径下它应该永远命中 0 条（这本身就是个验证信号）
2. `ranked.sort((a, b) => b.score - a.score)`
3. `prioritizeByKeywordRelevance` → `dedupeContents`

`step.do("rank-contents", { timeout: "5 minutes", retries: { limit: 2 } })` 的超时先不动。30 篇按并发 5 跑，单篇百毫秒级，远用不满；真超时说明 Jev 有问题，正好触发回落。

### 7.3 落地顺序（每步可单独验证）

1. 验证脚本（只读，不碰主流程）→ 拿到 A/B 数据
2. `system-one.interface.ts` + `jev.client.ts` + 一个最小连通性自检
3. `content-ranker.rubric.ts`
4. `jev.content-ranker.ts`（先只返回分数，不接置信度门禁）
5. `ranker.factory.ts` + workflow 两处改动，**默认 `AI_CONTENT_RANKER_ENGINE=LLM`**
6. 切 `JEV` 跑一次真实出稿，比对日志
7. 观察 3–5 次真实出稿后再考虑开置信度门禁

---

## 8. 验证方案

### 8.1 A/B 脚本

新增 `scripts/check-jev-ranker.ts`，对齐现有 `scripts/check-*.ts` 的风格（参考 `scripts/check-keyword-relevance.ts`，它就是从 `logs/x-search-*.json` 读真实采集数据）。

```
deno run --allow-env --allow-read --allow-net --env scripts/check-jev-ranker.ts --n 30
```

同一批 30 篇真实素材跑两条路径，输出：

| 指标 | 及格线 | 不达标意味着 |
|---|---|---|
| Top-N 重合率（N = `ARTICLE_NUM`，默认 10） | ≥ 80% | **唯一真正重要的指标**，低于 60% 直接下线 |
| 漏评条数 | 0 | 结构化返回本不该漏 |
| 解析失败率 | 0 | 没有解析环节，不该有 |
| 分维度 confidence 分布 | 平均 ≥ 0.5 | 说明档位措辞不适配中文语料，先改措辞再测 |
| 分数区分度 | Top-10 极差 ≥ 5 分（百分制），并列不超过 5 条 | 档位分辨率不足 |
| 单篇平均耗时 / 总耗时 | 记下来做基线，不设硬线 | — |
| 输入 token 估算与费用 | 记账用 | — |

同时打印逐篇对照表：标题（截断）、LLM 分、Jev 分、4 个维度原始分与 confidence、是否在 Top-10。

### 8.2 预登记的停止条件

出现任一条，**停止推进并回退**，不要继续调参：

1. Top-N 重合率 < 60%
2. 分维度平均 confidence < 0.4，且换过一轮档位措辞后仍不改善
3. 连续两次真实出稿的成稿主题命中数低于改动前

第 1 条是最硬的：Top-N 重合率低说明两条路径对「什么算好内容」的判断不一致，这不是调参能解决的。

### 8.3 回归验证

`AI_CONTENT_RANKER_ENGINE=LLM` 跑一次，确认：
- 日志里出现 `[排序] LLM 漏评 N 条`（原行为仍在）
- `RankResult` 新增的可选字段在 LLM 路径下为 `undefined`
- 下游 `content.metadata.score` 照常写入

---

## 9. 上线顺序与回滚

**回滚成本 = 改一个环境变量 + 重启。**

```
AI_CONTENT_RANKER_ENGINE=LLM   # 回滚
AI_CONTENT_RANKER_ENGINE=JEV   # 启用
```

不需要回滚代码，这是这个设计的主要安全属性。

启动方式沿用项目现有的一键脚本或看板 `direct` 模式（`deno run ... src/index.ts --no-check`，Deno 在无控制台环境下必须走 direct，否则日志全丢——见项目 notes）。

---

## 10. 配置项

加到 `.env` 与 `.env.example`：

```dotenv
# ===== 内容排序引擎 =====
# LLM = 现有大模型提示词打分（默认，行为不变）
# JEV = TypeSafe System One 结构化打分
AI_CONTENT_RANKER_ENGINE="LLM"

# ===== Jev（仅 AI_CONTENT_RANKER_ENGINE=JEV 时需要）=====
JEV_BASE_URL="https://api.typesafe.ai"
JEV_API_KEY=""
# 生产钉版本号，不要用 jev-latest（别名会漂移，调好的阈值会失效）
JEV_MODEL="jev-1.13.0"
JEV_TIMEOUT_MS=15000
JEV_CONCURRENCY=5
# JEV 整批成功率低于该值时回落 LLM（0.9 = 90%）
JEV_FALLBACK_THRESHOLD=0.9
JEV_FALLBACK_TO_LLM="true"
# 置信度门禁：0 = 不启用（一期保持 0）
JEV_MIN_CONFIDENCE=0
```

**不要复用 `AI_CONTENT_RANKER_LLM_PROVIDER`。** 它同时被 `default.generator.ts:62` 和 `hellogithub.generator.ts:44` 读取，改它会连带影响那两个 generator。

---

## 11. 待确认（未确认前不要动主流程）

1. **TypeSafe 是否有可用账号与 API key。** 官网写的是 early access。没有 key，这方案只能停在 8.1 的离线对比，无法进第 7.3 节的第 5 步之后。
2. **是否可以把正文发给第三方 API。** 采集到的素材包含未发布的公众号内容，发到 `api.typesafe.ai` 是**对外传输**。这一条必须你本人确认，我不会替你决定。
3. **本期是否启用置信度门禁。** 建议一期设为 0（不启用），先只看分布。
4. `JEV_CONCURRENCY`、回落阈值 `0.9` 这两个数是否接受我的默认值。
5. 是否需要把每次排序的 `detail`（分维度分数、概率、置信度）落库留存，便于日后调阈值。现在只有 `content.metadata.score` 会被写。

---

## 12. 风险清单

按严重度排：

1. **`HttpClient` 单例 header 污染。** 复用它会覆盖大模型的 Authorization。已在 3.1 规避：Jev 用自己的 fetch。
2. **`HttpClient` 对 4xx 也重试、忽略 `retry-after`。** 402 余额不足会被白重试 3 次。已在 6.3 规避：适配器自带状态码分流。
3. **Jev 不可用会阻塞出稿。** 已在 6.5 用成功率判定 + 回落兜住；回落必须打日志，不能静默。
4. **绝对打分可能导致分数压缩。** Jev 逐篇独立评分，与批次组成无关——这是优点（同一条素材分数可复现、不受同批其他文章影响），但也意味着更容易出现并列。已被 8.1 的「区分度」指标覆盖；若确实压缩，靠加档位或引入 tie-break 解决。
5. **中文表现未经验证。** 官方 benchmark 不是中文 AI 科技新闻语料。8.1 的分维度 confidence 就是为此设的。
6. **厂商宣称的「快几十倍、便宜几百倍」是自测口径。** 独立测试里单次判断的差距小得多。你们这种「一次几十篇」的批量场景才是它相对有优势的地方，但必须自己实测，不要采信宣传数字。
7. **early access + 闭源 + 托管。** 排序是出稿链路的核心一环，接进去就是引入一个外部单点。这也是必须保留 LLM 路径和一行回滚的原因。
8. **字段名歧义。** 官方文档里 Score 问题的字段名（`instructions` / `criteria` vs 其它）在 API reference 抽取后有歧义。落地前必须先用一次真实最小请求校准，见 4.1 的警告。
9. **置信度 ≠ 正确率。** 它是校准过的概率，不是保证。若启用门禁，阈值必须用带标注的历史素材定，不能照抄文档。
10. **成本记账。** 官方挂价是输入 $0.042/百万 token、输出免费。一轮 30 篇、每篇约 3k 字符量级，成本在**分位美元以下**——但这是按文档价推算的量级，不是账单承诺；实际要按 `usage.input_tokens` 记账。

---

## 13. 落地记录与方案修正（2026-09-27）

### 13.1 已落地（全部默认关闭，`AI_CONTENT_RANKER_ENGINE` 缺省即 LLM）

| 文件 | 内容 |
|---|---|
| `src/providers/interfaces/system-one.interface.ts`（新增） | 按 `openapi.json` 写的 System One 契约 |
| `src/providers/system-one/jev.client.ts`（新增） | 自带状态码分流与重试的 HTTP 客户端，**不复用 `HttpClient`** |
| `src/prompts/content-ranker.rubric.ts`（新增） | 4 维权重（20/45/20/15）、档位措辞、归一化与合成公式 |
| `src/modules/content-rank/jev.content-ranker.ts`（新增） | 一篇一请求、4 问 fan-out、并发 5、失败不上抛 |
| `src/modules/content-rank/ranker.factory.ts`（新增） | 引擎选择 + 整批回落，回落必打日志 |
| `src/modules/interfaces/content-ranker.interface.ts`（改） | `RankResult` 加 `confidence` / `engine` / `detail`；新增窄接口 `RankerLike` |
| `src/services/weixin-article.workflow.ts`（改） | `new ContentRanker()` → 懒加载 `createRanker()`；排序后半段一行未动 |
| `.env.example`（改） | 第 10 节全部新键 + 回滚说明。**`.env` 未改**，所以本机行为不变 |
| `scripts/check-jev-ranker.ts`（新增） | A/B 脚本：`--dry-run`（预览会发什么，不发请求）/ `--env-check`（只验 key）/ 默认真跑 |
| `src/test/modules/content-rank/*.test.ts`（新增 4 个文件 35 条） | 档位/权重/置信度数学、状态码分流与重试、单篇失败、回落阈值、引擎判定 |

### 13.2 执行中发现的方案问题（已按修正落地）

| # | 方案原文 | 问题 | 修正 |
|---|---|---|---|
| 1 | 6.3「5xx 复用 `RetryUtil`」 | `RetryUtil` 对 4xx 一样重试；它对 `WorkflowTerminateError` 的早退分支若拿来表达「401 不重试」，会把终止错误抛进 step，**连带终止整条出稿流程** | 客户端自带重试循环（429 读 `retry-after`、5xx/超时指数退避、4xx 立即失败），不依赖 `RetryUtil`；并新增「`retry-after` 超过 30s 直接失败」，避免一个巨大等待把 5 分钟 step 拖死 |
| 2 | 4.1 的 `NoulQuestion` / `NoulAnswer` | 字段形状与官方不符（见上方 4.1 注） | 按 OpenAPI 修正；本期只用 score，noul 一并写对以免日后照抄 |
| 3 | 7.2「`JevContentRanker implements ContentRanker`」 | 现有 `ContentRanker` 接口的 `rankContents(contents)` **没有 keywords 参数**，而工作流实际调用 `rankContents(contents, keywords)`；且接口还要求 `rankContentsBatch`，Jev 侧没有 | 新增窄接口 `RankerLike`（只有 `rankContents(contents, keywords?)`），工作流依赖它；同时在原接口上给 `rankContents` 补可选 `keywords` |
| 4 | 6.5「失败的那些按 score=0 排到末尾」 | 工作流里已有「漏评按 0 分补在末尾」的兜底，在 ranker 里再补一遍等于同一件事写两处，并会**掩盖「Jev 漏了几条」这个验证信号** | ranker 只返回成功条目 + 打日志（含失败明细与原因）；补 0 交给既有兜底 |
| 5 | 8.1 把「Top-N 重合率 ≥ 80%」当唯一硬指标，8.2 第 1 条 `<60%` 直接下线 | 与第 2 节「一期不动关键词相关度」自相矛盾：LLM 提示词里有「命中关键词从 50 分起、泛热点 ≤40 分」的规则，Jev 这一期没有 —— 两条路径**输入信息本就不同**，重合率偏低是预期行为，不是失败信号 | 脚本同时输出「原始 Top-N 重合率」与「关键词重排后 Top-N 重合率」；建议把硬判据改成**后者**（它才等于成稿主题命中），原始重合率只做观测 |
| 6 | 7.3 顺序第 1 步「先跑验证脚本拿 A/B 数据」 | 脚本本身要发素材到第三方，第 11 节第 2 条又还没确认 | 脚本拆出 `--dry-run`（把将要发送的 state、问题和 token 估算先打印出来，零请求）与 `--env-check`（只 `GET /v1/models`），顺序倒过来：**先看要发什么 → 再决定是否发** |
| 7 | 5 节「含图 +10 必须在代码里算」 | 正确，但需注意封顶：满分素材 + 10 会到 110 | 取 `min(100, base + bonus)`，并有回归测试 |
| 8 | 10 节 `JEV_MIN_CONFIDENCE=0` | 一期不启用，但键写在 `.env.example` 里没有任何代码读它 | 保留键并注明「一期不启用」；代码里不实现门禁，避免出现一个看起来能用的空开关 |

### 13.3 尚未完成（卡点，不是遗漏）

1. **真实 A/B 未跑**：缺 `JEV_API_KEY`（第 11 节第 1 条）。本机 `.env` 里没有该键。
2. **对外传输未确认**：第 11 节第 2 条要你本人拍 —— 一旦真跑，采集到的正文（可能含未发布内容）会发往 `api.typesafe.ai`。
3. **档位措辞未校准**：官方要求拿自己的真实语料测；现在这四组是直译初稿，等 13.3 第 1 条解锁后看分维度置信度分布再改。
4. **置信度门禁未实现**：建议一期维持 0（不启用）。
5. **`detail` 未落库**：目前只有 `content.metadata.score` 会被写；要不要留存分维度分数/概率待定（第 11 节第 5 条）。

### 13.4 已完成验证

- `deno check`：新增 6 个文件 + 工作流 + A/B 脚本全部通过（仓库另有 6 处**既有**类型错误在 `controllers/cron.ts` 与 `services/workflow-config.service.ts`，与本次改动无关）。
- `deno test src/test/modules/content-rank/`：**35 条全绿**（不联网、不发素材，全部用注入的 fetch/sleep/client）。
- `deno test`（`data-source-registry` + `scrapers` + `content-rank` + `workflow-config`）：56 条全绿。
- `scripts/check-jev-ranker.ts --dry-run --n 3`：跑通，确认只读日志、不发请求。

### 13.5 解锁后怎么跑

```bash
# 1) 先看会发什么（不需要 key，不发请求）
deno run --allow-env --allow-read --env scripts/check-jev-ranker.ts --dry-run --n 30
# 2) 只在 .env 里加 JEV_API_KEY，验鉴权（GET /v1/models，仍不发素材）
deno run --allow-env --allow-read --allow-net --env scripts/check-jev-ranker.ts --env-check
# 3) 本人确认可以对外传素材后，跑真 A/B
deno run --allow-env --allow-read --allow-net --env scripts/check-jev-ranker.ts --n 30
# 4) 达标才切引擎（否则维持 LLM）
#    .env: AI_CONTENT_RANKER_ENGINE="JEV"   然后重启
```
