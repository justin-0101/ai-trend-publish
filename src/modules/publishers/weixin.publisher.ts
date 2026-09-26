import { ConfigManager } from "../../utils/config/config-manager.ts";
import type { CoverSource } from "../../utils/image/cover-source.ts";
import {
  ContentPublisher,
  PublishResult,
} from "../interfaces/publisher.interface.ts";

interface WeixinToken {
  access_token: string;
  expires_in: number;
  expiresAt: Date;
}

interface WeixinDraft {
  media_id: string;
  article_id?: string;
}

/** 字节指纹：只用于内存缓存 key，不做安全用途 */
const fnv1a = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
};

export class WeixinPublisher implements ContentPublisher {
  private accessToken: WeixinToken | null = null;
  private appId: string | undefined;
  private appSecret: string | undefined;
  private cachedThumbMediaId: string | null = null;
  /** 同一张封面（URL 或字节指纹）在一个进程内只上传一次 */
  private thumbCache = new Map<string, string>();

  async uploadImage(imageUrl: string): Promise<string> {
    try {
      const token = await this.ensureAccessToken();
      const { arrayBuffer, filename, fileType } = await this.getImageFile(
        imageUrl,
      );
      const form = new FormData();
      form.append(
        "media",
        new File([arrayBuffer], filename, { type: fileType }),
      );
      const response = await fetch(
        `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${token}`,
        {
          method: "POST",
          body: form,
        }
      );

      if (!response.ok) {
        throw new Error(`上传图片失败: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.errcode) {
        throw new Error(`上传图片失败: ${data.errmsg}`);
      }

      return data.url;
    } catch (error) {
      throw new Error(`上传图片失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 直接上传内存里的图片字节（与 uploadImage 同一个接口）。
   * 用于本地生成的占位图这类没有可拉取 URL 的场景。
   */
  async uploadImageBuffer(
    data: Uint8Array,
    filename = "cover.png",
    mimeType = "image/png",
  ): Promise<string> {
    try {
      const token = await this.ensureAccessToken();
      const form = new FormData();
      form.append("media", new File([data as BlobPart], filename, { type: mimeType }));
      const response = await fetch(
        `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${token}`,
        {
          method: "POST",
          body: form,
        }
      );

      if (!response.ok) {
        throw new Error(`上传图片失败: ${response.statusText}`);
      }

      const result = await response.json();
      if (result.errcode) {
        throw new Error(`上传图片失败: ${result.errmsg}`);
      }

      return result.url;
    } catch (error) {
      throw new Error(`上传图片失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getImageFile(
    imageUrl: string,
  ): Promise<{ arrayBuffer: ArrayBuffer; filename: string; fileType: string }> {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`获取图片失败: ${response.statusText}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const arrayBuffer = await response.arrayBuffer();
    const url = new URL(imageUrl);
    const ext = url.pathname.split(".").pop()?.toLowerCase() || "";
    const extensionMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
    };
    const isImageType = contentType.startsWith("image/");
    const fileType = isImageType
      ? contentType.split(";")[0]
      : extensionMap[ext];
    if (!fileType) {
      throw new Error(`封面图片类型不受支持: ${contentType || ext || "unknown"}`);
    }
    const filename = `cover.${ext || fileType.split("/")[1] || "jpg"}`;
    return { arrayBuffer, filename, fileType };
  }

  constructor() {
    this.refresh();
  }

  async refresh(): Promise<void> {
    await this.validateConfig();
    this.appId = await ConfigManager.getInstance().get("WEIXIN_APP_ID");
    this.appSecret = await ConfigManager.getInstance().get("WEIXIN_APP_SECRET");
  }

  async validateConfig(): Promise<void> {
    if (
      !(await ConfigManager.getInstance().get("WEIXIN_APP_ID")) ||
      !(await ConfigManager.getInstance().get("WEIXIN_APP_SECRET"))
    ) {
      throw new Error(
        "微信公众号配置不完整，请检查 WEIXIN_APP_ID 和 WEIXIN_APP_SECRET",
      );
    }
  }

  private async ensureAccessToken(): Promise<string> {
    if (!this.appId || !this.appSecret) {
      await this.refresh();
    }

    // 检查现有token是否有效
    if (
      this.accessToken &&
      this.accessToken.expiresAt > new Date(Date.now() + 60000) // 预留1分钟余量
    ) {
      return this.accessToken.access_token;
    }

    // 获取新token
    const response = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`,
    );

    if (!response.ok) {
      throw new Error(`获取微信access_token失败: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.errcode) {
      throw new Error(`获取微信access_token失败(${data.errcode}): ${data.errmsg}`);
    }

    this.accessToken = {
      access_token: data.access_token,
      expires_in: data.expires_in,
      expiresAt: new Date(Date.now() + (data.expires_in * 1000)),
    };

    return this.accessToken.access_token;
  }

  private async ensureThumbMediaId(token: string): Promise<string> {
    if (this.cachedThumbMediaId) return this.cachedThumbMediaId;

    const configured = Deno.env.get("WEIXIN_THUMB_MEDIA_ID");
    if (configured && configured.trim().length > 0) {
      this.cachedThumbMediaId = configured.trim();
      return this.cachedThumbMediaId;
    }

    const imageUrl =
      (Deno.env.get("WEIXIN_THUMB_IMAGE_URL") &&
          Deno.env.get("WEIXIN_THUMB_IMAGE_URL")!.trim().length > 0)
        ? Deno.env.get("WEIXIN_THUMB_IMAGE_URL")!.trim()
        : "https://placehold.co/600x400.jpg";

    const imageResp = await fetch(imageUrl);
    if (!imageResp.ok) {
      throw new Error(`获取封面图片失败: ${imageResp.statusText}`);
    }

    const contentType = imageResp.headers.get("content-type") || "";
    const arrayBuffer = await imageResp.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const isJpeg = contentType.includes("image/jpeg") ||
      contentType.includes("image/jpg");
    const isPng = contentType.includes("image/png");
    if (!isJpeg && !isPng) {
      throw new Error(`封面图片类型不受支持: ${contentType || "unknown"}`);
    }

    const filename = isPng ? "cover.png" : "cover.jpg";
    const fileType = isPng ? "image/png" : "image/jpeg";
    const form = new FormData();
    form.append("media", new File([bytes], filename, { type: fileType }));

    const response = await fetch(
      `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=image`,
      { method: "POST", body: form },
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`上传封面素材失败: ${response.statusText}`);
    }
    if (data.errcode) {
      throw new Error(`上传封面素材失败(${data.errcode}): ${data.errmsg}`);
    }
    if (!data.media_id) {
      throw new Error("上传封面素材失败: 未返回 media_id");
    }

    this.cachedThumbMediaId = data.media_id as string;
    return this.cachedThumbMediaId;
  }

  /**
   * 把封面（URL 或内存字节）上传成**草稿封面素材**，返回 `thumb_media_id`。
   *
   * 注意：不能用 `uploadImage()`（`cgi-bin/media/uploadimg`）的返回值当封面——
   * 它返回的是正文图片 URL，不是 `thumb_media_id`；草稿封面必须走永久素材接口
   * （`material/add_material?type=thumb`）。同一张图在同一进程内只传一次，
   * 避免反复占用素材配额。
   */
  async uploadThumb(source: CoverSource): Promise<string> {
    const cacheKey = source.kind === "url"
      ? `url:${source.imageUrl}`
      : `bytes:${source.data.length}:${fnv1a(source.data)}`;
    const cached = this.thumbCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let bytes: Uint8Array;
    let filename: string;
    let mimeType: string;

    if (source.kind === "bytes") {
      bytes = source.data;
      filename = source.filename;
      mimeType = source.mimeType;
    } else {
      const resp = await fetch(source.imageUrl);
      if (!resp.ok) {
        throw new Error(`获取封面图片失败: ${resp.statusText}`);
      }
      const rawType = (resp.headers.get("content-type") || "").split(";")[0]
        .trim();
      bytes = new Uint8Array(await resp.arrayBuffer());
      let ext = "";
      try {
        ext = (new URL(source.imageUrl).pathname.split(".").pop() || "")
          .toLowerCase();
      } catch {
        ext = "";
      }
      mimeType = rawType.startsWith("image/")
        ? rawType
        : (ext === "png" ? "image/png" : "image/jpeg");
      filename = mimeType === "image/png" ? "cover.png" : "cover.jpg";
    }

    try {
      const token = await this.ensureAccessToken();
      const form = new FormData();
      form.append(
        "media",
        new File([bytes as BlobPart], filename, { type: mimeType }),
      );
      const response = await fetch(
        `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=thumb`,
        { method: "POST", body: form },
      );
      if (!response.ok) {
        throw new Error(`上传封面素材失败: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.errcode) {
        throw new Error(`上传封面素材失败(${data.errcode}): ${data.errmsg}`);
      }
      if (!data.media_id) {
        throw new Error("上传封面素材失败: 未返回 media_id");
      }
      this.thumbCache.set(cacheKey, data.media_id as string);
      return data.media_id as string;
    } catch (error) {
      throw new Error(
        `上传封面素材失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async publish(
    content: string,
    options?: { title?: string; author?: string; thumbMediaId?: string },
  ): Promise<PublishResult> {
    try {
      const token = await this.ensureAccessToken();
      let thumbMediaId = options?.thumbMediaId || "";
      
      // 如果没有提供 thumbMediaId，尝试获取默认的（如果网络允许）
      if (!thumbMediaId) {
        try {
          thumbMediaId = await this.ensureThumbMediaId(token);
        } catch (e) {
          console.log("⚠️ 获取默认封面失败，继续发布（无封面）:", e instanceof Error ? e.message : String(e));
          thumbMediaId = "";
        }
      }
      
      const draft = await this.createDraft(token, content, thumbMediaId, options);
      const publishId = draft.media_id;

      return {
        success: true,
        publishId,
        status: "draft",
        publishedAt: new Date(),
        platform: "weixin",
        url: "",
      };
    } catch (error) {
      return {
        success: false,
        publishId: "",
        status: "failed",
        publishedAt: new Date(),
        platform: "weixin",
        url: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async createDraft(
    token: string,
    content: string,
    thumbMediaId: string,
    options?: { title?: string; author?: string },
  ): Promise<WeixinDraft> {
    // 兜底值用占位符：仓库公开，公众号名不入代码（真实值走 options 或 .env 的 AUTHOR）
    const author = options?.author || Deno.env.get("AUTHOR") || "your_name";
    const title = options?.title || "每日AI趋势";
    const digest = content.substring(0, 80).replace(/<[^>]*>/g, "").replace(/\n/g, " ").substring(0, 60) + "...";
    const response = await fetch(
      `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          articles: [
            {
              title: title,
              author,
              digest: digest,
              content,
              content_source_url: "",
              thumb_media_id: thumbMediaId,
              need_open_comment: 0,
              only_fans_can_comment: 0,
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`创建微信草稿失败: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.errcode) {
      throw new Error(`创建微信草稿失败(${data.errcode}): ${data.errmsg}`);
    }

    return {
      media_id: data.media_id,
    };
  }
}
