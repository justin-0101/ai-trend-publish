import { WeixinArticleWorkflow } from "./services/weixin-article.workflow.ts";
import { ConfigManager } from "./utils/config/config-manager.ts";
import { EnvConfigSource } from "./utils/config/sources/env-config.source.ts";
import { DbConfigSource } from "./utils/config/sources/db-config.source.ts";
import { WeixinAIBenchWorkflow } from "./services/weixin-aibench.workflow.ts";
import { WeixinHelloGithubWorkflow } from "./services/weixin-hellogithub.workflow.ts";

async function bootstrap() {
  const configManager = ConfigManager.getInstance();
  await configManager.initDefaultConfigSources();

  const weixinWorkflow = new WeixinArticleWorkflow({
    id: "test-workflow",
    env: {
      name: "test-workflow",
    },
  });

  await weixinWorkflow.execute({
    payload: {
      sourceType: "all",
      maxArticles: 10,
      forcePublish: true,
    },
    id: "manual-action",
    timestamp: Date.now(),
  });

  const stats = weixinWorkflow.getWorkflowStats("manual-action");
  console.debug("Workflow stats:", stats);

  // const weixinAIBenchWorkflow = new WeixinAIBenchWorkflow();
  // await weixinAIBenchWorkflow.process();

  // const weixinHelloGithubWorkflow = new WeixinHelloGithubWorkflow();
  // await weixinHelloGithubWorkflow.process();
}

bootstrap().catch(console.error);
