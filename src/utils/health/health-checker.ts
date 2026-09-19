import { Logger } from "../logger/logger.ts";
import { DataSourceFactory } from "../../modules/data-sources/data-source.factory.ts";
import { PublisherFactory } from "../../modules/publishers/publisher.factory.ts";

interface HealthStatus {
  status: "healthy" | "unhealthy";
  details: Record<string, {
    status: "healthy" | "unhealthy";
    error?: string;
  }>;
}

export class HealthChecker {
  private static instance: HealthChecker;
  private logger: Logger;

  private constructor() {
    this.logger = Logger.getInstance();
  }

  public static getInstance(): HealthChecker {
    if (!HealthChecker.instance) {
      HealthChecker.instance = new HealthChecker();
    }
    return HealthChecker.instance;
  }

  public async checkHealth(): Promise<HealthStatus> {
    const details: HealthStatus["details"] = {};
    let isHealthy = true;

    try {
      // 检查数据源
      const dataSourceFactory = DataSourceFactory.getInstance();
      const sources = ["FIRECRAWL", "TWITTER"];
      
      for (const sourceName of sources) {
        try {
          const source = await dataSourceFactory.getDataSource(sourceName);
          if (source.validate) {
            const sourceHealth = await source.validate();
            details[`datasource:${sourceName}`] = {
              status: sourceHealth ? "healthy" : "unhealthy",
            };
            if (!sourceHealth) isHealthy = false;
          }
        } catch (error) {
          details[`datasource:${sourceName}`] = {
            status: "unhealthy",
            error: error instanceof Error ? error.message : "未知错误",
          };
          isHealthy = false;
        }
      }

      // 检查发布器
      const publisherFactory = PublisherFactory.getInstance();
      const publishers = ["WECHAT"];
      
      for (const publisherName of publishers) {
        try {
          const publisher = await publisherFactory.getPublisher(publisherName);
          if (publisher.validate) {
            const publisherHealth = await publisher.validate();
            details[`publisher:${publisherName}`] = {
              status: publisherHealth ? "healthy" : "unhealthy",
            };
            if (!publisherHealth) isHealthy = false;
          }
        } catch (error) {
          details[`publisher:${publisherName}`] = {
            status: "unhealthy",
            error: error instanceof Error ? error.message : "未知错误",
          };
          isHealthy = false;
        }
      }
    } catch (error) {
      this.logger.error(`健康检查失败: ${error instanceof Error ? error.message : "未知错误"}`);
      return {
        status: "unhealthy",
        details: {
          system: {
            status: "unhealthy",
            error: "系统健康检查失败",
          },
        },
      };
    }

    return {
      status: isHealthy ? "healthy" : "unhealthy",
      details,
    };
  }
}