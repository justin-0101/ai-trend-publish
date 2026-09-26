import { ConfigManager } from "../utils/config/config-manager.ts";
import db from "../db/db.ts";
import { dataSources } from "../db/schema.ts";
import {
  applyDataSourcePreferences,
  readDataSourcePreferences,
} from "../services/data-source-registry.ts";

export type NewsPlatform =
  | "firecrawl"
  | "twitter"
  | "twitter-cookie"
  | "github"
  | "hellogithub"
  | "weixin"
  | "rss"
  | "reddit"
  | "bilibili"
  | "zhihu";

const logger = {
  info: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg),
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
    {
      identifier:
        "https://api.github.com/search/repositories?q=topic:ai+language:zh+stars:%3E100",
    },
  ],
  hellogithub: [
    { identifier: "https://hellogithub.com/periodical/category/AI" },
  ],
  weixin: [
    {
      identifier:
        "https://api.weixin.qq.com/cgi-bin/material/batchget_material",
    },
  ],
  // 四个预置采集源（固定出现在界面列表里，供直接选择）：
  //   rss      → 量子位 feed（免 key、秒级）
  //   bilibili → 综合热门（免登录，实测可用）
  //   zhihu    → 热榜（走 api.zhihu.com，免登录）
  //   reddit   → r/OpenAI（Atom 口，无需 key；但同 IP 有限速，因此不进 all 模式，要显式选）
  // 要再添同类型的源（例如另一个 feed）改这里即可；界面上只能删除/隐藏，不再支持手动添加。
  rss: [
    { identifier: "https://www.qbitai.com/feed" },
  ],
  bilibili: [
    { identifier: "popular" },
  ],
  zhihu: [
    { identifier: "hot" },
  ],
  reddit: [
    { identifier: "r/OpenAI" },
  ],
} as const;

interface DbSource {
  identifier: string;
  platform: string;
}

export const getDataSources = async (): Promise<SourceConfig> => {
  const configManager = ConfigManager.getInstance();
  const mergedSources: SourceConfig = JSON.parse(JSON.stringify(sourceConfigs));

  try {
    const dbEnabled = await configManager.get("ENABLE_DB");
    if (dbEnabled) {
      logger.info("开始从数据库获取数据源");
      const dbResults = await db.select({
        identifier: dataSources.identifier,
        platform: dataSources.platform,
      })
        .from(dataSources) as DbSource[];

      dbResults.forEach((item: DbSource) => {
        const platform = String(item.platform || "").trim();
        const identifier = String(item.identifier || "").trim();
        if (!platform || !identifier) return;
        const items = mergedSources[platform] ?? (mergedSources[platform] = []);
        if (!items.some((source) => source.identifier === identifier)) {
          items.push({ identifier });
        }
      });
    }
  } catch (error) {
    console.error("Failed to get data sources from database:", error);
  }

  const preferences = await readDataSourcePreferences();
  return applyDataSourcePreferences(mergedSources, preferences);
};
