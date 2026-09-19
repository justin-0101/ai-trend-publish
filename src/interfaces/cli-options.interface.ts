export interface CLIOptions {
  source?: string;
  publisher?: string;
  title?: string;
  template?: string;
  dryRun?: boolean;
  healthCheck?: boolean;  // 添加健康检查选项
  daemon?: boolean;       // 添加守护进程选项
  schedule?: string;      // 添加定时任务选项
}