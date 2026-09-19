import { ConfigManager } from "../../utils/config/config-manager.ts";
import { HttpClient } from "../../utils/http/http-client.ts";
import { DataItem, DataSource, DataSourceOptions } from "../interfaces/data-source.interface.ts";

interface TwitterResponse {
  data: Array<{
    id: string;
    text: string;
    author_id: string;
    created_at: string;
  }>;
  includes?: {
    users?: Array<{
      id: string;
      name: string;
      username: string;
    }>;
  };
}

export class TwitterSource implements DataSource {
  name = "Twitter";
  private bearerToken!: string;
  private baseUrl = "https://api.twitter.com/2";
  private httpClient: HttpClient;
  private configManager: ConfigManager;

  constructor() {
    this.httpClient = HttpClient.getInstance();
    this.configManager = ConfigManager.getInstance();
  }

  async initialize(): Promise<void> {
    try {
      this.bearerToken = await this.configManager.get<string>("X_API_BEARER_TOKEN");
      if (!this.bearerToken) {
        throw new Error('Twitter Bearer Token is not configured');
      }
      this.httpClient.setDefaultHeader("Authorization", `Bearer ${this.bearerToken}`);
      console.log('[Twitter] Successfully initialized with API token');
    } catch (error) {
      console.error('[Twitter] Initialization failed:', error);
      throw error;
    }
  }

  async fetch(options: DataSourceOptions = {}): Promise<DataItem[]> {
    try {
      const queryParams = new URLSearchParams({
        "tweet.fields": "created_at,author_id",
        "user.fields": "name,username",
        "expansions": "author_id",
        "max_results": String(options.limit || 10),
        "query": "AI technology lang:en -is:retweet",
      });

      if (options.startDate) {
        queryParams.append("start_time", new Date(options.startDate).toISOString());
      }

      if (options.endDate) {
        queryParams.append("end_time", new Date(options.endDate).toISOString());
      }

      console.log(`[Twitter] Fetching tweets with params: ${queryParams.toString()}`);
      const response = await this.httpClient.get<TwitterResponse>(
        `${this.baseUrl}/tweets/search/recent?${queryParams.toString()}`,
      );
      if (!response || !response.data) {
        throw new Error('Invalid response from Twitter API');
      }
      console.log(`[Twitter] Successfully fetched ${response.data.length} tweets`);

    const userMap = new Map(
      response.includes?.users?.map(user => [user.id, user]) || [],
    );

    return response.data.map(tweet => ({
      id: tweet.id,
      title: "", // Twitter 没有标题
      content: tweet.text,
      author: userMap.get(tweet.author_id)?.name || tweet.author_id,
      publishDate: tweet.created_at,
      url: `https://twitter.com/i/web/status/${tweet.id}`,
      metadata: {
        authorId: tweet.author_id,
        username: userMap.get(tweet.author_id)?.username,
      },
    }));
  } catch (error) {
    console.error('[Twitter] Data fetch failed:', error);
    throw error;
  }
  }

  async validate(): Promise<boolean> {
    try {
      console.log('[Twitter] Validating API connection...');
      await this.httpClient.get(`${this.baseUrl}/tweets/search/recent?query=test&max_results=1`);
      console.log('[Twitter] API validation successful');
      return true;
    } catch (error) {
      console.error('[Twitter] API validation failed:', error);
      return false;
    }
  }
}