import { ConfigManager } from "@src/utils/config/config-manager.ts";

/**
 * 读取可选配置：按配置源优先级逐个直读，键缺失或某个源不可用时返回 null。
 *
 * 与 ConfigManager.get 的区别：不会因为键不存在而按源打 warn
 * （"Failed to get config ..."）。可选键在正常运行的日志里不该看起来像报错，
 * 而运行日志现在会出现在工作流详情抽屉里，尤其不能制造误导。
 */
export const readOptionalConfig = async (
  key: string,
): Promise<string | number | null> => {
  const manager = ConfigManager.getInstance();
  for (const source of manager.getSources()) {
    try {
      const value = await source.get<string | number>(key);
      if (value === null || value === undefined || value === "") {
        continue;
      }
      return value;
    } catch {
      // 源不可用（例如未配置/未启用的 DB）直接跳过
      continue;
    }
  }
  return null;
};
