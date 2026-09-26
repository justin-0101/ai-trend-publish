import { startCronJobs } from "@src/controllers/cron.ts";
import { addWorkflowStepObserver } from "@src/works/workflow.ts";
import { getDataSources } from "@src/data-sources/getDataSources.ts";
import {
  deleteDataSourcePreference,
  normalizeDataSource,
} from "@src/services/data-source-registry.ts";
import { poolConnection } from "@src/db/db.ts";
import { WeixinAIBenchWorkflow } from "@src/services/weixin-aibench.workflow.ts";
import { WeixinArticleWorkflow } from "@src/services/weixin-article.workflow.ts";
import { WeixinDeepArticleWorkflow } from "@src/services/weixin-deep-article.workflow.ts";
import { WeixinHelloGithubWorkflow } from "@src/services/weixin-hellogithub.workflow.ts";
import { WeixinArticleTemplateRenderer } from "@src/modules/render/article.renderer.ts";
import { HelloGithubTemplateRenderer } from "@src/modules/render/hellogithub.renderer.ts";
import { AIBenchTemplateRenderer } from "@src/modules/render/aibench.renderer.ts";
import { WeixinPublisher } from "@src/modules/publishers/weixin.publisher.ts";
import {
  composeCover,
  splitCoverTitle,
} from "@src/utils/image/cover-composer.ts";
import { ImageGeneratorFactory } from "@src/providers/image-gen/image-generator-factory.ts";
import {
  buildTechCoverPrompt,
  ZhipuCogView4ImageGenerator,
} from "@src/providers/image-gen/zhipu-cogview4.image.ts";
import { ConfigManager } from "@src/utils/config/config-manager.ts";
import { Logger, LogLevel } from "@zilla/logger";
import { extname, join } from "https://deno.land/std/path/mod.ts";

type TimelineItem = {
  title: string;
  time: string;
  detail: string;
};

type ActivityItem = {
  title: string;
  detail: string;
  level: "info" | "warn" | "error";
};

type OverviewResponse = {
  kpi: {
    collected: number;
    selected: number;
    published: number;
    errors: number;
  };
  timeline: TimelineItem[];
  activity: ActivityItem[];
};

type WorkflowJobStatus = "running" | "success" | "error";

/** 单个步骤的执行记录（由 src/works/workflow.ts 的观察者上报） */
type WorkflowJobStep = {
  instanceId: string;
  name: string;
  status: "running" | "success" | "failure";
  startedAt: number;
  finishedAt?: number;
  attempts?: number;
  error?: string;
  /** 步骤返回值的短预览（截断） */
  resultPreview?: string;
};

type WorkflowJobLogLine = {
  at: number;
  level: "log" | "warn" | "error" | "debug";
  text: string;
};

/** 本次运行期间写出的草稿引用（不存 html，避免记录文件膨胀） */
type WorkflowJobDraftRef = {
  id: string;
  title: string;
  status: DraftStatus;
  createdAt: number;
};

type WorkflowJob = {
  id: string;
  type: ApiWorkflowType;
  status: WorkflowJobStatus;
  message?: string;
  startedAt: number;
  finishedAt?: number;
  /** 本次运行的参数 */
  payload?: Record<string, unknown>;
  steps?: WorkflowJobStep[];
  /** 失败详情（message + stack），成功时不存在 */
  error?: { message: string; stack?: string };
  logs?: WorkflowJobLogLine[];
  drafts?: WorkflowJobDraftRef[];
};

type ApiWorkflowType =
  | "weixin-article"
  | "weixin-aibench"
  | "weixin-hellogithub"
  | "weixin-deep-article";

const docsDir = join(Deno.cwd(), "docs");
const workflowJobs = new Map<string, WorkflowJob>();
const CONFIG_KEY_WORKFLOW_SETTINGS = "UI_WORKFLOW_SETTINGS";
const uiConfigFile = join(Deno.cwd(), "logs", "ui-config.json");

// ---------------------------------------------------------------- 运行记录
// 内存里的 workflowJobs 只活到进程退出，因此同步写一份到 logs/workflow-jobs.json，
// 这样服务重启后「查看」仍能拿到历史运行的参数/步骤/错误/日志。
const workflowJobsFile = join(Deno.cwd(), "logs", "workflow-jobs.json");
const WORKFLOW_JOB_HISTORY_LIMIT = 50;
const WORKFLOW_JOB_LOG_LINES = 200;
const WORKFLOW_JOB_LOG_CHARS = 32 * 1024;
const WORKFLOW_STEP_RESULT_PREVIEW_CHARS = 200;
const WORKFLOW_JOBS_PERSIST_INTERVAL_MS = 2000;

let lastWorkflowJobsPersistAt = 0;

const persistWorkflowJobs = async (): Promise<void> => {
  try {
    const items = [...workflowJobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, WORKFLOW_JOB_HISTORY_LIMIT);
    const dir = join(Deno.cwd(), "logs");
    await Deno.mkdir(dir, { recursive: true });
    const tmp = `${workflowJobsFile}.tmp`;
    await Deno.writeTextFile(
      tmp,
      JSON.stringify({ updatedAt: new Date().toISOString(), jobs: items }),
    );
    await Deno.rename(tmp, workflowJobsFile);
  } catch (error) {
    console.warn(`保存工作流运行记录失败: ${(error as Error).message}`);
  }
};

// 步骤级事件很密集，非终态写入做节流；终态强制写。
const persistWorkflowJobsSoon = (force = false): void => {
  const now = Date.now();
  if (
    !force &&
    now - lastWorkflowJobsPersistAt < WORKFLOW_JOBS_PERSIST_INTERVAL_MS
  ) {
    return;
  }
  lastWorkflowJobsPersistAt = now;
  persistWorkflowJobs().catch(() => {});
};

const findWorkflowJob = async (jobId: string): Promise<WorkflowJob | null> => {
  const inMemory = workflowJobs.get(jobId);
  if (inMemory) return inMemory;
  // 内存里没有（例如服务重启过、或记录是外部写入的）就回查落盘文件，并缓存进内存
  try {
    const text = await Deno.readTextFile(workflowJobsFile);
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    const found = items.find((item: WorkflowJob) => item && item.id === jobId);
    if (found) {
      workflowJobs.set(found.id, found);
      return found;
    }
  } catch {
    // 文件不存在或损坏，当作没有历史记录
  }
  return null;
};

const loadWorkflowJobs = async (): Promise<void> => {
  try {
    const text = await Deno.readTextFile(workflowJobsFile);
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    let loaded = 0;
    for (const item of items) {
      if (item && typeof item.id === "string" && !workflowJobs.has(item.id)) {
        workflowJobs.set(item.id, item as WorkflowJob);
        loaded += 1;
      }
    }
    if (loaded > 0) {
      console.log(`已加载 ${loaded} 条历史工作流运行记录`);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(`加载历史工作流运行记录失败: ${(error as Error).message}`);
    }
  }
};

