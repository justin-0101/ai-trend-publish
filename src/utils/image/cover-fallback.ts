import { readOptionalConfig } from "@src/utils/config/optional-config.ts";
import type { CoverSource, CoverUpload } from "@src/utils/image/cover-source.ts";
import { buildPlaceholderCoverPng } from "@src/utils/image/placeholder-cover.ts";

/**
 * 封面图降级策略（配置键 COVER_FALLBACK_MODE，可不配置）：
 * - skip（默认）：封面生成失败只告警，继续出稿（无封面）
 * - placeholder：失败时用本地生成的占位封面（纯渐变 PNG，无文字）；占位也失败则退回 skip
 * - fail：保持老行为，封面失败就让这一步失败（重试后仍未成功则工作流失败）
 */
export type CoverFallbackMode = "skip" | "placeholder" | "fail";

export const DEFAULT_COVER_FALLBACK_MODE: CoverFallbackMode = "skip";

export const normalizeCoverFallbackMode = (
  raw: unknown,
): CoverFallbackMode => {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "skip" || value === "placeholder" || value === "fail") {
    return value;
  }
  return DEFAULT_COVER_FALLBACK_MODE;
};

export const readCoverFallbackMode = async (): Promise<CoverFallbackMode> =>
  normalizeCoverFallbackMode(await readOptionalConfig("COVER_FALLBACK_MODE"));

export interface CoverResolution {
  /** 传给发布链路的封面 media_id（草稿 thumb_media_id）；空字符串表示无封面 */
  mediaId: string;
  /** 生成出来的图片地址；降级跳过时为空字符串 */
  imageUrl: string;
  degraded: boolean;
  reason?: string;
  /** 是否用了本地占位封面 */
  placeholder?: boolean;
}

export interface ResolveCoverOptions {
  /** 出问题时用来定位的标签，例如 "article:generate-article" */
  label: string;
  /** 生成图片并返回图片地址 */
  generate: () => Promise<string>;
  /** 上传封面并返回 media_id */
  upload: CoverUpload;
  /** 占位封面尺寸；placeholder 模式下使用 */
  placeholder?: { width?: number; height?: number };
  /** 显式指定策略（测试用），默认读配置 */
  mode?: CoverFallbackMode;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 生成封面 + 上传成封面素材，失败时按配置降级。
 *
 * 背景：封面图走的是第三方图片生成服务，账号欠费/额度耗尽这类问题会让
 * 整条工作流在最后一步失败，而封面本身并不值得阻塞出稿。
 */
export const resolveCover = async (
  options: ResolveCoverOptions,
): Promise<CoverResolution> => {
  const { label, generate, upload, placeholder } = options;
  const mode = options.mode ?? await readCoverFallbackMode();

  try {
    const imageUrl = await generate();
    const mediaId: string = await upload({ kind: "url", imageUrl });
    return { mediaId, imageUrl, degraded: false };
  } catch (error) {
    const reason = describe(error);
    if (mode === "fail") {
      throw error;
    }

    if (mode === "placeholder") {
      try {
        const png = await buildPlaceholderCoverPng({
          width: placeholder?.width,
          height: placeholder?.height,
        });
        console.warn(
          `[封面降级] ${label} 封面生成失败（${reason}），改用本地占位封面（${png.length} 字节）`,
        );
        const mediaId = await upload({
          kind: "bytes",
          data: png,
          filename: "cover-placeholder.png",
          mimeType: "image/png",
        });
        return { mediaId, imageUrl: "", degraded: true, reason, placeholder: true };
      } catch (placeholderError) {
        console.warn(
          `[封面降级] ${label} 本地占位封面也失败（${
            describe(placeholderError)
          }），继续无封面出稿`,
        );
      }
    } else {
      console.warn(
        `[封面降级] ${label} 封面生成失败（${reason}），已跳过封面继续出稿` +
          `（COVER_FALLBACK_MODE=${mode}）`,
      );
    }

    return { mediaId: "", imageUrl: "", degraded: true, reason };
  }
};
