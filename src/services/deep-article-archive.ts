import { join } from "node:path";

/**
 * 深度文的审计产物落盘。
 *
 * 为什么必须落盘：这条工作流的每一步都是一次 LLM 判断，最后只交一篇稿子的话，
 * 「为什么选了这个主题」「作者背景里到底送出去了什么」「哪一步拦下了什么问题」
 * 全都会丢掉。skill 本身也要求交付上下文与审稿报告，所以中间卡一律留档。
 *
 * 目录与 `output/` 同级规则：`output/` 已在 .gitignore 里，落在这里不会入库。
 */

export interface DeepArticleArtifact {
  /** 文件名，例如 "01-主题包清单.md" */
  name: string;
  body: string;
}

/** 纯函数，便于测试：output/deep-article-20260926-1530-关键词 */
export const buildDeepArticleRunDirName = (
  date: Date,
  label: string,
): string => {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${
    pad(date.getDate())
  }-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const safeLabel = (label || "run")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `deep-article-${stamp}${safeLabel ? `-${safeLabel}` : ""}`;
};

export const resolveDeepArticleRunDir = (
  cwd: string,
  runDirName: string,
): string => join(cwd, "output", runDirName);

/**
 * 写产物。单个文件失败只记录，不中断整条工作流——
 * 审计留档不该把一条已经跑完的稿子拖死。返回实际写入的文件名。
 */
export const writeDeepArticleArtifacts = async (
  dir: string,
  artifacts: DeepArticleArtifact[],
): Promise<{ written: string[]; failed: Array<{ name: string; error: string }> }> => {
  const written: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch (error) {
    return {
      written: [],
      failed: artifacts.map((artifact) => ({
        name: artifact.name,
        error: `创建目录失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      })),
    };
  }

  for (const artifact of artifacts) {
    try {
      await Deno.writeTextFile(join(dir, artifact.name), artifact.body);
      written.push(artifact.name);
    } catch (error) {
      failed.push({
        name: artifact.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { written, failed };
};

/** 把任意 JSON 结果渲染成可读 markdown；键值对优先，数组逐条列出。 */
export const renderRecordMarkdown = (title: string, value: unknown): string => {
  const lines = [`# ${title}`, ""];

  const walk = (node: unknown, depth: number): void => {
    const indent = "  ".repeat(depth);
    if (Array.isArray(node)) {
      if (node.length === 0) {
        lines.push(`${indent}- （空）`);
        return;
      }
      for (const item of node) {
        if (item !== null && typeof item === "object") {
          lines.push(`${indent}-`);
          walk(item, depth + 1);
        } else {
          lines.push(`${indent}- ${String(item)}`);
        }
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (child !== null && typeof child === "object") {
          lines.push(`${indent}- **${key}**：`);
          walk(child, depth + 1);
        } else {
          lines.push(`${indent}- **${key}**：${String(child ?? "")}`);
        }
      }
      return;
    }
    lines.push(`${indent}${String(node ?? "")}`);
  };

  walk(value, 0);
  return lines.join("\n");
};

/** 正文段落转 markdown：`<next_paragraph />` 还原成空行。 */
export const contentToMarkdown = (content: string): string =>
  String(content ?? "")
    .split("<next_paragraph />")
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join("\n\n");
