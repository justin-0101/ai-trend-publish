import { ConfigManager } from "../config/config-manager.ts";
import { Logger } from "../logger/logger.ts";

export interface NotifyOptions {
  title: string;
  content: string;
  level?: "info" | "warning" | "error";
}

export class Notifier {
  private static instance: Notifier;
  private logger: Logger;
  private configManager: ConfigManager;

  private constructor() {
    this.logger = Logger.getInstance();
    this.configManager = ConfigManager.getInstance();
  }

  public static getInstance(): Notifier {
    if (!Notifier.instance) {
      Notifier.instance = new Notifier();
    }
    return Notifier.instance;
  }

  async notify(options: NotifyOptions): Promise<void> {
    try {
      await Promise.all([
        this.notifyBark(options),
        this.notifyDingDing(options),
      ]);
    } catch (error) {
      this.logger.error(`发送通知失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  private async notifyBark(options: NotifyOptions): Promise<void> {
    if (!this.configManager.get<boolean>("ENABLE_BARK")) return;

    const barkUrl = this.configManager.get<string>("BARK_URL");
    if (!barkUrl) return;

    await fetch(`${barkUrl}/${encodeURIComponent(options.title)}/${encodeURIComponent(options.content)}`, {
      method: "GET",
    });
  }

  private async notifyDingDing(options: NotifyOptions): Promise<void> {
    if (!this.configManager.get<boolean>("ENABLE_DINGDING")) return;

    const webhookUrl = await this.configManager.get<string>("WEBHOOK_URL");
    if (!webhookUrl) {
      return;
    }
    
    await fetch(await webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: {
          title: options.title,
          text: `### ${options.title}\n${options.content}`,
        },
      }),
    });
  }
}