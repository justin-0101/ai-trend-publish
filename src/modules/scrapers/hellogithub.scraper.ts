import * as cheerio from "npm:cheerio";
import {
  AIGithubItem,
  AIGithubItemDetail,
} from "@src/modules/render/interfaces/aigithub.type.ts";

export const cleanupHelloGithubReadme = (markdown: string): string => {
  const cleaned = markdown
    .replace(/\r\n/g, "\n")
    .replace(/<pre[\s\S]*?<\/pre>/gi, "")
    .replace(/<code[\s\S]*?<\/code>/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^(?: {4}|\t).+$/gm, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const filtered = lines.filter((line) => {
    if (/^\s*(npm|yarn|pnpm|pip|conda|brew|curl|wget|git)\s+/i.test(line)) {
      return false;
    }
    if (/[{};]/.test(line)) {
      return false;
    }
    if (/\b(const|let|var|function|class|interface|public|private|protected|static|import|from|export|def)\b/i.test(line) && /[();=]/.test(line)) {
      return false;
    }
    if (/\w+\(.*\)/.test(line) && /[=;]/.test(line)) {
      return false;
    }
    return true;
  });

  return filtered.join("\n\n");
};

export class HelloGithubScraper {
  private static readonly BASE_URL = "https://hellogithub.com";
  private static readonly API_URL = "https://abroad.hellogithub.com/v1";
  private static readonly GITHUB_API_URL = "https://api.github.com";

  /**
   * 获取热门仓库列表
   * @param page - 页码
   * @returns 仓库列表
   */
  public async getHotItems(page: number = 1): Promise<AIGithubItem[]> {
    try {
      const url =
        `${HelloGithubScraper.API_URL}/?sort_by=featured&page=${page}&rank_by=newest&tid=juBLV86qa5`;
      const response = await fetch(url);
      const data = await response.json();

      if (!data.success) {
        throw new Error("Failed to fetch hot items");
      }

      return data.data.map((item: any) => ({
        itemId: item.item_id,
        author: item.author,
        title: item.title,
      }));
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error("Failed to fetch hot items:", error);
        throw new Error(`Failed to fetch hot items: ${error.message}`);
      }
      throw new Error("Failed to fetch hot items: Unknown error");
    }
  }

  /**
   * 从 HelloGithub 获取项目详情
   * @param itemId - 项目ID
   * @returns 项目详情
   */
  public async getItemDetail(itemId: string): Promise<AIGithubItemDetail> {
    try {
      const url = `${HelloGithubScraper.BASE_URL}/repository/${itemId}`;
      const response = await fetch(url);
      const html = await response.text();
      const $ = cheerio.load(html);

      // 提取 __NEXT_DATA__ 中的数据
      const nextData = JSON.parse($("#__NEXT_DATA__").text());
      const repoData = nextData.props.pageProps.repo;

      // 提取标签
      const tags = repoData.tags.map((tag: { name: string }) => tag.name);

      // 提取相关链接
      const relatedUrls = [];

      // 提取 GitHub 仓库链接
      const githubUrl = repoData.url;
      const parsedRepo = this.parseGitHubRepo(githubUrl);
      const readme = parsedRepo
        ? await this.fetchGitHubReadme(parsedRepo.owner, parsedRepo.repo)
        : undefined;

      // 提取其他链接
      if (repoData.homepage && repoData.homepage !== githubUrl) {
        relatedUrls.push({ url: repoData.homepage, title: "官网" });
      }
      if (repoData.document && repoData.document !== githubUrl) {
        relatedUrls.push({ url: repoData.document, title: "文档" });
      }
      if (repoData.download && repoData.download !== githubUrl) {
        relatedUrls.push({ url: repoData.download, title: "下载" });
      }
      if (repoData.online && repoData.online !== githubUrl) {
        relatedUrls.push({ url: repoData.online, title: "演示" });
      }
      // 计算上周获得的 star 数
      const starHistory = repoData.star_history;
      const lastWeekStars = starHistory ? starHistory.increment || 0 : 0;

      return {
        itemId,
        author: repoData.author,
        title: repoData.title,
        name: repoData.name,
        url: repoData.url,
        description: repoData.summary,
        readme,
        language: repoData.primary_lang,
        totalStars: repoData.stars,
        totalIssues: repoData.open_issues,
        totalForks: repoData.forks,
        contributors: repoData.contributors,
        lastWeekStars,
        tags,
        license: repoData.license,
        relatedUrls,
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error("Failed to fetch project details:", error);
        throw new Error(`Failed to fetch project details: ${error.message}`);
      }
      throw new Error("Failed to fetch project details: Unknown error");
    }
  }

  private parseGitHubRepo(
    githubUrl: string,
  ): { owner: string; repo: string } | null {
    try {
      const url = new URL(githubUrl);
      if (url.hostname !== "github.com") return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/i, "");
      if (!owner || !repo) return null;
      return { owner, repo };
    } catch {
      return null;
    }
  }

  private async fetchGitHubReadme(
    owner: string,
    repo: string,
  ): Promise<string | undefined> {
    try {
      const token = Deno.env.get("GITHUB_TOKEN");
      const headers: HeadersInit = {
        "Accept": "application/vnd.github.v3.raw",
        "User-Agent": "ai-trend-publish",
      };
      if (token && token.trim().length > 0) {
        headers["Authorization"] = `Bearer ${token.trim()}`;
      }

      const response = await fetch(
        `${HelloGithubScraper.GITHUB_API_URL}/repos/${owner}/${repo}/readme`,
        { headers },
      );
      if (!response.ok) return undefined;

      const text = await response.text();
      const cleaned = this.cleanupReadme(text);
      const maxLen = 2000;
      return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
    } catch {
      return undefined;
    }
  }

  private cleanupReadme(markdown: string): string {
    return cleanupHelloGithubReadme(markdown);
  }
}
