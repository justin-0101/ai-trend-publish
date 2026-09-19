import { Logger } from "../logger/logger.ts";

export interface ScheduleOptions {
  cron: string;  // cron 表达式，如 "0 0 12 * * 1" 表示每周一中午12点
  description?: string;
}

export class Scheduler {
  private static instance: Scheduler;
  private tasks: Map<string, { fn: () => Promise<void>; options: ScheduleOptions }> = new Map();
  private logger: Logger;

  private constructor() {
    this.logger = Logger.getInstance();
  }

  public static getInstance(): Scheduler {
    if (!Scheduler.instance) {
      Scheduler.instance = new Scheduler();
    }
    return Scheduler.instance;
  }

  public addTask(name: string, fn: () => Promise<void>, options: ScheduleOptions) {
    this.tasks.set(name, { fn, options });
    this.logger.info(`添加定时任务: ${name}, 计划: ${options.description || options.cron}`);
  }

  public removeTask(name: string) {
    this.tasks.delete(name);
    this.logger.info(`移除定时任务: ${name}`);
  }

  private parseCron(cron: string): { minute: number; hour: number; dayOfWeek: number } {
    const [minute, hour, , , , dayOfWeek] = cron.split(" ");
    return {
      minute: parseInt(minute),
      hour: parseInt(hour),
      dayOfWeek: parseInt(dayOfWeek),
    };
  }

  private async executeTask(name: string, task: { fn: () => Promise<void>; options: ScheduleOptions }) {
    try {
      this.logger.info(`开始执行任务: ${name}`);
      await task.fn();
      this.logger.info(`任务执行完成: ${name}`);
    } catch (error) {
      this.logger.error(`任务执行失败: ${name}, 错误: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  public async start() {
    this.logger.info("启动定时任务管理器");
    
    setInterval(() => {
      const now = new Date();
      
      for (const [name, task] of this.tasks) {
        const schedule = this.parseCron(task.options.cron);
        
        if (
          now.getMinutes() === schedule.minute &&
          now.getHours() === schedule.hour &&
          (schedule.dayOfWeek === -1 || now.getDay() === schedule.dayOfWeek)
        ) {
          this.executeTask(name, task);
        }
      }
    }, 60000); // 每分钟检查一次
  }
}