// ---------------------------------------------------------------- 日志捕获
// 工作流内部的 console 输出（例如 src/services/*.workflow.ts 的 logger.info）
// 默认只进 stdout，失败后无从查证。这里在 job 运行期间把它们顺手存进 job.logs。
const runningJobIds = new Set<string>();
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

const describeLogArg = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
};

// @zilla/logger 会给日志加 ANSI 颜色码，直接存进记录会在页面上显示成乱码
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const appendJobLog = (
  level: WorkflowJobLogLine["level"],
  text: string,
): void => {
  if (runningJobIds.size === 0) return;
  const line: WorkflowJobLogLine = {
    at: Date.now(),
    level,
    text: stripAnsi(text).slice(0, 2000),
  };
  for (const jobId of runningJobIds) {
    const job = workflowJobs.get(jobId);
    if (!job) continue;
    const logs = job.logs ?? (job.logs = []);
    logs.push(line);
    while (logs.length > WORKFLOW_JOB_LOG_LINES) {
      logs.shift();
    }
    let total = logs.reduce((sum, item) => sum + item.text.length, 0);
    while (total > WORKFLOW_JOB_LOG_CHARS && logs.length > 1) {
      total -= logs[0].text.length;
      logs.shift();
    }
  }
};

// 并发跑多个工作流时，日志会同时归到各个正在运行的 job（本项目实际使用中一次只跑一个）。
// 捕获过程本身绝不能抛错，否则会影响原本的日志输出。
// 只在有 job 运行时才接管 console，最后一个 job 结束时恢复（按 runningJobIds 计数，避免并发下提前恢复）。
let consoleCaptureInstalled = false;

const startConsoleCapture = (): void => {
  if (consoleCaptureInstalled) return;
  const wrap = (
    level: WorkflowJobLogLine["level"],
    original: (...args: unknown[]) => void,
  ) =>
  (...args: unknown[]) => {
    try {
      appendJobLog(level, args.map(describeLogArg).join(" "));
    } catch {
      // 忽略捕获异常
    }
    original(...args);
  };

  console.log = wrap("log", originalConsole.log);
  console.warn = wrap("warn", originalConsole.warn);
  console.error = wrap("error", originalConsole.error);
  console.debug = wrap("debug", originalConsole.debug);
  consoleCaptureInstalled = true;
};

const stopConsoleCapture = (): void => {
  if (!consoleCaptureInstalled || runningJobIds.size > 0) return;
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
  consoleCaptureInstalled = false;
};

const previewStepResult = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof text !== "string") return "";
    return text.length > WORKFLOW_STEP_RESULT_PREVIEW_CHARS
      ? `${text.slice(0, WORKFLOW_STEP_RESULT_PREVIEW_CHARS)}...`
      : text;
  } catch {
    return String(value).slice(0, WORKFLOW_STEP_RESULT_PREVIEW_CHARS);
  }
};

const attachDraftToRunningJobs = (item: DraftItem): void => {
  for (const jobId of runningJobIds) {
    const job = workflowJobs.get(jobId);
    if (!job) continue;
    const refs = job.drafts ?? (job.drafts = []);
    if (refs.some((ref) => ref.id === item.id)) continue;
    refs.push({
      id: item.id,
      title: item.title,
      status: item.status,
      createdAt: item.createdAt,
    });
  }
};

// 把步骤观察者接到 job 上：record.eventId 就是 runWorkflowJob 传进去的 jobId
addWorkflowStepObserver((record) => {
  const jobId = record.eventId;
  if (!jobId) return;
  const job = workflowJobs.get(jobId);
  if (!job) return;
  const steps = job.steps ?? (job.steps = []);
  const existing = steps.find((step) => step.instanceId === record.instanceId);

  if (record.status === "running") {
    if (!existing) {
      steps.push({
        instanceId: record.instanceId,
        name: record.name,
        status: "running",
        startedAt: record.startedAt,
      });
      persistWorkflowJobsSoon();
    }
    return;
  }

  const step: WorkflowJobStep = existing ?? {
    instanceId: record.instanceId,
    name: record.name,
    status: record.status,
    startedAt: record.startedAt,
  };
  step.status = record.status;
  step.finishedAt = record.finishedAt ?? Date.now();
  // 注意：attempts 来自 RetryUtil.retryOperationWithStats，语义是「实际重试次数」（首次成功为 0）
  if (typeof record.attempts === "number") step.attempts = record.attempts;
  if (record.error) step.error = record.error;
  if (record.status === "success" && record.result !== undefined) {
    step.resultPreview = previewStepResult(record.result);
  }
  if (!existing) {
    steps.push(step);
  }
  persistWorkflowJobsSoon();
});

const pad = (value: number) => String(value).padStart(2, "0");

type UiConfigFile = {
  sourceRules?: Record<string, unknown>;
  workflowSettings?: Record<string, unknown>;
};

type DraftStatus = "draft" | "published";

type DraftItem = {
  id: string;
  workflowType: string;
  title: string;
  html: string;
  thumbMediaId?: string;
  status: DraftStatus;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
};

type DraftInput = {
  workflowType: string;
  title: string;
  html: string;
};

const readUiConfigFile = async (): Promise<UiConfigFile> => {
  try {
    const text = await Deno.readTextFile(uiConfigFile);
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed ? parsed as UiConfigFile : {};
  } catch {
    return {};
  }
};

const writeUiConfigFile = async (data: UiConfigFile): Promise<void> => {
  const dir = join(Deno.cwd(), "logs");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(uiConfigFile, JSON.stringify(data));
};

const draftsFile = join(Deno.cwd(), "logs", "drafts.json");

const readDraftsFile = async (): Promise<DraftItem[]> => {
  try {
    const text = await Deno.readTextFile(draftsFile);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed as DraftItem[] : [];
  } catch {
    return [];
  }
};

const writeDraftsFile = async (items: DraftItem[]) => {
  const dir = join(Deno.cwd(), "logs");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(draftsFile, JSON.stringify(items));
};

