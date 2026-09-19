import { format } from "https://deno.land/std/datetime/mod.ts";
import { join } from "https://deno.land/std/path/mod.ts";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  private static instances: Map<string, Logger> = new Map();
  private logDir: string;
  private logLevel: LogLevel;
  private tag: string;

  private constructor(tag: string) {
    this.logDir = "logs";
    this.logLevel = LogLevel.INFO;
    this.tag = tag;
    this.ensureLogDir();
  }

  public static getInstance(tag: string = "default"): Logger {
    if (!Logger.instances.has(tag)) {
      Logger.instances.set(tag, new Logger(tag));
    }
    return Logger.instances.get(tag)!;
  }

  private ensureLogDir() {
    try {
      const logDirPath = join(Deno.cwd(), this.logDir);
      Deno.mkdirSync(logDirPath, { recursive: true });
      this.logDir = logDirPath;
    } catch (error) {
      console.error("创建日志目录失败:", error);
      throw new Error(`无法创建日志目录: ${(error as Error).message}`);
    }
  }

  private async writeLog(level: string, message: string): Promise<void> {
    const now = new Date();
    const timestamp = format(now, "yyyy-MM-dd HH:mm:ss");
    const logFile = join(this.logDir, `${format(now, "yyyy-MM-dd")}.log`);
    const logEntry = `[${timestamp}] [${level}] [${this.tag}] ${message}\n`;

    try {
      await Deno.writeTextFile(logFile, logEntry, { append: true });
      // 同时输出到控制台
      console.log(`[${timestamp}] [${level}] ${message}`);
    } catch (error) {
      // 如果写入文件失败，至少确保控制台输出
      console.error(`[${timestamp}] [ERROR] 写入日志失败: ${error instanceof Error ? error.message : String(error)}`);
      console.log(`[${timestamp}] [${level}] ${message}`);
    }
  }

  public setLogLevel(level: LogLevel) {
    this.logLevel = level;
  }

  public debug(message: string) {
    if (this.logLevel <= LogLevel.DEBUG) {
      this.writeLog("DEBUG", message);
    }
  }

  public info(message: string) {
    if (this.logLevel <= LogLevel.INFO) {
      this.writeLog("INFO", message);
    }
  }

  public warn(message: string) {
    if (this.logLevel <= LogLevel.WARN) {
      this.writeLog("WARN", message);
    }
  }

  public error(message: string) {
    if (this.logLevel <= LogLevel.ERROR) {
      this.writeLog("ERROR", message);
    }
  }
}