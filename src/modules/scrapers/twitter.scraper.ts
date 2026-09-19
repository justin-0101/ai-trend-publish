import {
  ContentScraper,
  Media,
  ScrapedContent,
  ScraperOptions,
} from "../interfaces/scraper.interface.ts";
import { ConfigManager } from "../../utils/config/config-manager.ts";
import { formatDate } from "../../utils/common.ts";

const logger = {
  info: (msg: string) => console.log(msg),
  error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
  warn: (msg: string) => console.warn(msg),
  debug: (msg: string, ...args: unknown[]) => console.debug(msg, ...args)
};

export class TwitterScraper implements ContentScraper {
  private xApiKey: string | undefined;

  constructor() {
  }

  async refresh(): Promise<void> {
    const startTime = Date.now();
    this.xApiKey = await ConfigManager.getInstance().get(
      "X_API_KEY",
    );
    logger.debug(
      `TwitterScraper 初始化完成, 耗时: ${Date.now() - startTime}ms`,
    );
  }

  async scrape(
    sourceId: string,
    _options?: ScraperOptions,
  ): Promise<ScrapedContent[]> {
    await this.refresh();
    const usernameMatch = sourceId.match(/x\.com\/([^\/]+)/);
    if (!usernameMatch) {
      throw new Error("Invalid Twitter source ID format");
    }

    const username = usernameMatch[1];
    logger.debug(`Processing Twitter user: ${username}`);

    try {
      const query = `from:${username} -filter:replies within_time:24h`;
      const apiUrl =
        `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}`;

      const response = await fetch(apiUrl, {
        headers: {
          "X-API-Key": `${this.xApiKey}`,
        },
      });

      if (!response.ok) {
        const errorMsg = `Failed to fetch tweets: ${response.statusText}`;
        throw new Error(errorMsg);
      }

      const tweets = await response.json();
      const scrapedContent: ScrapedContent[] = tweets.tweets
        .slice(0, 20)
        .map((tweet: any) => {
          const quotedContent = this.getQuotedContent(tweet.quoted_tweet);
          let media = this.getMediaList(tweet.extendedEntities);
          // 合并tweet和quotedContent 如果quotedContent存在，则将quotedContent的内容添加到tweet的内容中
          const content = quotedContent
            ? `${tweet.text}\n\n 【QuotedContent:${quotedContent.content}】`
            : tweet.text;
          // 合并media和quotedContent的media
          if (quotedContent?.media) {
            media = [...media, ...quotedContent.media];
          }
          return {
            id: tweet.id,
            title: tweet.text.split("\n")[0],
            content: content,
            url: tweet.url,
            publishDate: formatDate(tweet.createdAt),
            media: media,
            metadata: {
              platform: "twitter",
              username,
            },
          } as ScrapedContent;
        });

      if (scrapedContent.length > 0) {
        logger.debug(
          `Successfully fetched ${scrapedContent.length} tweets from ${username}`,
        );
      } else {
        logger.debug(`No tweets found for ${username}`);
      }

      logger.debug("scrapedContent", JSON.stringify(scrapedContent, null, 2));

      return scrapedContent;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching tweets for ${username}:`, errorMsg);
      throw error;
    }
  }

  private getMediaList(extendedEntities: any): Media[] {
    const mediaList: Media[] = [];
    if (extendedEntities && extendedEntities.media) {
      extendedEntities.media.forEach((media: any) => {
        mediaList.push({
          url: media.media_url_https,
          type: media.type,
          size: {
            width: media.sizes.large.w,
            height: media.sizes.large.h,
          },
        });
      });
    }
    return mediaList;
  }

  private getQuotedContent(quoted_tweet: any): ScrapedContent | null {
    if (quoted_tweet) {
      return {
        id: quoted_tweet.id,
        title: quoted_tweet.text.split("\n")[0],
        content: quoted_tweet.text,
        url: quoted_tweet.url,
        publishDate: formatDate(quoted_tweet.createdAt),
        media: this.getMediaList(quoted_tweet.extendedEntities),
        metadata: {
          platform: "twitter",
        },
      };
    }
    return null;
  }
}

export class TwitterCookieScraper implements ContentScraper {
  private cookie: string | null = null;
  private csrfToken: string | null = null;
  private bearerToken: string | null = null;
  private userByNameQueryId: string | null = null;
  private userTweetsQueryId: string | null = null;

  async refresh(): Promise<void> {
    const startTime = Date.now();
    const config = ConfigManager.getInstance();
    this.cookie = await config.get("TWITTER_COOKIE");
    this.csrfToken = await config.get("TWITTER_CSRF_TOKEN");
    this.bearerToken = await config.get("TWITTER_WEB_BEARER_TOKEN");
    this.userByNameQueryId = await config.get("TWITTER_USER_BY_NAME_QUERY_ID");
    this.userTweetsQueryId = await config.get("TWITTER_USER_TWEETS_QUERY_ID");
    if (!this.cookie) {
      throw new Error("TWITTER_COOKIE 未配置");
    }
    if (!this.csrfToken) {
      this.csrfToken = this.getCookieValue(this.cookie, "ct0");
    }
    if (!this.csrfToken) {
      throw new Error("TWITTER_CSRF_TOKEN 未配置");
    }
    if (!this.bearerToken) {
      this.bearerToken =
        "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAvmKxP0R31hKpX0XwF5qf3sA8%3D";
    }
    if (!this.userByNameQueryId) {
      this.userByNameQueryId = "G3KGOASz96M-Qu0Gdrx4Sg";
    }
    if (!this.userTweetsQueryId) {
      this.userTweetsQueryId = "nKXymQf8mZ8c2C6NVs5tNA";
    }
    logger.debug(
      `TwitterCookieScraper 初始化完成, 耗时: ${Date.now() - startTime}ms`,
    );
  }

  async scrape(
    sourceId: string,
    options?: ScraperOptions,
  ): Promise<ScrapedContent[]> {
    await this.refresh();
    const usernameMatch = sourceId.match(/x\.com\/([^\/]+)/);
    if (!usernameMatch) {
      throw new Error("Invalid Twitter source ID format");
    }
    const username = usernameMatch[1];
    const userId = await this.fetchUserId(username);
    const tweets = await this.fetchUserTweets(userId, options?.limit || 20);
    return tweets.map((tweet) => {
      const text = tweet.legacy.full_text || tweet.legacy.text || "";
      return {
        id: tweet.id,
        title: text.split("\n")[0],
        content: text,
        url: `https://x.com/${username}/status/${tweet.id}`,
        publishDate: formatDate(tweet.legacy.created_at),
        media: this.extractMedia(tweet.legacy),
        metadata: {
          platform: "twitter-cookie",
          username,
        },
      };
    });
  }

  private async fetchUserId(username: string): Promise<string> {
    const variables = {
      screen_name: username,
      withSafetyModeUserFields: true,
    };
    const features = {
      hidden_profile_likes_enabled: true,
      hidden_profile_subscriptions_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      subscriptions_verification_info_is_identity_verified_enabled: true,
      subscriptions_verification_info_verified_since_enabled: true,
      highlights_tweets_tab_ui_enabled: true,
      responsive_web_twitter_article_notes_tab_enabled: false,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
    };
    const url = this.buildGraphqlUrl(
      this.userByNameQueryId || "",
      "UserByScreenName",
      variables,
      features,
    );
    const data = await this.fetchJson(url);
    const user = data?.data?.user?.result;
    const restId = user?.rest_id;
    if (!restId) {
      throw new Error("未获取到 Twitter 用户ID");
    }
    return restId;
  }

  private async fetchUserTweets(userId: string, count: number) {
    const variables = {
      userId,
      count,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: false,
      withVoice: true,
      withV2Timeline: true,
    };
    const features = {
      rweb_lists_timeline_redesign_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      tweetypie_unmention_optimization_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      longform_notetweets_rich_text_read_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    };
    const url = this.buildGraphqlUrl(
      this.userTweetsQueryId || "",
      "UserTweets",
      variables,
      features,
    );
    const data = await this.fetchJson(url);
    return this.extractTweets(data);
  }

  private buildGraphqlUrl(
    queryId: string,
    name: string,
    variables: Record<string, unknown>,
    features: Record<string, unknown>,
  ) {
    const vars = encodeURIComponent(JSON.stringify(variables));
    const feats = encodeURIComponent(JSON.stringify(features));
    return `https://twitter.com/i/api/graphql/${queryId}/${name}?variables=${vars}&features=${feats}`;
  }

  private async fetchJson(url: string): Promise<any> {
    const response = await fetch(url, {
      headers: {
        "authorization": `Bearer ${this.bearerToken}`,
        "x-csrf-token": this.csrfToken || "",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "zh-cn",
        "cookie": this.cookie || "",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Twitter Cookie 请求失败: ${response.status} ${text}`);
    }
    return response.json();
  }

  private extractTweets(data: any) {
    const results: Array<{ id: string; legacy: any }> = [];
    const seen = new Set<string>();
    const stack: any[] = [data];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      const tweet = node?.tweet_results?.result;
      if (tweet?.legacy) {
        const id = tweet.rest_id || tweet.legacy.id_str;
        if (id && !seen.has(id)) {
          seen.add(id);
          results.push({ id, legacy: tweet.legacy });
        }
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
          stack.push(value);
        }
      }
    }
    return results;
  }

  private extractMedia(legacy: any): Media[] {
    const mediaList: Media[] = [];
    const medias = legacy?.extended_entities?.media || [];
    medias.forEach((media: any) => {
      if (!media?.media_url_https) return;
      const size = media.sizes?.large || media.sizes?.medium || media.sizes?.small;
      mediaList.push({
        url: media.media_url_https,
        type: media.type,
        size: {
          width: size?.w || 0,
          height: size?.h || 0,
        },
      });
    });
    return mediaList;
  }

  private getCookieValue(cookie: string, key: string) {
    const parts = cookie.split(";").map((part) => part.trim());
    for (const part of parts) {
      const [k, ...rest] = part.split("=");
      if (k === key) {
        return rest.join("=");
      }
    }
    return null;
  }
}

export class TwitterFrontendScraper implements ContentScraper {
  async scrape(
    sourceId: string,
    options?: ScraperOptions,
  ): Promise<ScrapedContent[]> {
    const usernameMatch = sourceId.match(/x\.com\/([^\/]+)/);
    if (!usernameMatch) {
      throw new Error("Invalid Twitter source ID format");
    }
    const username = usernameMatch[1];
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${username}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch frontend timeline: ${response.statusText}`);
    }
    const html = await response.text();
    if (!html) {
      throw new Error("Empty frontend timeline response");
    }
    const jsonText = this.extractNextDataJson(html);
    if (!jsonText) {
      throw new Error("Frontend timeline JSON not found");
    }
    const data = JSON.parse(jsonText);
    const entries = data?.props?.pageProps?.timeline?.entries ?? [];
    const limit = options?.limit ?? 20;
    const results: ScrapedContent[] = [];
    for (const entry of entries) {
      const tweet = entry?.content?.tweet;
      if (!tweet) continue;
      const text = tweet.full_text || tweet.text || "";
      const id = tweet.id || tweet.id_str;
      if (!id || !text) continue;
      results.push({
        id: String(id),
        title: text.split("\n")[0],
        content: text,
        url: `https://x.com/${username}/status/${id}`,
        publishDate: tweet.created_at
          ? formatDate(tweet.created_at)
          : formatDate(new Date().toISOString()),
        media: this.extractMedia(tweet),
        metadata: {
          platform: "twitter-frontend",
          username,
        },
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  private extractMedia(tweet: any): Media[] {
    const mediaDetails = Array.isArray(tweet?.mediaDetails)
      ? tweet.mediaDetails
      : Array.isArray(tweet?.media)
      ? tweet.media
      : [];
    return mediaDetails.map((media: any) => ({
      url: media.media_url_https || media.media_url || media.url,
      type: media.type || "photo",
      size: {
        width: typeof media?.original_info?.width === "number"
          ? media.original_info.width
          : 0,
        height: typeof media?.original_info?.height === "number"
          ? media.original_info.height
          : 0,
      },
    })).filter((media: Media) => Boolean(media.url));
  }

  private extractNextDataJson(html: string): string | null {
    const match = html.match(
      /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!match || !match[1]) return null;
    return match[1].trim();
  }
}
