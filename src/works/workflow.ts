import { Logger } from "@zilla/logger";
import { MetricsCollector } from "@src/works/metrics.ts";
import { RetryOptions, RetryUtil } from "@src/utils/retry.util.ts";
import { WorkflowStepError, WorkflowTerminateError } from "./workflow-error.ts";

const logger = new Logger("workflow");

// 工作流事件接口定义
export interface WorkflowEvent<T = any> {
  payload: T;
  id: string;
  timestamp: number;
}

// 步骤执行记录：供外部（例如 Web 控制台的"运行详情"）观察每一步的执行情况。
// 字段只描述事实，不参与工作流逻辑。
export interface WorkflowStepRecord {
  /** 本次 step.do 调用的唯一标识（同一步骤可能被多次调用） */
  instanceId: string;
  workflowId?: string;
  /** 工作流事件 id；Web 控制台里就是 jobId */
  eventId?: string;
  stepId: string;
  name: string;
  status: "running" | "success" | "failure";
  startedAt: number;
  finishedAt?: number;
  attempts?: number;
  error?: string;
  /** 成功时的返回值（原样传递，由观察者自行截断展示） */
  result?: unknown;
}

export type WorkflowStepObserver = (record: WorkflowStepRecord) => void;

const stepObservers = new Set<WorkflowStepObserver>();

/**
 * 注册步骤观察者，返回取消注册的函数。
 * 未注册时不影响任何行为；观察者内部抛错也不会影响工作流执行。
 */
export const addWorkflowStepObserver = (
  observer: WorkflowStepObserver,
): (() => void) => {
  stepObservers.add(observer);
  return () => {
    stepObservers.delete(observer);
  };
};

let stepInstanceSeq = 0;

const notifyStepObservers = (record: WorkflowStepRecord) => {
  for (const observer of stepObservers) {
    try {
      observer(record);
    } catch (error) {
      logger.warn(
        `Step observer failed: ${(error as Error).message}`,
      );
    }
  }
};

// 工作流步骤选项接口
export interface WorkflowStepOptions {
  retries?: {
    limit: number;
    delay: string | number;
    backoff: "linear" | "exponential";
  };
  timeout?: string | number;
}

// 工作流步骤类
export class WorkflowStep {
  private stepId: string;
  private startTime: number;
  private metricsCollector?: MetricsCollector;
  private workflowId?: string;
  private eventId?: string;

  constructor(
    stepId: string,
    metricsCollector?: MetricsCollector,
    workflowId?: string,
    eventId?: string,
  ) {
    this.stepId = stepId;
    this.startTime = Date.now();
    this.metricsCollector = metricsCollector;
    this.workflowId = workflowId;
    this.eventId = eventId;
  }

