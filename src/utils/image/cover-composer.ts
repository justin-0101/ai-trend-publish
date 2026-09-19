import { decode, Image, TextLayout } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import { buildPlaceholderCoverPng } from "@src/utils/image/placeholder-cover.ts";

/**
 * 封面合成器：在背景图（AI 生成的科技感底图）上叠加**真实字体渲染的中文标题**。
 *
 * 为什么不用文生图模型直接画标题：
 * 扩散模型是把文字当"像素图案"画出来的，中文几乎必然乱码
 * （实测智谱 cogview-4 把"AI 三连炸"画成"AI三连如人"）。
 * 所以拆成两步：模型只负责画**无文字的背景**，标题由字体引擎本地渲染 —— 100% 准确。
 *
 * 渲染引擎是 imagescript 的 WASM 字体库，解析耗时 ∝ 字体体积，
 * 因此 assets/fonts 下的字体均已子集化（详见该目录 README）。
 */

/** 微信永久素材 thumb 类型硬性上限：64 KB */
export const WECHAT_THUMB_MAX_BYTES = 64 * 1024;

/** 默认封面字体（得意黑：倾斜艺术黑，科技感最强，解析最快） */
export const DEFAULT_COVER_FONT = "assets/fonts/SmileySans-Oblique.ttf";

export const DEFAULT_COVER_WIDTH = 1440;
export const DEFAULT_COVER_HEIGHT = 720;

export interface CoverTitleParts {
  /** 主标题（最大字号，通常是冒号前的短句） */
  title: string;
  /** 次标题（中字号，冒号后的具体内容，可空） */
  subline: string;
  /** 页脚信息（小字号，日期 + 栏目） */
  subtitle: string;
}

export interface ComposeCoverOptions extends CoverTitleParts {
  /** 背景图字节（JPEG/PNG）。不传则用本地渐变底图 */
  background?: Uint8Array;
  /** 字体文件路径（相对项目根） */
  fontPath?: string;
  width?: number;
  height?: number;
  /** 输出上限（字节），默认 64KB（微信 thumb 限制） */
  maxBytes?: number;
  /**
   * 智谱底图右下角强制水印「AI生成」的处理方式：
   * - `crop`（默认）：从底部裁掉 `watermarkCropPx` 像素，水印彻底消失（实测水印距下边仅 8px）
   * - `footer`：保留整图，底部压一条不透光的页脚带遮住水印（可顺带放品牌文字）
   * - `none`：不处理（水印保留，仅作对比用）
   */
  watermark?: WatermarkPolicy;
  /** `crop` 模式下从底部裁掉的像素数，默认 64 */
  watermarkCropPx?: number;
  /** `footer` 模式下页脚带里显示的文字，默认用 subtitle */
  footerText?: string;
}

export type WatermarkPolicy = "crop" | "footer" | "none";

export const DEFAULT_WATERMARK_POLICY: WatermarkPolicy = "crop";
/** 实测水印包围盒底边距画布下边 8px，留足余量取 64 */
export const DEFAULT_WATERMARK_CROP_PX = 64;

/** 边距（footer 等需要在主流程外算位置的地方复用） */
const marginFor = (width: number): number => Math.round(width * 0.055);

/** 字体字节缓存：同一进程内只读一次磁盘 */
const fontCache = new Map<string, Uint8Array>();

const loadFontBytes = async (path: string): Promise<Uint8Array> => {
  const hit = fontCache.get(path);
  if (hit) {
    return hit;
  }
  const bytes = await Deno.readFile(path);
  fontCache.set(path, bytes);
  return bytes;
};

/**
 * 智能截断：优先在标点或空格处断开，避免把单词/词组切成半截。
 * 结尾统一不加省略号（封面排版里视觉上更干净）。
 */
const truncateAtBoundary = (text: string, maxLength: number): string => {
  const s = (text || "").trim();
  if (s.length <= maxLength) {
    return s;
  }
  const cut = s.slice(0, maxLength);
  const breakChars = ["：", ":", "，", ",", "、", " ", "·", "｜", "|"];
  let best = -1;
  for (const ch of breakChars) {
    const idx = cut.lastIndexOf(ch);
    if (idx > best) {
      best = idx;
    }
  }
  // 断点太靠前就不切（否则会丢掉大半内容），否则在断点处收尾
  if (best >= Math.floor(maxLength * 0.5)) {
    return cut.slice(0, best).trim();
  }
  return cut.trim();
};

/**
 * 把草稿标题拆成三层，供封面分级排版。
 *
 * 草稿标题形如：`2026/9/17 AI速递 | AI 三连炸：GPT-6 Astra 赋能 Devin，…`
 * 拆解：
 *   subtitle = `2026/9/17 AI速递`（竖线前的日期+栏目）
 *   title    = `AI 三连炸`（竖线后、冒号前的短句 → 主标题）
 *   subline  = `GPT-6 Astra 赋能 Devin`（冒号后的具体内容 → 次标题）
 */
