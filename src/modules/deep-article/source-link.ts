/**
 * 补料候选链接的识别与提取（纯函数）。
 *
 * 用途有两个：
 *   1. 主题包入选门槛：素材只有一条时，判断它是否至少有一个可抓取入口——
 *      这只代表“有机会补厚”，不代表页面已经被验证为一手来源；
 *   2. 素材补料（skill 第 5 步）：从素材正文里把候选链接抠出来去抓。
 *
 * 为什么要排除社交平台：x.com / t.co 的状态页抓不到正文（要登录、要 JS），
 * 抓它等于白花一次请求。宁可判成“没有补料入口”，也不要给出抓不到的候选。
 */

/** 抓不到正文、或本身不是一手来源的站点 */
const UNFETCHABLE_HOSTS = [
  "x.com",
  "twitter.com",
  "t.co",
  "mobile.twitter.com",
  "weibo.com",
  "weibo.cn",
  "douyin.com",
  "xiaohongshu.com",
  "zhihu.com",
  "t.me",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "youtube.com",
  "youtu.be",
  "bilibili.com",
];

/** 明显的图片/视频/静态资源后缀：抓回来也不是正文 */
const ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".mp4",
  ".mov",
  ".mp3",
  ".zip",
  ".pdf.js",
];

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

const isHostDenied = (host: string): boolean =>
  UNFETCHABLE_HOSTS.some((denied) =>
    host === denied || host.endsWith(`.${denied}`)
  );

const looksLikeAsset = (url: string): boolean => {
  const path = url.split("?")[0].toLowerCase();
  return ASSET_EXTENSIONS.some((ext) => path.endsWith(ext));
};

/**
 * 这个链接是否值得作为补料候选：http(s)、不是社交平台、不是静态资源。
 * 不判断它是不是一手来源、也不判断内容质量——那要在抓回正文后由 material-gap 判断。
 */
export const isFetchableCandidateLink = (url: unknown): boolean => {
  const text = String(url ?? "").trim();
  if (!text) return false;
  if (!/^https?:\/\//i.test(text)) return false;
  if (looksLikeAsset(text)) return false;
  const host = hostOf(text);
  if (!host) return false;
  return !isHostDenied(host);
};

/**
 * X 的 DOM innerText 会按显示宽度把 URL 拆成多行，例如：
 * `https://\ngithub.com/GEO-SEO/geo-co\nntent-writer\n…`。
 * 只拼接由纯 URL 字符构成的续行；遇到中文、空行、列表标题等立即停止，
 * 避免把 URL 后面的正文误吞进地址。
 */
const unwrapLineWrappedUrls = (source: string): string => {
  let normalized = source.replace(
    /(https?:\/\/)[ \t]*\r?\n[ \t]*/gi,
    "$1",
  );
  for (let index = 0; index < 8; index++) {
    const joined = normalized.replace(
      /(https?:\/\/[^\s<>"'）)】\]…]+)\r?\n([A-Za-z0-9][A-Za-z0-9._~:/?#@!$&()*+,;=%-]*)(?=\r?\n|$)/gi,
      "$1$2",
    );
    if (joined === normalized) break;
    normalized = joined;
  }
  return normalized;
};

/** 从一段文本里抠出候选链接，按出现顺序去重。 */
export const extractLinks = (text: unknown): string[] => {
  const source = unwrapLineWrappedUrls(String(text ?? ""));
  if (!source) return [];
  const matches = source.match(/https?:\/\/[^\s<>"'）)】\]]+/gi) ?? [];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const raw of matches) {
    // 去掉尾部的中英文标点：推文里常写成 "…/docs." 或 "…/docs，"
    const cleaned = raw.replace(/[.,;:!?，。；：！？、]+$/, "");
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    links.push(cleaned);
  }
  return links;
};

/**
 * 一组素材里是否存在可抓取的补料入口。
 * 只用于前置门槛；不得据此宣称页面已是一手来源或材料已充足。
 */
export const hasFetchableCandidateLink = (urls: Array<unknown>): boolean =>
  urls.some((url) => isFetchableCandidateLink(url));

/**
 * 从素材里挑出「值得抓去补料」的链接：可抓取、且不在已抓过的集合里。
 * 返回去重后的候选，顺序即发现顺序。
 */
export const pickSupplementLinks = (
  materials: Array<{ url?: string; content?: string }>,
  options: { limit?: number; exclude?: Iterable<string> } = {},
): string[] => {
  const limit = options.limit && options.limit > 0 ? options.limit : 3;
  const excluded = new Set(options.exclude ?? []);
  const picked: string[] = [];

  for (const material of materials) {
    // 素材自身的 url（例如官方公告页）优先，然后才是正文里提到的链接
    const candidates = [
      material.url ?? "",
      ...extractLinks(material.content),
    ];
    for (const candidate of candidates) {
      if (picked.length >= limit) return picked;
      if (excluded.has(candidate)) continue;
      if (!isFetchableCandidateLink(candidate)) continue;
      if (picked.includes(candidate)) continue;
      picked.push(candidate);
    }
  }

  return picked;
};
