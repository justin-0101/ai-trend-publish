import { IDataSource } from "./interfaces/data-source.interface.ts";
import { FirecrawlDataSource } from "./sources/firecrawl.source.ts";
import { TwitterDataSource } from "./sources/twitter.source.ts";
import { GitHubDataSource } from "./sources/github.source.ts";
import { HelloGitHubDataSource } from "./sources/hellogithub.source.ts";

export class DataSourceFactory {
  private static instance: DataSourceFactory;
  private sources: Map<string, IDataSource> = new Map();

  private constructor() {
    this.registerDefaultSources();
  }

  public static getInstance(): DataSourceFactory {
    if (!DataSourceFactory.instance) {
      DataSourceFactory.instance = new DataSourceFactory();
    }
    return DataSourceFactory.instance;
  }

  private registerDefaultSources(): void {
    this.sources.set("FIRECRAWL", new FirecrawlDataSource());
    this.sources.set("TWITTER", new TwitterDataSource());
    this.sources.set("GITHUB", new GitHubDataSource());
    this.sources.set("HELLOGITHUB", new HelloGitHubDataSource());
  }

  public async getDataSource(name: string): Promise<IDataSource> {
    const source = this.sources.get(name);
    if (!source) {
      throw new Error(`数据源 "${name}" 不存在`);
    }
    return source;
  }

  public registerDataSource(name: string, source: IDataSource): void {
    this.sources.set(name, source);
  }
}