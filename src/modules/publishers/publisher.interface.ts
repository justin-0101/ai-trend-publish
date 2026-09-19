export interface IPublisher {
  publish(content: string, options?: Record<string, any>): Promise<{ url?: string }>;
}