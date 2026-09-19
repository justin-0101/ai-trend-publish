/**
 * 封面上传的来源。
 *
 * 微信草稿的封面是 thumb_media_id（永久素材），必须是真实图片字节；
 * 所以这里统一成"URL 或内存字节"两种形态，由发布器决定怎么上传。
 */
export type CoverSource =
  | { kind: "url"; imageUrl: string }
  | { kind: "bytes"; data: Uint8Array; filename: string; mimeType: string };

/** 把封面变成可用的 media_id */
export type CoverUpload = (source: CoverSource) => Promise<string>;
