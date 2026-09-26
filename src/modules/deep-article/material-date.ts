import { ScrapedContent } from "../interfaces/scraper.interface.ts";

/**
 * 素材时效窗口（纯函数）。
 *
 * 为什么需要它：所有 scraper 的 publishDate 都统一走 `utils/common.ts` 的 formatDate，
 * 格式是 `YYYY/MM/DD HH:mm:ss`；但**没有任何一处按日期筛过**。
 * 实测：@OpenAIDevs 的 syndication 时间线一次性返回 20 条推文，日期跨 2023-12 → 2026-09，
 * 于是"当天素材"里混着三年前的公告，深度文会拿一年前的推文当新闻写。
 *
 * 这里只做过滤，不做采样：不做"最新的 N 条"截断，截断是调用方按 maxMaterials 做的。
 */

export const DEFAULT_MAX_AGE_DAYS = 180;

/**
 * 解析各 scraper 写出的 publishDate。
 *
 * 主格式是 `YYYY/MM/DD HH:mm:ss`（本地时间，与 formatDate 一致），
 * 其余退回 `new Date()`。解析不出来返回 null——调用方不要猜，猜错会把新素材当旧的丢掉。
 */
export const parsePublishDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const text = String(value ?? "").trim();
  if (!text) return null;

  // 带时区的时间戳（...Z / +08:00）交给 Date 处理：
  // 硬拆成本地时间会把 UTC 戳整体平移一个时区，日期也就跟着错了。
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);

  if (!hasTimezone) {
    const match = text.match(
      /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
    );
    if (match) {
      const [year, month, day, hour, minute, second, millisecond] = [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4] ?? 0),
        Number(match[5] ?? 0),
        Number(match[6] ?? 0),
        Number((match[7] ?? "0").padEnd(3, "0")),
      ];
      const date = new Date(
        year,
        month - 1,
        day,
        hour,
        minute,
        second,
        millisecond,
      );
      // 组件回查：`new Date(2026, 12, 45)` 不会报错，它会进位成 2027-02-14。
      // 不回查就会把一条拼错的日期当成合法日期，进而算出一个假的天数。
      const roundTrips = date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day &&
        date.getHours() === hour &&
        date.getMinutes() === minute &&
        date.getSeconds() === second &&
        date.getMilliseconds() === millisecond;
      return roundTrips ? date : null;
    }
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export interface ExpiredMaterial {
  content: ScrapedContent;
  /** 解析出来的发布时间；无法解析时为 null */
  date: Date | null;
  /** 距今天数；无法解析时为 null */
  ageDays: number | null;
}

export interface AgeWindowResult {
  kept: ScrapedContent[];
  /** 超出窗口被筛掉的 */
  expired: ExpiredMaterial[];
  /** 日期缺失或无法解析——一律保留，但要能被看见 */
  undated: ScrapedContent[];
  maxAgeDays: number;
}

export interface AgeWindowOptions {
  maxAgeDays?: number;
  /** 注入"现在"，测试用 */
  now?: Date;
}

export const filterByAgeWindow = (
  contents: ScrapedContent[],
  options: AgeWindowOptions = {},
): AgeWindowResult => {
  const maxAgeDays = options.maxAgeDays && options.maxAgeDays > 0
    ? options.maxAgeDays
    : DEFAULT_MAX_AGE_DAYS;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  const kept: ScrapedContent[] = [];
  const expired: ExpiredMaterial[] = [];
  const undated: ScrapedContent[] = [];

  for (const content of contents) {
    const date = parsePublishDate(content.publishDate);
    if (!date) {
      // 日期缺失不能当成"过期"：那是把未知当已知。
      // 保留但记入 undated，让审计里能看出有多少条是没日期的。
      undated.push(content);
      kept.push(content);
      continue;
    }
    const ageDays = (nowMs - date.getTime()) / 86_400_000;
    if (ageDays > maxAgeDays) {
      // 用 ceil 表示「已跨过第 N 天」：180 天 1 小时应显示 181，
      // 否则审计里会出现“180 天前却被 180 天窗口淘汰”的假矛盾。
      expired.push({ content, date, ageDays: Math.ceil(ageDays) });
      continue;
    }
    kept.push(content);
  }

  return { kept, expired, undated, maxAgeDays };
};
