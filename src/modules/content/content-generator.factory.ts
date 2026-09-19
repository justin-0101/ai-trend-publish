import { IContentGenerator } from "./interfaces/content-generator.interface.ts";
import { DefaultContentGenerator } from "./generators/default.generator.ts";
import { HelloGitHubContentGenerator } from "./generators/hellogithub.generator.ts";

export class ContentGeneratorFactory {
  private static instance: ContentGeneratorFactory;
  private generators: Map<string, IContentGenerator> = new Map();

  private constructor() {
    this.registerDefaultGenerators();
  }

  public static getInstance(): ContentGeneratorFactory {
    if (!ContentGeneratorFactory.instance) {
      ContentGeneratorFactory.instance = new ContentGeneratorFactory();
    }
    return ContentGeneratorFactory.instance;
  }

  private registerDefaultGenerators(): void {
    this.generators.set("default", new DefaultContentGenerator());
    this.generators.set("hellogithub", new HelloGitHubContentGenerator());
  }

  public async getGenerator(name: string): Promise<IContentGenerator> {
    const generator = this.generators.get(name);
    if (!generator) {
      throw new Error(`内容生成器 "${name}" 不存在`);
    }
    return generator;
  }

  public registerGenerator(name: string, generator: IContentGenerator): void {
    this.generators.set(name, generator);
  }
}