export const splitCoverTitle = (
  rawTitle: string,
  limits: { title?: number; subline?: number } = {},
): CoverTitleParts => {
  const raw = (rawTitle || "").trim();
  const maxTitle = limits.title ?? 18;
  const maxSubline = limits.subline ?? 30;

  // 1) 竖线前后 = 内容标题 / 日期栏目
  const parts = raw.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
  let head = raw;
  let tail = "";
  if (parts.length >= 2) {
    head = parts[0];
    tail = parts.slice(1).join(" | ");
  }
  let subtitle = tail ? head : new Date().toLocaleDateString();

  // 2) 内容标题内部再按冒号拆主/次
  let content = tail || head;
  let title = content;
  let subline = "";
  for (const colon of ["：", ":"]) {
    const idx = content.indexOf(colon);
    if (idx > 0 && idx <= maxTitle + 6) {
      title = content.slice(0, idx).trim();
      subline = content.slice(idx + 1).trim();
      break;
    }
  }
  if (!subtitle) {
    subtitle = new Date().toLocaleDateString();
  }

  title = truncateAtBoundary(title, maxTitle);
  subline = truncateAtBoundary(subline, maxSubline);

  return {
    title: title || truncateAtBoundary(raw, maxTitle),
    subline,
    subtitle,
  };
};

/** 量一次指定文本在给定字号下的渲染宽度（不换行） */
const measureWidth = (
  fontBytes: Uint8Array,
  text: string,
  size: number,
): number => {
  if (!text) {
    return 0;
  }
  const img = Image.renderText(
    fontBytes,
    size,
    text,
    0xffffffff,
    new TextLayout({ maxWidth: 100000 }),
  );
  return img.width;
};

/** 按"宽度 ÷ 字号"的线性关系估出能放进 maxWidth 的字号 */
const fitSize = (
  fontBytes: Uint8Array,
  text: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
): number => {
  if (!text) {
    return startSize;
  }
  const probeSize = 100;
  const w = measureWidth(fontBytes, text, probeSize);
  if (w <= 0) {
    return startSize;
  }
  const scaled = Math.floor((probeSize * maxWidth) / w) - 2;
  return Math.max(minSize, Math.min(startSize, scaled));
};

/** 逐档降质量，必要时再缩尺寸，直到塞进 maxBytes */
const encodeUnderLimit = async (
  canvas: Image,
  maxBytes: number,
): Promise<Uint8Array> => {
  const qualities = [92, 86, 80, 72, 64, 56, 48, 40, 32, 26, 20];
  let best: Uint8Array | null = null;

  for (const q of qualities) {
    const buf = await canvas.encodeJPEG(q);
    best = buf;
    if (buf.length <= maxBytes) {
      return buf;
    }
  }

  // 质量压到底还是超：按比例缩尺寸再编
  let scale = 0.9;
  while (scale >= 0.4) {
    const w = Math.floor(canvas.width * scale);
    const h = Math.floor(canvas.height * scale);
    const shrunk = canvas.clone().resize(w, h);
    for (const q of [80, 65, 50, 35]) {
      const buf = await shrunk.encodeJPEG(q);
      best = buf;
      if (buf.length <= maxBytes) {
        return buf;
      }
    }
    scale -= 0.1;
  }

  // 极端兜底：返回体积最小的那次结果，由调用方决定是否接受
  return best as Uint8Array;
};

/**
 * 合成封面：背景 + 本地渲染的三层中文标题 → 压缩到 ≤ maxBytes 的 JPEG。
 *
 * @returns JPEG 字节（微信 thumb 可直接上传）
 */
