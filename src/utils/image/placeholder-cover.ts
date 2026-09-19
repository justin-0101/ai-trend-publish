/**
 * 本地占位封面：纯 JS 生成 PNG，不依赖任何图像库、字体或外部服务。
 *
 * 已知限制：无法渲染文字（纯 JS 没有中文字体栅格化能力），
 * 所以占位封面是渐变色 + 装饰条的纯图，用于"封面生成失败时不要让整条流程挂掉"。
 * 需要带文字的封面请配置 COVER_FALLBACK_MODE=fail 并修好图片生成渠道。
 */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const hexToRgb = (hex: string): [number, number, number] => {
  const value = hex.replace("#", "");
  const full = value.length === 3
    ? value.split("").map((c) => c + c).join("")
    : value;
  return [
    Number.parseInt(full.slice(0, 2), 16) || 0,
    Number.parseInt(full.slice(2, 4), 16) || 0,
    Number.parseInt(full.slice(4, 6), 16) || 0,
  ];
};

export interface PlaceholderCoverOptions {
  width?: number;
  height?: number;
  /** 起始色（左侧） */
  from?: string;
  /** 结束色（右侧） */
  to?: string;
}

/**
 * 生成一张渐变底 + 两条装饰带的 PNG。
 * 返回的是完整 PNG 字节，可直接上传到图片接口。
 */
export const buildPlaceholderCoverPng = async (
  options: PlaceholderCoverOptions = {},
): Promise<Uint8Array> => {
  const width = Math.max(16, Math.floor(options.width ?? 1200));
  const height = Math.max(16, Math.floor(options.height ?? 630));
  const [r1, g1, b1] = hexToRgb(options.from ?? "#12305c");
  const [r2, g2, b2] = hexToRgb(options.to ?? "#1a73e8");

  const stride = width * 3 + 1; // 每行前 1 字节是 filter type(0)
  const raw = new Uint8Array(stride * height);
  const bandTop = Math.floor(height * 0.72);
  const bandBottom = Math.floor(height * 0.80);

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: none
    // 斜向渐变系数：让左右和上下都有变化，避免死板的纯色
    for (let x = 0; x < width; x++) {
      const t = Math.min(1, Math.max(0, (x / (width - 1)) * 0.8 + (y / (height - 1)) * 0.2));
      let r = Math.round(r1 + (r2 - r1) * t);
      let g = Math.round(g1 + (g2 - g1) * t);
      let b = Math.round(b1 + (b2 - b1) * t);
      if (y >= bandTop && y <= bandBottom) {
        // 底部装饰带：提亮一档
        r = Math.min(255, r + 40);
        g = Math.min(255, g + 40);
        b = Math.min(255, b + 40);
      }
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = await deflate(raw);
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
};
