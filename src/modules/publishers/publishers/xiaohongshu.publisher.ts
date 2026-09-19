import { IPublisher, PublishOptions, PublishResult } from "../interfaces/publisher.interface.ts";
import { ConfigManager } from "../../../utils/config/config-manager.ts";
import { Logger } from "../../../utils/logger/logger.ts";
import puppeteer from "https://deno.land/x/puppeteer@16.2.0/mod.ts";

export class XiaohongshuPublisher implements IPublisher {
  name = "XIAOHONGSHU";
  private logger: Logger;
  private configManager: ConfigManager;

  constructor() {
    this.logger = Logger.getInstance();
    this.configManager = ConfigManager.getInstance();
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    try {
      const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
      });

      const page = await browser.newPage();
      
      // 登录小红书
      await page.goto("https://creator.xiaohongshu.com/login");
      const username = this.configManager.get<string>("XIAOHONGSHU_USERNAME");
      const password = this.configManager.get<string>("XIAOHONGSHU_PASSWORD");

      // 等待登录完成
      await page.waitForSelector(".login-success", { timeout: 60000 });

      // 进入创作页面
      await page.goto("https://creator.xiaohongshu.com/publish/publish");
      
      // 输入标题
      await page.type(".title-input", options.title);

      // 输入内容
      await page.type(".content-editor", options.content);

      // 选择标签
      await page.click(".tag-selector");
      await page.type(".tag-input", "AI");
      await page.keyboard.press("Enter");
      await page.type(".tag-input", "人工智能");
      await page.keyboard.press("Enter");
      await page.type(".tag-input", "科技");
      await page.keyboard.press("Enter");

      // 发布
      await page.click(".publish-button");
      await page.waitForSelector(".publish-success", { timeout: 30000 });

      // 获取文章链接
      const noteUrl = await page.$eval(".note-link", (el) => el.getAttribute("href"));

      await browser.close();

      return {
        success: true,
        url: noteUrl || undefined,
      };
    } catch (error) {
      this.logger.error(`小红书发布失败: ${error instanceof Error ? error.message : "未知错误"}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      };
    }
  }

  async validate(): Promise<boolean> {
    try {
      const browser = await puppeteer.launch();
      const page = await browser.newPage();
      await page.goto("https://creator.xiaohongshu.com/login");
      await browser.close();
      return true;
    } catch {
      return false;
    }
  }
}