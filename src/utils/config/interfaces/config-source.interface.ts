export interface IConfigSource {
  /**
   * 优先级，数字越小优先级越高
   */
  priority: number;

  /**
   * 获取配置值
   * @param key 配置键
   */
  get<T>(key: string): Promise<T | null>;
}
