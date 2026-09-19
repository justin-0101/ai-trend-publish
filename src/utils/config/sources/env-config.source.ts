import { IConfigSource } from "../interfaces/config-source.interface.ts";

export class EnvConfigSource implements IConfigSource {
  priority = 1;

  async get<T>(key: string): Promise<T> {
    const value = Deno.env.get(key);
    if (value === undefined) {
      throw new Error(`Environment variable "${key}" not found`);
    }
    return value as unknown as T;
  }
}
