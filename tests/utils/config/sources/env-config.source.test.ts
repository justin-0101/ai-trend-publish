import { assertEquals, assertRejects } from "https://deno.land/std/testing/asserts.ts";
import { EnvConfigSource } from "file:///D:/trace/ai-trend-publish/src/utils/config/sources/env-config.source.ts";

Deno.test("EnvConfigSource", async (t) => {
  const envSource = new EnvConfigSource();

  await t.step("should get value from environment", async () => {
    Deno.env.set("TEST_ENV_VAR", "test_value");
    const value = await envSource.get<string>("TEST_ENV_VAR");
    assertEquals(value, "test_value");
    Deno.env.delete("TEST_ENV_VAR");
  });

  await t.step("should throw error for non-existent key", async () => {
    await assertRejects(
      () => envSource.get<string>("NON_EXISTENT_ENV_VAR"),
      Error,
      "Environment variable",
    );
  });
});