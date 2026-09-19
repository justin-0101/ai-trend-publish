export interface PublishOptions {
  title: string;
  content: string;
  author?: string;
  needOpenComment?: boolean;
  onlyFansCanComment?: boolean;
  digest?: string;
  thumbMediaId?: string;
}

export interface PublishResult {
  success: boolean;
  error?: string;
  url?: string;
  articleId?: string;
}

export interface IPublisher {
  name: string;
  publish(options: PublishOptions): Promise<PublishResult>;
  validate(): Promise<boolean>;
}