import { HelloGithubScraper } from "./modules/scrapers/hellogithub.scraper.ts";
import { HelloGithubTemplateRenderer } from "./modules/render/hellogithub.renderer.ts";
import { ConfigManager } from "./utils/config/config-manager.ts";
import { Logger } from "./utils/logger/logger.ts";

async function runSimpleTest() {
  const logger = Logger.getInstance();
  logger.info("开始执行最小闭环测试 (HelloGitHub)");

  // 1. 初始化配置
  const configManager = ConfigManager.getInstance();
  await configManager.initDefaultConfigSources();

  // 2. 抓取数据
  const scraper = new HelloGithubScraper();
  logger.info("正在抓取 HelloGitHub 热门项目...");
  
  try {
    const hotItems = await scraper.getHotItems(1);
    if (hotItems.length === 0) {
      logger.error("未获取到热门项目");
      return;
    }
    logger.info(`获取到 ${hotItems.length} 个热门项目`);

    // 获取前3个项目的详情
    const details = [];
    for (const item of hotItems.slice(0, 3)) {
      logger.info(`正在获取项目详情: ${item.title}`);
      const detail = await scraper.getItemDetail(item.itemId);
      details.push(detail);
    }

    // 3. 渲染模板
    logger.info("正在渲染 HTML...");
    const renderer = new HelloGithubTemplateRenderer();
    const html = await renderer.render(details);

    // 4. 保存结果
    const outputPath = "output/test-hellogithub.html";
    await Deno.writeTextFile(outputPath, html);
    logger.info(`测试完成！结果已保存至: ${outputPath}`);

  } catch (error) {
    logger.error(`测试失败: ${error}`);
    if (error instanceof Error) {
        console.error(error.stack);
    }
  }
}

runSimpleTest();
