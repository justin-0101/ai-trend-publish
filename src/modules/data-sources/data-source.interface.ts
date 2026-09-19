export interface IDataSource {
  fetch(options?: Record<string, any>): Promise<any[]>;
}