const addDraft = async (input: DraftInput): Promise<DraftItem> => {
  const drafts = await readDraftsFile();
  const now = Date.now();
  const item: DraftItem = {
    id: crypto.randomUUID(),
    workflowType: input.workflowType,
    title: input.title,
    html: input.html,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  drafts.unshift(item);
  await writeDraftsFile(drafts);
  attachDraftToRunningJobs(item);
  return item;
};

const getDraftById = async (id: string): Promise<DraftItem | null> => {
  const drafts = await readDraftsFile();
  return drafts.find((draft) => draft.id === id) ?? null;
};

/**
 * 只改状态。给工作流用：真发成功后把归档草稿标成已发布，
 * 否则草稿箱里会留一条显示「草稿」、还挂着「发布」按钮的记录，点一下就是重复提交。
 */
const updateDraftStatusById = async (
  id: string,
  status: DraftStatus,
): Promise<boolean> => {
  const drafts = await readDraftsFile();
  const index = drafts.findIndex((draft) => draft.id === id);
  if (index < 0) {
    return false;
  }
  const now = Date.now();
  const current = drafts[index];
  drafts[index] = {
    ...current,
    status,
    updatedAt: now,
    publishedAt: status === "published"
      ? (current.publishedAt ?? now)
      : current.publishedAt,
  };
  await writeDraftsFile(drafts);
  return true;
};

const updateDraftById = async (
  id: string,
  patch: { title?: string; html?: string },
): Promise<DraftItem | null> => {
  const drafts = await readDraftsFile();
  const index = drafts.findIndex((draft) => draft.id === id);
  if (index < 0) {
    return null;
  }
  const now = Date.now();
  const current = drafts[index];
  const next: DraftItem = {
    ...current,
    title: patch.title ?? current.title,
    html: patch.html ?? current.html,
    updatedAt: now,
  };
  drafts[index] = next;
  await writeDraftsFile(drafts);
  return next;
};

const deleteDraftById = async (id: string): Promise<boolean> => {
  const drafts = await readDraftsFile();
  const next = drafts.filter((draft) => draft.id !== id);
  if (next.length === drafts.length) {
    return false;
  }
  await writeDraftsFile(next);
  return true;
};

const publishDraftById = async (id: string) => {
  const drafts = await readDraftsFile();
  const index = drafts.findIndex((draft) => draft.id === id);
  if (index < 0) {
    return null;
  }
  const draft = drafts[index];
  const publisher = new WeixinPublisher();
  // 默认值用占位符：仓库是公开的，不该把公众号名写进代码（真实值放 .env 的 AUTHOR）
  const author = Deno.env.get("AUTHOR") || "your_name";
  let thumbMediaId = draft.thumbMediaId;
  // 草稿没记录封面 ID 时，自动生成封面（三级降级）：
  //   1) 智谱 cogview-4 出**无文字**科技感底图 → 本地叠中文标题 → 压到 <64KB → 上传
  //   2) 智谱失败 → 本地渐变底图 + 叠中文标题（标题依然正确，只是底图朴素）
  //   3) 连本地合成都失败 → 无封面出稿
  //
  // 标题一律由字体引擎本地渲染：扩散模型画中文必乱码（实测「AI 三连炸」→「AI三连如人」）。
  if (!thumbMediaId) {
    const cover = splitCoverTitle(draft.title);
    try {
      const gen = await ImageGeneratorFactory.getInstance()
        .getGenerator("ZHIPU_COGVIEW4");
      if (!(gen instanceof ZhipuCogView4ImageGenerator)) {
        throw new Error("工厂返回了非 ZhipuCogView4ImageGenerator 实例");
      }
      const bgUrl = await gen.generate({
        prompt: buildTechCoverPrompt(),
        size: "1440x720",
      });
      const bgResp = await fetch(bgUrl);
      if (!bgResp.ok) {
        throw new Error(`下载封面底图失败: HTTP ${bgResp.status}`);
      }
      const bgBytes = new Uint8Array(await bgResp.arrayBuffer());
      const jpeg = await composeCover({
        title: cover.title,
        subline: cover.subline,
        subtitle: cover.subtitle,
        background: bgBytes,
      });
      thumbMediaId = await publisher.uploadThumb({
        kind: "bytes",
        data: jpeg,
        filename: "cover.jpg",
        mimeType: "image/jpeg",
      });
      console.log(
        `[draft-publish:${id}] 智谱底图+本地标题 → 封面已上传 thumbMediaId=${thumbMediaId} (${jpeg.length} bytes)`,
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(
        `[draft-publish:${id}] 智谱封面链路失败（${reason}），降级为本地渐变底图`,
      );
      // ---- 2) 本地渐变底图 + 本地标题 ----
      try {
        const jpeg = await composeCover({
          title: cover.title,
          subline: cover.subline,
          subtitle: cover.subtitle,
        });
        thumbMediaId = await publisher.uploadThumb({
          kind: "bytes",
          data: jpeg,
          filename: "cover.jpg",
          mimeType: "image/jpeg",
        });
        console.log(
          `[draft-publish:${id}] 本地封面上传成功 thumbMediaId=${thumbMediaId} (${jpeg.length} bytes)`,
        );
      } catch (e2) {
        const reason2 = e2 instanceof Error ? e2.message : String(e2);
        console.warn(
          `[draft-publish:${id}] 本地封面合成也失败（${reason2}），继续无封面出稿`,
        );
        thumbMediaId = "";
      }
    }
  }
  const result = await publisher.publish(draft.html, {
    title: draft.title,
    author,
    thumbMediaId,
  });
  const now = Date.now();
  drafts[index] = {
    ...draft,
    thumbMediaId: thumbMediaId || draft.thumbMediaId,
    status: result.success ? "published" : draft.status,
    updatedAt: now,
    publishedAt: result.success ? now : draft.publishedAt,
  };
  await writeDraftsFile(drafts);
  return { result, draft: drafts[index] };
};

const readDbConfig = async (key: string): Promise<string | null> => {
  try {
    const [rows] = await poolConnection.query(
      "SELECT `value` FROM `config` WHERE `key` = ? ORDER BY `id` DESC LIMIT 1",
      [key],
    );
    const list = rows as Array<{ value: string | null }>;
    return list[0]?.value ?? null;
  } catch {
    return null;
  }
};

const writeDbConfig = async (key: string, value: string): Promise<void> => {
  try {
    await poolConnection.execute("DELETE FROM `config` WHERE `key` = ?", [key]);
    await poolConnection.execute(
      "INSERT INTO `config` (`key`, `value`) VALUES (?, ?)",
      [key, value],
    );
  } catch {
    return;
  }
};

const safeJsonParse = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const makeSourceKey = (platform: string, identifier: string) =>
  `${platform}::${identifier}`;

const makeSourceRuleKey = (platform: string, identifier: string) =>
  `UI_DATA_SOURCE_RULE::${platform}::${encodeURIComponent(identifier)}`;

const compactSourceRule = (rule: Record<string, unknown>) => {
  const include = Array.isArray(rule.includeKeywords)
    ? rule.includeKeywords.filter((x) => typeof x === "string").map((x) =>
      x.trim()
    )
      .filter(Boolean)
    : [];
  const exclude = Array.isArray(rule.excludeKeywords)
    ? rule.excludeKeywords.filter((x) => typeof x === "string").map((x) =>
      x.trim()
    )
      .filter(Boolean)
    : [];
  const compact = {
    f: typeof rule.frequencyMinutes === "number" ? rule.frequencyMinutes : null,
    i: include.join("|"),
    e: exclude.join("|"),
    w: typeof rule.priorityWeight === "number" ? rule.priorityWeight : 1,
    m: typeof rule.maxArticles === "number" ? rule.maxArticles : null,
    p: rule.publish === true ? 1 : 0,
  };
  return JSON.stringify(compact);
};

const expandSourceRule = (value: string | null) => {
  const parsed = safeJsonParse<Record<string, unknown>>(value, {});
  const include = typeof parsed.i === "string" && parsed.i.length > 0
    ? parsed.i.split("|").map((x) => x.trim()).filter(Boolean)
    : [];
  const exclude = typeof parsed.e === "string" && parsed.e.length > 0
    ? parsed.e.split("|").map((x) => x.trim()).filter(Boolean)
    : [];
  return {
    frequencyMinutes: typeof parsed.f === "number" ? parsed.f : null,
    includeKeywords: include,
    excludeKeywords: exclude,
    priorityWeight: typeof parsed.w === "number" ? parsed.w : 1,
    maxArticles: typeof parsed.m === "number" ? parsed.m : null,
    publish: parsed.p === 1,
  };
};

const compactWorkflowSettings = (body: Record<string, unknown>) => {
  const core = typeof body.core === "object" && body.core
    ? body.core as Record<string, unknown>
    : {};
  const run = typeof body.run === "object" && body.run
    ? body.run as Record<string, unknown>
    : {};
  const coreArticle = typeof core.article === "object" && core.article
    ? core.article as Record<string, unknown>
    : {};
  const templates = Array.isArray(coreArticle.templates)
    ? coreArticle.templates.filter((x) => typeof x === "string").map((x) =>
      x.trim()
    ).filter(Boolean)
    : [];
  const c = {
    a: {
      s: typeof coreArticle.sourceType === "string"
        ? coreArticle.sourceType
        : "all",
      m: typeof coreArticle.maxArticles === "number"
        ? coreArticle.maxArticles
        : 20,
      p: coreArticle.publish === true ? 1 : 0,
      h: typeof coreArticle.heatWeight === "number"
        ? coreArticle.heatWeight
        : 0.3,
      q: typeof coreArticle.qualityWeight === "number"
        ? coreArticle.qualityWeight
        : 0.7,
      t: templates.join(","),
      o: typeof coreArticle.output === "string"
        ? coreArticle.output
        : "html-weixin",
    },
  };
  const r = {
    t: typeof run.workflowType === "string"
      ? run.workflowType
      : "weixin-article",
    s: typeof run.sourceType === "string" ? run.sourceType : "all",
    m: typeof run.maxArticles === "number" ? run.maxArticles : null,
    i: typeof run.maxItems === "number" ? run.maxItems : null,
    p: run.publish === true ? 1 : 0,
  };
  return JSON.stringify({ c, r });
};

const expandWorkflowSettings = (value: string | null) => {
  const base = {
    core: {
      article: {
        sourceType: "all",
        maxArticles: 20,
        publish: false,
        heatWeight: 0.3,
        qualityWeight: 0.7,
        templates: ["modern.ejs", "tech.ejs"],
        output: "html-weixin",
      },
      hellogithub: { maxItems: 10, publish: false },
      aibench: { publish: false },
    },
    run: {
      workflowType: "weixin-article",
      sourceType: "all",
      maxArticles: null,
      maxItems: null,
      publish: false,
    },
  };
  const parsed = safeJsonParse<Record<string, unknown>>(value, {});
  const c = typeof parsed.c === "object" && parsed.c
    ? parsed.c as Record<string, unknown>
    : {};
  const r = typeof parsed.r === "object" && parsed.r
    ? parsed.r as Record<string, unknown>
    : {};
  const a = typeof c.a === "object" && c.a
    ? c.a as Record<string, unknown>
    : {};
  const templates = typeof a.t === "string" && a.t.length > 0
    ? a.t.split(",").map((x) => x.trim()).filter(Boolean)
    : base.core.article.templates;
  return {
    core: {
      ...base.core,
      article: {
        ...base.core.article,
        sourceType: typeof a.s === "string"
          ? a.s
          : base.core.article.sourceType,
        maxArticles: typeof a.m === "number"
          ? a.m
          : base.core.article.maxArticles,
        publish: a.p === 1,
        heatWeight: typeof a.h === "number"
          ? a.h
          : base.core.article.heatWeight,
        qualityWeight: typeof a.q === "number"
          ? a.q
          : base.core.article.qualityWeight,
        templates,
        output: typeof a.o === "string" ? a.o : base.core.article.output,
      },
    },
    run: {
      ...base.run,
      workflowType: typeof r.t === "string" ? r.t : base.run.workflowType,
      sourceType: typeof r.s === "string" ? r.s : base.run.sourceType,
      maxArticles: typeof r.m === "number" ? r.m : null,
      maxItems: typeof r.i === "number" ? r.i : null,
      publish: r.p === 1,
    },
  };
};

const getTodayLogFile = () => {
  const now = new Date();
  return join(
    Deno.cwd(),
    "logs",
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`,
  );
};

const parseLogLine = (line: string) => {
  const match = line.match(/^\[(.+?)\]\s+\[(.+?)\]\s+\[(.+?)\]\s+(.*)$/);
  if (!match) {
    return null;
  }
  return {
    timestamp: match[1],
    level: match[2],
    tag: match[3],
    message: match[4],
  };
};

const readLogLines = async () => {
  try {
    const content = await Deno.readTextFile(getTodayLogFile());
    return content.split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const countByKeywords = (lines: string[], keywords: string[]) => {
  return lines.filter((line) => keywords.some((key) => line.includes(key)))
    .length;
};

const buildOverview = async (): Promise<OverviewResponse> => {
  const lines = await readLogLines();
  const parsed = lines.map(parseLogLine).filter(Boolean) as Array<
    NonNullable<ReturnType<typeof parseLogLine>>
  >;

  const collected = countByKeywords(lines, ["采集", "抓取", "新增"]);
  const selected = countByKeywords(lines, ["入选", "筛选", "评分"]);
  const published = countByKeywords(lines, ["发布成功", "草稿箱", "发布"]);
  const errors = lines.filter((line) => line.includes("[ERROR]")).length;

  const timelineCandidates = parsed
    .filter((item) =>
      ["采集", "清洗", "渲染", "发布", "生成"].some((key) =>
        item.message.includes(key)
      )
    )
    .slice(-3);

  const timelineSource = timelineCandidates.length
    ? timelineCandidates
    : parsed.slice(-3);
  const timeline = timelineSource.map((item) => ({
    title: item.message.split("·")[0] || item.message,
    time: item.timestamp.split(" ")[1]?.slice(0, 5) || item.timestamp,
    detail: item.message,
  }));

  const activity = parsed.slice(-3).map((item) => {
    const level: ActivityItem["level"] = item.level === "ERROR"
      ? "error"
      : item.level === "WARN"
      ? "warn"
      : "info";
    return {
      title: item.message.split("·")[0] || item.message,
      detail: item.message,
      level,
    };
  });

  return {
    kpi: {
      collected,
      selected,
      published,
      errors,
    },
    timeline,
    activity,
  };
};

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });

type PreviewWorkflowType =
  | "article"
  | "hellogithub"
  | "aibench"
  | "deep-article";

const clampNumber = (
  value: number | null,
  min: number,
  max: number,
  fallback: number,
) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
};

const normalizePreviewWorkflow = (value: unknown): PreviewWorkflowType => {
  if (value === "weixin-article" || value === "article") return "article";
  if (value === "weixin-hellogithub" || value === "hellogithub") {
    return "hellogithub";
  }
  if (value === "weixin-aibench" || value === "aibench") return "aibench";
  if (value === "weixin-deep-article" || value === "deep-article") {
    return "deep-article";
  }
  return "article";
};

const normalizeArticleTemplate = (value: unknown) => {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  const supported = [
    "default",
    "modern",
    "tech",
    "mianpro",
    "data-report",
    "bytedance",
    "daimo",
    "deep",
  ];
  if (supported.includes(name)) return name;
  return "modern";
};

// 预览占位语料：按 templateType 走不同主题，覆盖「AI 相关」的多类文章场景。
// 真实写作远不止 AI 热点速递——产品体验、技术深度、行业观察、案例复盘、数据榜单
// 都属于公众号日常会发的范围。预览时应让每个模板各自带匹配的占位标题与正文，
// 而不是所有模板都显示「AI 热点速递 1」。
type ArticlePreviewVariant = {
  titlePrefix: string;
  subtitle?: string;
  /** 刊头名，模板里用 <%= brand %> 取值 */
  brand?: string;
  /** 刊头副标，模板里用 <%= tagline %> 取值 */
  tagline?: string;
  paragraphs: string[];
  keywords: string[];
  metadata: {
    score: number;
    wordCount: number;
    readTime: number;
  };
};

const ARTICLE_PREVIEW_VARIANTS: Record<string, ArticlePreviewVariant> = {
  default: {
    titlePrefix: "现代版式 · 示例",
    paragraphs: [
      "本周聚焦 AI 与产品体验的结合：从交互细节到信息架构，整理了 6 条值得借鉴的设计观察。",
      "覆盖多模态输入、对话式导航、生成式卡片与可访问性实践，附带真实改版前后对比。",
      "适合作为产品体验周报与改版参考，欢迎团队内部对照自查。",
    ],
    keywords: ["产品体验", "交互细节", "可访问性"],
    metadata: { score: 0.82, wordCount: 380, readTime: 2 },
  },
  modern: {
    titlePrefix: "现代版式 · 示例",
    paragraphs: [
      "本期围绕「AI 让产品更轻」这条主线，挑了 5 个值得拆解的案例：搜索、笔记、协作、设计与客服。",
      "每个案例给出原始场景、改造前后对比，以及上线一周内的数据反馈。",
      "适合作为产品复盘与跨团队分享的素材。",
    ],
    keywords: ["产品复盘", "AI 应用", "改造对比"],
    metadata: { score: 0.84, wordCount: 420, readTime: 2 },
  },
  tech: {
    titlePrefix: "技术深度 · 示例",
    paragraphs: [
      "推理侧的两个老问题再次被翻新：长上下文显存吃紧与首 token 延迟偏高。",
      "整理了 3 种主流优化路径——KV cache 压缩、推测式解码、动态批处理，并给出实测吞吐与显存曲线。",
      "附代码片段与上线清单，方便工程团队按需取用。",
    ],
    keywords: ["推理优化", "KV cache", "推测解码"],
    metadata: { score: 0.88, wordCount: 520, readTime: 3 },
  },
  mianpro: {
    titlePrefix: "行业观察 · 示例",
    paragraphs: [
      "上周 AI 行业有 4 条值得记住的信号：开源模型集中发布、Agent 框架收敛、企业采购回暖、监管细则落地。",
      "用一张图把它们串起来，并标注哪些是短期波动、哪些是结构性变化。",
      "适合作为周会开场与战略汇报的素材。",
    ],
    keywords: ["行业观察", "开源模型", "企业采购"],
    metadata: { score: 0.81, wordCount: 460, readTime: 2 },
  },
  "data-report": {
    titlePrefix: "数据简报 · 示例",
    brand: "AI 周报",
    paragraphs: [
      "本月评测覆盖 12 个模型在 6 个维度上的表现：推理、代码、数学、数据分析、语言与指令遵循。",
      "整体榜单与分项前三已整理成表，关键变化点用橙色重点标出。",
      "适合作为选型参考与对外发布的榜单素材。",
    ],
    keywords: ["评测榜单", "模型选型", "分维度对比"],
    metadata: { score: 0.9, wordCount: 360, readTime: 2 },
  },
  bytedance: {
    titlePrefix: "字节蓝 · 产品动态",
    brand: "AI 周报",
    paragraphs: [
      "本周新产品与新功能：多模态编辑器、Agent 工作台、低代码插件市场上线。",
      "挑选了 3 个最具传播力的发布点，附上手实测体验与适配场景。",
      "适合作为产品周报与对外宣发的素材。",
    ],
    keywords: ["产品发布", "Agent", "插件市场"],
    metadata: { score: 0.83, wordCount: 400, readTime: 2 },
  },
  daimo: {
    titlePrefix: "大厂 · 深度长文",
    brand: "AI 周报",
    tagline: "TECH · INSIGHT · UPDATE",
    paragraphs: [
      "为什么这家公司把内部知识库全面迁到了 Agent 体系？背后是 18 个月的踩坑清单。",
      "从选型、试点、灰度到全量推进，按时间线拆解 4 个关键决策点。",
      "附内部数据：响应时延、采纳率、人均节省时长。",
    ],
    keywords: ["案例复盘", "知识库", "Agent 落地"],
    metadata: { score: 0.87, wordCount: 580, readTime: 3 },
  },
  // 深度文预览：单篇长文，与速递类模板的「多条摘要」形态区分开
  deep: {
    titlePrefix: "深度解读",
    subtitle: "一个行业动作改变了谁的哪一种成本",
    brand: "AI 周报",
    tagline: "TECH · INSIGHT · UPDATE",
    paragraphs: [
      "先说被广泛转述的那个说法：这次降价把入门成本打了下来。",
      "但一手定价页还写了两条被省略的限定条件，它们会改变结论的适用范围。",
      "把成本拆开看，降的是试用门槛，不是长期使用成本。真正被抬高的是迁移成本。",
      "所以我的判断标准是：先看计价单位变没变，再看自己会不会被锁在一条路线上。",
    ],
    keywords: ["成本结构", "定价页", "迁移成本"],
    metadata: { score: 0.9, wordCount: 1500, readTime: 6 },
  },
};

const buildArticlePreviewData = (count: number, templateType: string) => {
  const variant = ARTICLE_PREVIEW_VARIANTS[templateType] ??
    ARTICLE_PREVIEW_VARIANTS.default;
  const now = new Date();
  return Array.from({ length: count }, (_, index) => ({
    id: `preview-${templateType}-${index + 1}`,
    title: `${variant.titlePrefix} ${index + 1}`,
    subtitle: variant.subtitle,
    brand: variant.brand ?? "AI 周报",
    tagline: variant.tagline ?? "TECH · INSIGHT · UPDATE",
    content: variant.paragraphs
      .map((p) => `<p>${p}</p>`)
      .join("<next_paragraph />"),
    url: "https://example.com/preview",
    publishDate: now.toISOString().split("T")[0],
    metadata: { ...variant.metadata },
    keywords: [...variant.keywords],
    media: [],
  }));
};

const buildHelloGithubPreviewData = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    itemId: `hg-${index + 1}`,
    author: "TrendPublish",
    title: `开源项目精选 ${index + 1}`,
    name: `awesome-ai-${index + 1}`,
    url: "https://github.com/example/awesome-ai",
    description: "聚合 AI 工程实践与工具链，适合快速构建项目。",
    readme: "亮点包括向量检索、Agent 工具包与可观测性方案。",
    language: "TypeScript",
    totalStars: 12800 + index * 320,
    totalIssues: 120 + index * 6,
    totalForks: 980 + index * 40,
    contributors: 42 + index,
    lastWeekStars: 320 + index * 18,
    tags: ["AI", "Agent", "Tooling"],
    license: "MIT",
    relatedUrls: [
      { url: "https://example.com/docs", title: "快速上手" },
      { url: "https://example.com/changelog", title: "更新日志" },
    ],
  }));

const buildAIBenchPreviewData = () => ({
  "Model Alpha": {
    metrics: {
      "Global Average": 82.6,
      "Reasoning Average": 84.3,
      "Coding Average": 80.1,
      "Mathematics Average": 81.2,
      "Data Analysis Average": 83.5,
      "Language Average": 82.4,
      "IF Average": 79.8,
    },
    organization: "TrendLabs",
  },
  "Model Beta": {
    metrics: {
      "Global Average": 79.4,
      "Reasoning Average": 80.9,
      "Coding Average": 78.3,
      "Mathematics Average": 76.8,
      "Data Analysis Average": 80.1,
      "Language Average": 79.6,
      "IF Average": 77.2,
    },
    organization: "Open Insight",
  },
  "Model Gamma": {
    metrics: {
      "Global Average": 76.2,
      "Reasoning Average": 77.5,
      "Coding Average": 74.6,
      "Mathematics Average": 75.4,
      "Data Analysis Average": 76.8,
      "Language Average": 77.1,
      "IF Average": 73.9,
    },
    organization: "Nebula AI",
  },
});

const renderPreviewHtml = async (
  workflowType: PreviewWorkflowType,
  templateType: string,
  count: number,
) => {
  if (workflowType === "hellogithub") {
    const renderer = new HelloGithubTemplateRenderer();
    const items = buildHelloGithubPreviewData(count);
    return await renderer.render(items, "default");
  }
  if (workflowType === "aibench") {
    const renderer = new AIBenchTemplateRenderer();
    const templateData = renderer.transformData(buildAIBenchPreviewData());
    return await renderer.render(templateData, "default");
  }
  if (workflowType === "deep-article") {
    // 深度文是单篇，用 deep 模板；count 固定为 1，避免预览里出现多篇合集的错觉
    const renderer = new WeixinArticleTemplateRenderer(false);
    return await renderer.render(buildArticlePreviewData(1, "deep"), "deep");
  }
  const renderer = new WeixinArticleTemplateRenderer(false);
  const articles = buildArticlePreviewData(count, templateType);
  return await renderer.render(articles, templateType);
};

const updateDefaultArticleTemplate = async (templateType: string) => {
  const templateFile = `${templateType}.ejs`;
  const ui = await readUiConfigFile();
  const fallback = expandWorkflowSettings(null);
  const baseSettings = (ui.workflowSettings &&
      typeof ui.workflowSettings === "object")
    ? ui.workflowSettings as Record<string, unknown>
    : fallback as Record<string, unknown>;
  const core = typeof baseSettings.core === "object" && baseSettings.core
    ? baseSettings.core as Record<string, unknown>
    : fallback.core as Record<string, unknown>;
  const article = typeof core.article === "object" && core.article
    ? core.article as Record<string, unknown>
    : (fallback.core as Record<string, unknown>).article as Record<
      string,
      unknown
    >;
  const nextWorkflowSettings = {
    ...baseSettings,
    core: {
      ...core,
      article: {
        ...article,
        templates: [templateFile],
      },
    },
  };
  await writeUiConfigFile({ ...ui, workflowSettings: nextWorkflowSettings });
  return nextWorkflowSettings;
};

const getContentType = (filePath: string) => {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
};

const createWorkflow = (type: ApiWorkflowType) => {
  switch (type) {
    case "weixin-article":
      return new WeixinArticleWorkflow({
        id: "weixin-article-workflow",
        env: {
          name: "weixin-article-workflow",
          draftWriter: addDraft,
          draftStatusWriter: updateDraftStatusById,
        },
      });
    case "weixin-aibench":
      return new WeixinAIBenchWorkflow({
        id: "weixin-aibench-workflow",
        env: {
          name: "weixin-aibench-workflow",
          draftWriter: addDraft,
          draftStatusWriter: updateDraftStatusById,
        },
      });
    case "weixin-hellogithub":
      return new WeixinHelloGithubWorkflow({
        id: "weixin-hellogithub-workflow",
        env: {
          name: "weixin-hellogithub-workflow",
          draftWriter: addDraft,
          draftStatusWriter: updateDraftStatusById,
        },
      });
    case "weixin-deep-article":
      return new WeixinDeepArticleWorkflow({
        id: "weixin-deep-article-workflow",
        env: {
          name: "weixin-deep-article-workflow",
          draftWriter: addDraft,
          draftStatusWriter: updateDraftStatusById,
        },
      });
  }
};

const runWorkflowJob = async (
  type: ApiWorkflowType,
  payload: Record<string, unknown>,
) => {
  const workflow = createWorkflow(type);
  const jobId = crypto.randomUUID();
  const job: WorkflowJob = {
    id: jobId,
    type,
    status: "running",
    startedAt: Date.now(),
    payload,
    steps: [],
    logs: [],
    drafts: [],
  };
  workflowJobs.set(jobId, job);
  runningJobIds.add(jobId);
  startConsoleCapture();
  persistWorkflowJobsSoon(true);
  queueMicrotask(async () => {
    try {
      if ("refresh" in workflow && typeof workflow.refresh === "function") {
        await workflow.refresh();
      }
      await workflow.execute({
        payload,
        id: jobId,
        timestamp: Date.now(),
      });
      job.status = "success";
      job.finishedAt = Date.now();
    } catch (error) {
      job.status = "error";
      job.message = error instanceof Error ? error.message : String(error);
      job.error = {
        message: job.message,
        stack: error instanceof Error ? error.stack : undefined,
      };
      job.finishedAt = Date.now();
    } finally {
      runningJobIds.delete(jobId);
      stopConsoleCapture();
      // 工作流提前抛出时，可能还有步骤停在 running，标成中断避免展示成永久运行中
      const finishedAt = job.finishedAt ?? Date.now();
      for (const step of job.steps ?? []) {
        if (step.status === "running") {
          step.status = "failure";
          step.finishedAt = finishedAt;
          step.error = step.error ?? "步骤未正常结束（工作流中断）";
        }
      }
      persistWorkflowJobsSoon(true);
    }
  });
  return job;
};

const readJsonBody = async (request: Request) => {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const serveStatic = async (pathname: string) => {
  const safePath = pathname === "/" ? "/prototype.html" : pathname;
  if (safePath.includes("..")) {
    return new Response("Forbidden", { status: 403 });
  }
  const filePath = join(docsDir, safePath);
  try {
    const file = await Deno.readFile(filePath);
    return new Response(file, {
      headers: {
        "Content-Type": getContentType(filePath),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
};

/**
 * 微信公众号 IP 白名单检测。
 *
 * 微信所有需要 access_token 的接口（含 draft/add 创建草稿）都会校验调用方 IP，
 * 不在白名单时统一返回 errcode 40164，且 errmsg 里带着**微信侧看到的那个 IP**。
 *
 * 为什么不用本机自测出口 IP（如 ipify）：实测两者并不一致
 * （本机查到 161.118.247.247，微信看到 120.239.70.0，中间有代理/VPN）。
 * 真正要加进白名单的是微信报错里的那个地址，所以这里直连微信反查。
 */
type WeixinIpCheck = {
  ok: boolean;
  reason: "ok" | "ip-not-whitelisted" | "missing-credentials" | "error";
  /** 微信侧看到的调用方 IP（仅 ip-not-whitelisted 时能拿到） */
  ip?: string;
  errcode?: number;
  errmsg?: string;
  checkedAt: number;
};

/** errmsg 形如：invalid ip 120.239.70.0 ipv6 ::ffff:120.239.70.0, not in whitelist */
const WEIXIN_INVALID_IP_PATTERN = /invalid ip\s+([0-9a-fA-F:.]+)/i;

/** 避免每次刷新页面都去打微信 token 接口（该接口有每日调用上限） */
const WEIXIN_IP_CHECK_TTL_MS = 60_000;
let weixinIpCheckCache: { at: number; value: WeixinIpCheck } | null = null;

const checkWeixinIpWhitelist = async (
  force = false,
): Promise<WeixinIpCheck> => {
  if (
    !force && weixinIpCheckCache &&
    Date.now() - weixinIpCheckCache.at < WEIXIN_IP_CHECK_TTL_MS
  ) {
    return weixinIpCheckCache.value;
  }

  const checkedAt = Date.now();
  const remember = (value: WeixinIpCheck): WeixinIpCheck => {
    weixinIpCheckCache = { at: Date.now(), value };
    return value;
  };

  const manager = ConfigManager.getInstance();
  const appId = await manager.get("WEIXIN_APP_ID");
  const appSecret = await manager.get("WEIXIN_APP_SECRET");
  if (!appId || !appSecret) {
    return remember({ ok: false, reason: "missing-credentials", checkedAt });
  }

  try {
    const resp = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`,
    );
    const data = await resp.json();
    if (!data.errcode) {
      return remember({ ok: true, reason: "ok", checkedAt });
    }
    const errmsg = String(data.errmsg ?? "");
    const matched = errmsg.match(WEIXIN_INVALID_IP_PATTERN);
    if (Number(data.errcode) === 40164 && matched) {
      return remember({
        ok: false,
        reason: "ip-not-whitelisted",
        ip: matched[1],
        errcode: 40164,
        errmsg,
        checkedAt,
      });
    }
    return remember({
      ok: false,
      reason: "error",
      errcode: Number(data.errcode) || undefined,
      errmsg,
      checkedAt,
    });
  } catch (error) {
    return remember({
      ok: false,
      reason: "error",
      errmsg: error instanceof Error ? error.message : String(error),
      checkedAt,
    });
  }
};

const startUiServer = () => {
  const port = Number(Deno.env.get("UI_PORT") || 8002);
  Deno.serve({ port }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/overview") {
      const data = await buildOverview();
      return jsonResponse(data);
    }
    if (url.pathname === "/api/weixin/ip-check") {
      const force = url.searchParams.get("force") === "1";
      return jsonResponse(await checkWeixinIpWhitelist(force));
    }
    if (url.pathname === "/api/workflows/run") {
      if (request.method !== "POST") {
        return jsonResponse({ message: "Method Not Allowed" }, 405);
      }
      const body = await readJsonBody(request);
      if (!body || typeof body.type !== "string") {
        return jsonResponse({ message: "Invalid request body" }, 400);
      }
      const type = body.type as ApiWorkflowType;
      if (
        type !== "weixin-article" && type !== "weixin-aibench" &&
        type !== "weixin-hellogithub" && type !== "weixin-deep-article"
      ) {
        return jsonResponse({ message: "Unsupported workflow type" }, 400);
      }
      const payload = body.payload && typeof body.payload === "object"
        ? body.payload
        : {};
      const job = await runWorkflowJob(
        type,
        payload as Record<string, unknown>,
      );
      return jsonResponse(
        { jobId: job.id, status: job.status, type: job.type },
        202,
      );
    }
    if (url.pathname === "/api/workflows/status") {
      const jobId = url.searchParams.get("jobId");
      if (!jobId) {
        return jsonResponse({ message: "Missing jobId" }, 400);
      }
      const job = await findWorkflowJob(jobId);
      if (!job) {
        return jsonResponse({ message: "Job not found" }, 404);
      }
      return jsonResponse(job);
    }
    if (url.pathname === "/api/drafts") {
      if (request.method !== "GET") {
        return jsonResponse({ message: "Method Not Allowed" }, 405);
      }
      const drafts = await readDraftsFile();
      const list = drafts.map(({ html: _html, ...rest }) => rest);
      return jsonResponse({ drafts: list });
    }
    const draftPublishMatch = url.pathname.match(
      /^\/api\/drafts\/([^/]+)\/publish$/,
    );
    if (draftPublishMatch) {
      if (request.method !== "POST") {
        return jsonResponse({ message: "Method Not Allowed" }, 405);
      }
      const id = draftPublishMatch[1];
      const result = await publishDraftById(id);
      if (!result) {
        return jsonResponse({ message: "Draft not found" }, 404);
      }
      return jsonResponse(result);
    }
    const draftMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);
    if (draftMatch) {
      const id = draftMatch[1];
      if (request.method === "GET") {
        const draft = await getDraftById(id);
        if (!draft) {
          return jsonResponse({ message: "Draft not found" }, 404);
        }
        return jsonResponse(draft);
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request);
        const title = body?.title;
        const html = body?.html;
        if (typeof title !== "string" || typeof html !== "string") {
          return jsonResponse({ message: "Invalid request body" }, 400);
        }
        const updated = await updateDraftById(id, { title, html });
        if (!updated) {
          return jsonResponse({ message: "Draft not found" }, 404);
        }
        return jsonResponse(updated);
      }
      if (request.method === "DELETE") {
        const removed = await deleteDraftById(id);
        if (!removed) {
          return jsonResponse({ message: "Draft not found" }, 404);
        }
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ message: "Method Not Allowed" }, 405);
    }
    if (url.pathname === "/api/data-sources") {
      if (request.method === "GET") {
        const sourceConfig = await getDataSources();
        const sources = Object.entries(sourceConfig).flatMap((
          [platform, items],
        ) =>
          items.map((item) => ({
            platform,
            identifier: item.identifier,
            id: makeSourceKey(platform, item.identifier),
          }))
        );
        return jsonResponse({ sources });
      }
      if (request.method === "DELETE") {
        const source = normalizeDataSource(
          url.searchParams.get("platform"),
          url.searchParams.get("identifier"),
        );
        if (!source) {
          return jsonResponse(
            { message: "Invalid platform or source URL" },
            400,
          );
        }
        const sourceConfig = await getDataSources();
        const exists = (sourceConfig[source.platform] ?? []).some(
          (item) => item.identifier === source.identifier,
        );
        if (!exists) {
          return jsonResponse({ message: "Data source not found" }, 404);
        }
        await deleteDataSourcePreference(source);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ message: "Method Not Allowed" }, 405);
    }
    if (url.pathname === "/api/data-source-rules") {
      if (request.method === "GET") {
        const platform = url.searchParams.get("platform") || "";
        const identifier = url.searchParams.get("identifier") || "";
        if (!platform || !identifier) {
          return jsonResponse({ message: "Missing platform/identifier" }, 400);
        }
        const key = makeSourceKey(platform, identifier);
        const ui = await readUiConfigFile();
        const rulesBySource =
          (ui.sourceRules && typeof ui.sourceRules === "object")
            ? ui.sourceRules as Record<string, unknown>
            : {};
        return jsonResponse({
          platform,
          identifier,
          rules: rulesBySource[key] ?? null,
        });
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request);
        const platform = body?.platform;
        const identifier = body?.identifier;
        const rules = body?.rules;
        if (
          typeof platform !== "string" || typeof identifier !== "string" ||
          !platform || !identifier || typeof rules !== "object" || !rules
        ) {
          return jsonResponse({ message: "Invalid request body" }, 400);
        }
        const key = makeSourceKey(platform, identifier);
        const ui = await readUiConfigFile();
        const next: UiConfigFile = { ...ui };
        const rulesBySource =
          (next.sourceRules && typeof next.sourceRules === "object")
            ? next.sourceRules as Record<string, unknown>
            : {};
        rulesBySource[key] = rules;
        next.sourceRules = rulesBySource;
        await writeUiConfigFile(next);
        return jsonResponse({ ok: true, platform, identifier });
      }
      return jsonResponse({ message: "Method Not Allowed" }, 405);
    }
    if (url.pathname === "/api/workflow-settings") {
      if (request.method === "GET") {
        const ui = await readUiConfigFile();
        return jsonResponse(ui.workflowSettings ?? {});
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object") {
          return jsonResponse({ message: "Invalid request body" }, 400);
        }
        const ui = await readUiConfigFile();
        await writeUiConfigFile({
          ...ui,
          workflowSettings: body as Record<string, unknown>,
        });
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ message: "Method Not Allowed" }, 405);
    }
    if (url.pathname === "/api/templates/preview") {
      if (request.method !== "POST") {
        return jsonResponse({ message: "Method Not Allowed" }, 405);
      }
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object") {
        return jsonResponse({ message: "Invalid request body" }, 400);
      }
      const workflowType = normalizePreviewWorkflow(
        (body as Record<string, unknown>).workflowType,
      );
      const templateType = normalizeArticleTemplate(
        (body as Record<string, unknown>).templateType,
      );
      const count = clampNumber(
        typeof (body as Record<string, unknown>).count === "number"
          ? (body as Record<string, unknown>).count as number
          : null,
        1,
        20,
        6,
      );
      const html = await renderPreviewHtml(workflowType, templateType, count);
      return jsonResponse({ html, workflowType, templateType });
    }
    if (url.pathname === "/api/templates/export") {
      if (request.method !== "POST") {
        return jsonResponse({ message: "Method Not Allowed" }, 405);
      }
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object") {
        return jsonResponse({ message: "Invalid request body" }, 400);
      }
      const workflowType = normalizePreviewWorkflow(
        (body as Record<string, unknown>).workflowType,
      );
      const templateType = normalizeArticleTemplate(
        (body as Record<string, unknown>).templateType,
      );
      const count = clampNumber(
        typeof (body as Record<string, unknown>).count === "number"
          ? (body as Record<string, unknown>).count as number
          : null,
        1,
        20,
        6,
      );
      const html = await renderPreviewHtml(workflowType, templateType, count);
      const outputDir = join(Deno.cwd(), "output");
      await Deno.mkdir(outputDir, { recursive: true });
      const now = new Date();
      const fileName = `preview-${workflowType}-${templateType}-${
        pad(now.getHours())
      }${pad(now.getMinutes())}${pad(now.getSeconds())}.html`;
      const outputPath = join(outputDir, fileName);
      await Deno.writeTextFile(outputPath, html);
      return jsonResponse({ ok: true, fileName, outputPath });
    }
    if (url.pathname === "/api/templates/default") {
      if (request.method !== "POST") {
        return jsonResponse({ message: "Method Not Allowed" }, 405);
      }
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object") {
        return jsonResponse({ message: "Invalid request body" }, 400);
      }
      const templateType = normalizeArticleTemplate(
        (body as Record<string, unknown>).templateType,
      );
      const settings = await updateDefaultArticleTemplate(templateType);
      return jsonResponse({ ok: true, templateType, settings });
    }
    return await serveStatic(url.pathname);
  });
};
async function bootstrap() {
  const configManager = ConfigManager.getInstance();
  await configManager.initDefaultConfigSources();

  Logger.level = LogLevel.INFO;

  // 内存里的运行记录只活到进程退出，启动时把上一次落盘的历史读回来
  await loadWorkflowJobs();

  startCronJobs();
}
if (Deno.env.get("DISABLE_UI_SERVER") !== "true") {
  startUiServer();
}

bootstrap().catch(console.error);