  async do<T>(
    name: string,
    optionsOrFn: WorkflowStepOptions | (() => Promise<T>),
    fn?: () => Promise<T>,
  ): Promise<T> {
    const options: WorkflowStepOptions = typeof optionsOrFn === "function"
      ? {}
      : optionsOrFn;
    const execFn = typeof optionsOrFn === "function" ? optionsOrFn : fn!;
    const stepStartTime = Date.now();
    const instanceId = `${this.stepId}:${name}:${++stepInstanceSeq}`;
    const baseRecord = {
      instanceId,
      workflowId: this.workflowId,
      eventId: this.eventId,
      stepId: this.stepId,
      name,
      startedAt: stepStartTime,
    };
    // 同一次 step.do 只上报一次终态，避免下方 catch 重复上报
    let finalReported = false;
    notifyStepObservers({ ...baseRecord, status: "running" });

    try {
      // 转换为RetryUtil的选项格式
      const retryOptions: RetryOptions = {
        maxRetries: options.retries?.limit || 3,
        baseDelay: this.parseDelay(options.retries?.delay || "1 second"),
        useExponentialBackoff: options.retries?.backoff === "exponential",
      };

      // 包装执行函数，添加超时控制
      const timeoutMs = this.parseDelay(options.timeout || "30 minutes");
      const operationWithTimeout = async () => {
        try {
          return await this.executeWithTimeout(execFn, timeoutMs);
        } catch (error) {
          // 如果是终止错误，直接抛出，不进行重试
          if (error instanceof WorkflowTerminateError) {
            throw error;
          }
          // 其他错误包装为 WorkflowStepError
          throw new WorkflowStepError(
            error instanceof Error ? error.message : String(error),
          );
        }
      };

      // 使用RetryUtil执行操作并获取详细信息
      const retryResult = await RetryUtil.retryOperationWithStats(
        operationWithTimeout,
        retryOptions,
      );

      if (this.metricsCollector && this.workflowId && this.eventId) {
        this.metricsCollector.recordStep(this.workflowId, this.eventId, {
          stepId: this.stepId,
          name,
          startTime: stepStartTime,
          endTime: Date.now(),
          status: retryResult.success ? "success" : "failure",
          attempts: retryResult.attempts,
          error: retryResult.error?.message,
        });
      }

      if (!retryResult.success) {
        finalReported = true;
        notifyStepObservers({
          ...baseRecord,
          status: "failure",
          finishedAt: Date.now(),
          attempts: retryResult.attempts,
          error: retryResult.error?.message,
        });
        throw retryResult.error;
      }

      logger.info(
        `Step ${name} completed successfully after ${retryResult.attempts} attempts, time: ${
          Date.now() - stepStartTime
        }ms`,
      );
      finalReported = true;
      notifyStepObservers({
        ...baseRecord,
        status: "success",
        finishedAt: Date.now(),
        attempts: retryResult.attempts,
        result: retryResult.result,
      });
      return retryResult.result;
    } catch (error: any) {
      // 如果是终止错误，记录日志后直接抛出
      if (error instanceof WorkflowTerminateError) {
        logger.error(`Step ${name} terminated: ${error.message}`);
        if (this.metricsCollector && this.workflowId && this.eventId) {
          this.metricsCollector.recordStep(this.workflowId, this.eventId, {
            stepId: this.stepId,
            name,
            startTime: stepStartTime,
            endTime: Date.now(),
            status: "failure",
            attempts: 1,
            error: `Terminated: ${error.message}`,
          });
        }
        if (!finalReported) {
          finalReported = true;
          notifyStepObservers({
            ...baseRecord,
            status: "failure",
            finishedAt: Date.now(),
            attempts: 1,
            error: `Terminated: ${error.message}`,
          });
        }
        throw error;
      }

      logger.error(`Step ${name} failed: ${error.message}`);
      if (!finalReported) {
        finalReported = true;
        notifyStepObservers({
          ...baseRecord,
          status: "failure",
          finishedAt: Date.now(),
          attempts: 1,
          error: error?.message ?? String(error),
        });
      }
      throw error;
    }
  }

  async sleep(reason: string, duration: string | number): Promise<void> {
    const ms = this.parseDelay(duration);
    logger.info(`Sleeping for ${ms}ms: ${reason}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeout: number,
  ): Promise<T> {
    // 定时器必须在结束时清掉。
    // 不清的后果：每个 step.do 都留下一个最长 30 分钟的挂起 timer，
    // 工作流有十几个步骤时既拖住事件循环退出，也让测试报 leaks。
    let timer: number | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Step timeout")), timeout);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private parseDelay(delay: string | number): number {
    if (typeof delay === "number") return delay;
    if (delay === "0") return 0;

    const units: Record<string, number> = {
      second: 1000,
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
    };

    const match = delay.match(/^(\d+)\s+(second|minute|hour|day)s?$/);
    if (!match) {
      logger.warn(`Invalid delay format: ${delay}, using 0 as default`);
      return 0;
    }

    const [, value, unit] = match;
    return parseInt(value) * units[unit];
  }
}

export interface WorkflowEnv<TEnv = any> {
  id: string;
  env: TEnv;
}

// 工作流入口点基类
export abstract class WorkflowEntrypoint<TEnv = any, TParams = any> {
  protected env: WorkflowEnv<TEnv>;
  protected metricsCollector: MetricsCollector;

  constructor(env: WorkflowEnv<TEnv>) {
    this.env = env;
    this.metricsCollector = new MetricsCollector();
  }

  async execute(event: WorkflowEvent<TParams>): Promise<void> {
    this.metricsCollector.startWorkflow(this.env.id, event.id);
    const step = new WorkflowStep(
      "local-step-execution",
      this.metricsCollector,
      this.env.id,
      event.id,
    );

    try {
      await this.run(event, step);
      this.metricsCollector.endWorkflow(this.env.id, event.id);
    } catch (error: any) {
      // 区分终止错误和其他错误
      const isTerminated = error instanceof WorkflowTerminateError;
      this.metricsCollector.endWorkflow(this.env.id, event.id, error);

      if (isTerminated) {
        logger.warn(`Workflow terminated: ${error.message}`);
      } else {
        logger.error(`Workflow failed: ${error.message}`);
      }

      throw error;
    }
  }

  abstract run(
    event: WorkflowEvent<TParams>,
    step: WorkflowStep,
  ): Promise<void>;
}
