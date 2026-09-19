import { WeixinPublisher } from "./modules/publishers/weixin.publisher.ts";
import { ConfigManager } from "./utils/config/config-manager.ts";
import { Logger } from "./utils/logger/logger.ts";

async function runPublishTest() {
  const logger = Logger.getInstance();
  logger.info("开始执行发布测试 (WeChat)");

  const configManager = ConfigManager.getInstance();
  await configManager.initDefaultConfigSources();

  const inputPath = "output/test-hellogithub.html";
  try {
    const htmlContent = await Deno.readTextFile(inputPath);
    logger.info(`已读取 HTML 内容，长度: ${htmlContent.length}`);

    const publisher = new WeixinPublisher();
    logger.info("正在推送到微信公众号草稿箱...");
    const result = await publisher.publish(htmlContent);

    if (result.success) {
      logger.info(`✅ 发布成功！`);
      logger.info(`Media ID: ${result.publishId}`);
      logger.info(`请登录微信公众号后台查看草稿箱。`);
    } else {
      logger.error(`❌ 发布失败: ${result.error}`);
    }

  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      logger.error(`❌ 未找到输入文件: ${inputPath}`);
      logger.error(`请先运行 'deno task test:simple' 生成内容。`);
    } else {
      logger.error(`发生错误: ${error}`);
      if (error instanceof Error) {
        console.error(error.stack);
      }
    }
  }
}

runPublishTest();
