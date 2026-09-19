import { ConfigManager } from "../utils/config/config-manager.ts";
import db from "../db/db.ts";
import { dataSources } from "../db/schema.ts";

export type NewsPlatform =
  | "firecrawl"
  | "twitter"
  | "twitter-cookie"
  | "github"
  | "hellogithub"
  | "weixin";

const logger = {
  info: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg)
};

interface SourceItem {
  identifier: string;
}

type SourceConfig = Record<string, SourceItem[]>;

// 本地源配置
export const sourceConfigs: SourceConfig = {
  firecrawl: [
    { identifier: "https://news.ycombinator.com/" },
  ],
  twitter: [
    { identifier: "https://x.com/OpenAIDevs" },
  ],
  "twitter-cookie": [
    { identifier: "https://x.com/OpenAIDevs" },
  ],
  github: [
    { identifier: "https://api.github.com/search/repositories?q=topic:ai+language:zh+stars:%3E100" },
  ],
  hellogithub: [
    { identifier: "https://hellogithub.com/periodical/category/AI" },
  ],
  weixin: [
    { identifier: "https://api.weixin.qq.com/cgi-bin/material/batchget_material" },
  ],
} as const;

interface DbSource {
  identifier: string;
  platform: string;
}

export const getDataSources = async (): Promise<SourceConfig> => {
  const configManager = ConfigManager.getInstance();
  try {
    const dbEnabled = await configManager.get("ENABLE_DB");
    const mergedSources: SourceConfig = JSON.parse(
      JSON.stringify(sourceConfigs),
    );

    if (dbEnabled) {
      logger.info("开始从数据库获取数据源");
      const dbResults = await db.select({
        identifier: dataSources.identifier,
        platform: dataSources.platform,
      })
        .from(dataSources) as DbSource[];

      // 处理数据库结果
      dbResults.forEach((item: DbSource) => {
        const platform = String(item.platform || "").trim();
        const identifier = String(item.identifier || "").trim();
        if (!platform || !identifier) return;
        if (!mergedSources[platform]) {
          mergedSources[platform] = [];
        }
        const exists = mergedSources[platform].some(
          (source) => source.identifier === identifier,
        );
        if (!exists) {
          mergedSources[platform].push({ identifier });
        }
      });
    }

    return mergedSources;
  } catch (error) {
    console.error("Failed to get data sources from database:", error);
    // 数据库不可用时返回本地配置
    return sourceConfigs;
  }
};
