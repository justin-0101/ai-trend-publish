import { assertEquals, assertRejects } from "https://deno.land/std/testing/asserts.ts";
import { IConfigSource } from "file:///D:/trace/ai-trend-publish/src/utils/config/interfaces/config-source.interface.ts";
import { ConfigManager } from "file:///D:/trace/ai-trend-publish/src/utils/config/config-manager.ts";

class MockConfigSource implements IConfigSource {
  priority = 1;
  private data: Record<string, any>;

  constructor(data: Record<string, any> = {}) {
    this.data = data;
  }

  async get<T>(key: string): Promise<T> {
    if (key in this.data) {
      return this.data[key] as T;
    }
    throw new Error(`Key not found: ${key}`);
  }
}

class FailingConfigSource implements IConfigSource {
  priority = 2;
  failureCount = 0;
  maxFailures: number;

  constructor(maxFailures: number) {
    this.maxFailures = maxFailures;
  }

  async get<T>(key: string): Promise<T> {
    if (this.failureCount < this.maxFailures) {
      this.failureCount++;
      throw new Error("Simulated failure");
    }
    return "success" as T;
  }
}

Deno.test("ConfigManager - Basic Operations", async (t) => {
  // 设置测试环境
  Deno.env.set("DENO_ENV", "test");
  await t.step("should get value from config source", async () => {
    const configManager = ConfigManager.getInstance();
    configManager.clearSources();
    
    const mockSource = new MockConfigSource({
      TEST_KEY: "test_value",
    });
    configManager.addSource(mockSource);

    const value = await configManager.get<string>("TEST_KEY");
    assertEquals(value, "test_value");
  });

  await t.step("should handle multiple sources with priority", async () => {
    const configManager = ConfigManager.getInstance();
    configManager.clearSources();
    
    const lowPrioritySource = new MockConfigSource({ KEY: "low" });
    lowPrioritySource.priority = 2;
    
    const highPrioritySource = new MockConfigSource({ KEY: "high" });
    highPrioritySource.priority = 1;

    configManager.addSource(lowPrioritySource);
    configManager.addSource(highPrioritySource);

    const value = await configManager.get<string>("KEY");
    assertEquals(value, "high");
  });

  await t.step("should retry on failure", async () => {
    const configManager = ConfigManager.getInstance();
    configManager.clearSources();
    
    const failingSource = new FailingConfigSource(2);
    configManager.addSource(failingSource);

    const value = await configManager.get<string>("ANY_KEY", {
      maxAttempts: 3,
      delayMs: 100,
    });
    assertEquals(value, "success");
  });

  await t.step("should throw error when key not found", async () => {
    const configManager = ConfigManager.getInstance();
    configManager.clearSources();
    
    const mockSource = new MockConfigSource();
    configManager.addSource(mockSource);

    await assertRejects(
      () => configManager.get<string>("NON_EXISTENT_KEY"),
      Error,
      "Configuration key",
    );
  });
});