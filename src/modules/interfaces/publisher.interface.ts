import type { CoverSource } from "../../utils/image/cover-source.ts";

export interface ContentPublisher {
  // 上传图片到指定平台（正文图片，返回可引用的 URL）
  uploadImage(imageUrl: string): Promise<string>;

  // 上传封面素材（草稿 thumb_media_id）
  uploadThumb(source: CoverSource): Promise<string>;

  // 发布文章到指定平台
  // 标题/作者/封面必须通过 options 传：位置参数会被当成 options 而静默丢失
  publish(
    article: string,
    options?: { title?: string; author?: string; thumbMediaId?: string },
  ): Promise<PublishResult>;
}

export interface PublishResult {
  success: boolean;
  articleId?: string;
  url?: string;
  error?: string;
}

export interface Publisher {
  name: string;
  initialize(): Promise<void>;
  publish(article: string, options?: Record<string, any>): Promise<PublishResult>;
  validate?(): Promise<boolean>;
}

export interface PublishResult {
  publishId: string;
  url?: string;
  status: PublishStatus;
  publishedAt: Date;
  platform: string;
}

export type PublishStatus =
  | "pending"
  | "published"
  | "failed"
  | "draft"
  | "scheduled";
