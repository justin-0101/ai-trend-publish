import { ConfigManager } from "./utils/config/config-manager.ts";
import { ContentGenerator } from "./modules/content/content-generator.ts";
import { CLIParser } from "./utils/cli/cli-parser.ts";
import { Logger } from "./utils/logger/logger.ts";
import { Scheduler } from "./utils/scheduler/scheduler.ts";
import { HealthChecker } from "./utils/health/health-checker.ts";
import { Notifier } from "./utils/notifier/notifier.ts";
import { CLIOptions } from "./interfaces/cli-options.interface.ts";

class TrendPublisher {
  private logger: Logger;
  private configManager: ConfigManager;
  private generator: ContentGenerator;
  private notifier: Notifier;
  private healthChecker: HealthChecker;
  private scheduler: Scheduler;

  constructor() {
    this.logger = Logger.getInstance();
    this.configManager = ConfigManager.getInstance();
    this.generator = new ContentGenerator();
    this.notifier = Notifier.getInstance();
    this.healthChecker = HealthChecker.getInstance();
    this.scheduler = Scheduler.getInstance();
  }

  async run(options: CLIOptions = {}): Promise<boolean> {
    try {
      this.logger.info(`开始生成内容，数据源: ${options.source}, 发布平台: ${options.publisher}`);
      const result = await this.generator.generateAndPublish(
        options.source || "default",
        options.publisher || "default",
        {
          title: options.title || "AI 技术趋势周报",
          template: options.template,
          dryRun: options.dryRun,
          footer: "感谢阅读，下期再见！",
        }
      );

      if (!result.success) {
        throw new Error(result.error);
      }

      this.logger.info("内容发布成功！");
      if (result.url) {
        this.logger.info(`文章链接: ${result.url}`);
      }

      return true;
    } catch (error) {
      this.logger.error(`运行失败: ${error instanceof Error ? error.message : "未知错误"}`);
      return false;
    }
  }

  async runScheduled(schedule = "0 9 * * *"): Promise<void> {
    this.scheduler.addTask("publish", async () => {
      const success = await this.run();
      await this.notifyResult(success);
    }, {
      cron: schedule,
      description: "定时发布AI趋势报告",
    });

    await this.scheduler.start();
    this.logger.info("定时任务已启动，等待执行...");
  }

  private async notifyResult(success: boolean): Promise<void> {
    await this.notifier.notify({
      title: success ? "AI趋势发布成功" : "AI趋势发布失败",
      content: success 
        ? `发布时间: ${new Date().toLocaleString()}\n发布平台: ${this.configManager.get("DEFAULT_PUBLISH_PLATFORMS")}`
        : "请检查日志了解详细错误信息",
      level: success ? "info" : "error",
    });
  }

  async checkHealth(): Promise<boolean> {
    const health = await this.healthChecker.checkHealth();
    
    this.logger.info(`系统健康状态: ${health.status}`);
    for (const [component, status] of Object.entries(health.details)) {
      this.logger.info(`${component}: ${status.status}${status.error ? ` (${status.error})` : ''}`);
    }
    
    return health.status === "healthy";
  }
}

// 命令行入口
if (import.meta.main) {
  const publisher = new TrendPublisher();
  const options = CLIParser.parse();
  
  try {
    await ConfigManager.getInstance().initialize();

    if (options.healthCheck) {
      const healthy = await publisher.checkHealth();
      if (!healthy) {
        Deno.exit(1);
      }
      Deno.exit(0);
    }
    
    if (options.daemon) {
      await publisher.runScheduled(options.schedule);
    } else {
      const success = await publisher.run(options);
      if (!success) {
        Deno.exit(1);
      }
      Deno.exit(0);
    }
  } catch (error) {
    console.error(`程序执行失败: ${error instanceof Error ? error.message : "未知错误"}`);
    Deno.exit(1);
  }
}

export { TrendPublisher };