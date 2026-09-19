import { IConfigSource } from "../interfaces/config-source.interface.ts";
import db from "../../../db/db.ts";

export class DbConfigSource implements IConfigSource {
  priority = 2;

  async get<T>(key: string): Promise<T | null> {
    const result = await db.query.config.findFirst({
      where: (config, { eq }) => eq(config.key, key),
      columns: {
        value: true
      }
    });
    
    if (!result || !result.value) {
      return null;
    }
    
    try {
      return JSON.parse(result.value) as T;
    } catch {
      return result.value as T;
    }
  }
}