export const composeCover = async (
  options: ComposeCoverOptions,
): Promise<Uint8Array> => {
  const {
    title,
    subline,
    subtitle,
    background,
    fontPath = DEFAULT_COVER_FONT,
    width = DEFAULT_COVER_WIDTH,
    height = DEFAULT_COVER_HEIGHT,
    maxBytes = WECHAT_THUMB_MAX_BYTES,
    watermark = DEFAULT_WATERMARK_POLICY,
    watermarkCropPx = DEFAULT_WATERMARK_CROP_PX,
    footerText,
  } = options;

  if (!title || !title.trim()) {
    throw new Error("composeCover: title 不能为空");
  }

  const fontBytes = await loadFontBytes(fontPath);
  const canvas = new Image(width, height);

  // ---- 1) 铺背景 ----
  const hasAiBackground = Boolean(background && background.length > 0);
  if (hasAiBackground) {
    const bg = await decode(background!) as Image;
    // 去掉智谱右下角强制水印「AI生成」：从底部裁掉一条
    if (watermark === "crop" && watermarkCropPx > 0) {
      const keepHeight = Math.max(16, bg.height - watermarkCropPx);
      bg.crop(0, 0, bg.width, keepHeight);
    }
    bg.cover(width, height);
    canvas.composite(bg, 0, 0);
  } else {
    // 没有 AI 底图时用本地渐变 PNG（无外部依赖、无水印）
    const png = await buildPlaceholderCoverPng({ width, height });
    const bg = await decode(png) as Image;
    canvas.composite(bg, 0, 0);
  }

  // ---- 1b) footer 模式：底部页脚带（不透光，盖住水印）----
  // 只有真的存在 AI 底图时才需要盖水印
  if (watermark === "footer" && hasAiBackground) {
    const barH = Math.round(height * 0.13);
    const barY = height - barH;
    canvas.drawBox(0, barY, width, barH, 0x080a10ff);
    canvas.drawBox(
      0,
      barY,
      width,
      Math.max(2, Math.round(height * 0.0045)),
      0x00c2ffff,
    );
    const footText = (footerText ?? subtitle ?? "").trim();
    if (footText) {
      const footSize = Math.max(22, Math.round(height * 0.042));
      const footImg = Image.renderText(
        fontBytes,
        footSize,
        footText,
        0x9fb3c8ff,
        new TextLayout({ maxWidth: width - marginFor(width) * 2 }),
      );
      canvas.composite(
        footImg,
        marginFor(width),
        barY + Math.round((barH - footImg.height) / 2),
      );
    }
  }

  // ---- 2) 定字号（按可用宽度自动缩放，保证不溢出）----
  const margin = marginFor(width);
  const textMaxWidth = width - margin * 2;
  // 主标题只占 70% 宽度，给暗底板和留白留出呼吸感
  const titleMaxWidth = Math.round(textMaxWidth * 0.78);

  const titleSize = fitSize(fontBytes, title, titleMaxWidth, 112, 54);
  const sublineSize = subline
    ? Math.max(28, Math.round(titleSize * 0.44))
    : 0;
  const subtitleSize = Math.max(24, Math.round(titleSize * 0.30));

  // ---- 3) 渲染各层 ----
  const titleImage = Image.renderText(
    fontBytes,
    titleSize,
    title,
    0xffffffff,
    new TextLayout({ maxWidth: titleMaxWidth, wrapStyle: "char" }),
  );
  const sublineImage = subline
    ? Image.renderText(
      fontBytes,
      sublineSize,
      subline,
      0xf2f6ffff,
      new TextLayout({ maxWidth: textMaxWidth, wrapStyle: "char" }),
    )
    : null;
  const subtitleImage = Image.renderText(
    fontBytes,
    subtitleSize,
    subtitle,
    0x7fd4ffff,
    new TextLayout({ maxWidth: textMaxWidth, wrapStyle: "char" }),
  );

  // ---- 4) 垂直排列 ----
  const gapTitleSub = sublineImage ? Math.round(titleSize * 0.20) : 0;
  const gapSubFoot = Math.round(titleSize * 0.26);
  const blockHeight = titleImage.height +
    (sublineImage ? gapTitleSub + sublineImage.height : 0) +
    gapSubFoot + subtitleImage.height;
  const blockTop = Math.max(
    Math.round(height * 0.16),
    Math.floor((height - blockHeight) / 2) - Math.round(height * 0.03),
  );

  const widestText = Math.max(
    titleImage.width,
    sublineImage?.width ?? 0,
    subtitleImage.width,
  );

  // ---- 5) 暗底板：自适应内容宽度，并向画布内收边 ----
  const padX = Math.round(titleSize * 0.34);
  const padY = Math.round(titleSize * 0.26);
  let panelX = margin - padX;
  let panelW = widestText + padX * 2;
  if (panelX < 0) {
    panelW += panelX;
    panelX = 0;
  }
  if (panelX + panelW > width) {
    panelW = width - panelX;
  }
  let panelY = blockTop - padY;
  let panelH = blockHeight + padY * 2;
  if (panelY < 0) {
    panelH += panelY;
    panelY = 0;
  }
  if (panelY + panelH > height) {
    panelH = height - panelY;
  }
  canvas.drawBox(panelX, panelY, panelW, panelH, 0x000000a6);

  // 底板左侧竖条装饰（青→蓝渐变的替代：两段纯色）
  canvas.drawBox(panelX, panelY, Math.max(3, Math.round(width * 0.0035)), panelH, 0x00c2ffff);
  canvas.drawBox(
    panelX,
    panelY,
    Math.max(3, Math.round(width * 0.0035)),
    Math.round(panelH * 0.45),
    0x6ee7b7ff,
  );

  // ---- 6) 叠字 ----
  let cursorY = blockTop;
  canvas.composite(titleImage, margin, cursorY);
  cursorY += titleImage.height;
  if (sublineImage) {
    cursorY += gapTitleSub;
    canvas.composite(sublineImage, margin, cursorY);
    cursorY += sublineImage.height;
  }
  cursorY += gapSubFoot;
  canvas.composite(subtitleImage, margin, cursorY);

  // ---- 7) 压到 64KB 以内的 JPEG ----
  return await encodeUnderLimit(canvas, maxBytes);
};
