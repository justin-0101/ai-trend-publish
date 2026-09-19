import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { TwitterSource } from "../modules/data-sources/twitter.source.ts";
import { ConfigManager } from "../utils/config/config-manager.ts";

Deno.test("TwitterSource - 初始化和验证", async () => {
  const configManager = ConfigManager.getInstance();
  await configManager.initialize();
  
  const source = new TwitterSource();
  await source.initialize();
  const isValid = await source.validate();
  assertEquals(isValid, true, "Twitter API连接验证失败");
});

Deno.test("TwitterSource - 数据采集", async () => {
  const configManager = ConfigManager.getInstance();
  await configManager.initialize();
  
  const source = new TwitterSource();
  await source.initialize();
  
  const items = await source.fetch({ limit: 5 });
  
  // 验证返回数据结构
  assertExists(items, "返回数据不能为空");
  assertEquals(items.length > 0, true, "没有获取到数据");
  
  // 验证数据字段
  const item = items[0];
  assertExists(item.id, "缺少id字段");
  assertExists(item.content, "缺少content字段");
  assertExists(item.author, "缺少author字段");
  assertExists(item.publishDate, "缺少publishDate字段");
  assertExists(item.url, "缺少url字段");
  assertExists(item.metadata, "缺少metadata字段");
});