import { ScrapedContent } from "../interfaces/scraper.interface.ts";

/**
 * X（Twitter）短推文过滤。
 *
 * 为什么必须单独做这一层：x-search 是按关键词召回一整片时间线的，返回结果里
 * 混着大量一句半句的回复、转发、感叹和跨语言噪音。真跑实测（关键词 GEO，41 条）：
 * 最短 20 字，中位数 138 字，其中「姚老师这个估计卷掉了很多商业化geo系统」
 * 只有 20 字，却因为被聚进主题包，成了正文里一条「行业信号」。
 *
 * 几十个字的推文没有可核验信息：它既给不出事实与数字，也撑不起机制判断，
 * 进主题包只会让「素材充分度」看起来比实际高。宁可少送几条，也不要送噪音。
 *
 * 只作用于 X 系来源。firecrawl 抓的是文章页，本来就长，用推文的长度门槛去
 * 卡它没有意义，也会误伤短公告页。
 */

/** X 系采集器写的 platform 值 */
const X_PLATFORMS = [
  "x-search",
  "twitter",
  "twitter-cookie",
  "twitter-frontend",
];

/** platform 缺失时的兜底判断 */
const X_HOSTS = ["x.com", "twitter.com", "mobile.twitter.com"];

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** 这条素材是否来自 X。先看采集器写的 platform，再看 URL 域名。 */
export const isXMaterial = (content: ScrapedContent): boolean => {
  const platform = String(content.metadata?.platform ?? "").trim()
    .toLowerCase();
  if (X_PLATFORMS.includes(platform)) return true;
  const host = hostOf(String(content.url ?? ""));
  return X_HOSTS.some((denied) =>
    host === denied || host.endsWith(`.${denied}`)
  );
};

/**
 * 推文长度按正文原始字符数算（去掉首尾空白，不去 URL、不去空白）。
 *
 * 为什么不剔 URL：真跑里 @yaojingang 那条 2026-06-27 的直播资料帖，
 * 原文 205 字、剔掉三个 doc.laoyao.cn 链接后只剩 66 字，但它是三份文档的
 * 唯一入口，正是补料要用的素材。按「有多少字」判它是短帖会误杀。
 */
export const tweetTextLength = (content: ScrapedContent): number =>
  String(content.content ?? "").trim().length;

/** 默认门槛：低于此长度的 X 推文不进主题包。 */
export const DEFAULT_MIN_TWEET_CHARS = 120;

/** X 搜索采集器识别出的 Article。这里只判断元数据，不把卡片摘要冒充成全文。 */
export const isXArticleMaterial = (content: ScrapedContent): boolean =>
  isXMaterial(content) && content.metadata?.xArticle === true;

/**
 * 把 X Article 排到普通推文前面，保持各组内部原有顺序。
 * 采集器的 maxPosts 与深度文的 maxMaterials 都可能产生截断，
 * 所以优先级必须在两处截断前都生效。
 */
export const prioritizeXArticles = (
  contents: ScrapedContent[],
): ScrapedContent[] =>
  contents
    .map((content, index) => ({
      content,
      index,
      article: isXArticleMaterial(content),
    }))
    .sort((a, b) => Number(b.article) - Number(a.article) || a.index - b.index)
    .map(({ content }) => content);

export interface ShortXMaterial {
  content: ScrapedContent;
  /** 实际字数，落档审计用 */
  chars: number;
}

/**
 * 过滤过短的 X 推文。非 X 来源一律保留。
 * 纯函数：不需要网络、不需要配置，可直接单测。
 */
export const filterShortXMaterials = (
  contents: ScrapedContent[],
  options: { minChars?: number } = {},
): { kept: ScrapedContent[]; dropped: ShortXMaterial[] } => {
  const minChars = options.minChars && options.minChars > 0
    ? Math.floor(options.minChars)
    : DEFAULT_MIN_TWEET_CHARS;
  const kept: ScrapedContent[] = [];
  const dropped: ShortXMaterial[] = [];

  for (const content of contents) {
    if (!isXMaterial(content)) {
      kept.push(content);
      continue;
    }
    const chars = tweetTextLength(content);
    if (chars >= minChars) kept.push(content);
    else dropped.push({ content, chars });
  }

  return { kept, dropped };
};
