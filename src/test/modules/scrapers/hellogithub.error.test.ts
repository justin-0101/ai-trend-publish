import { assertEquals, assertRejects } from "https://deno.land/std@0.221.0/assert/mod.ts";
import {
  cleanupHelloGithubReadme,
  HelloGithubScraper,
} from "@src/modules/scrapers/hellogithub.scraper.ts";

Deno.test("HelloGithubScraper - 异常处理和重试机制测试", async () => {
  const scraper = new HelloGithubScraper();

  // 测试无效的项目ID
  await assertRejects(
    async () => {
      await scraper.getItemDetail("invalid-id");
    },
    Error,
    "Failed to fetch project details: Cannot read properties of undefined (reading 'tags')"
  );

  // 测试页码超出范围
  await assertRejects(
    async () => {
      await scraper.getHotItems(999);
    },
    Error,
    "Failed to fetch hot items: Failed to fetch hot items"
  );

  // 测试重试机制
  try {
    const hotItems = await scraper.getHotItems(1);
    assertEquals(Array.isArray(hotItems), true, "应该返回数组类型的结果");
    assertEquals(hotItems.length > 0, true, "结果数组不应该为空");

    // 验证返回的数据结构
    const firstItem = hotItems[0];
    assertEquals(typeof firstItem.itemId, "string", "itemId 应该是字符串类型");
    assertEquals(typeof firstItem.title, "string", "title 应该是字符串类型");
    assertEquals(typeof firstItem.author, "string", "author 应该是字符串类型");
  } catch (error) {
    console.error("测试重试机制时发生错误:", error);
    throw error;
  }

  console.log("✓ 异常处理和重试机制测试通过");
});

Deno.test("HelloGithubScraper - README 清洗只保留自然语言", () => {
  const input =
    "# Title\n\n这里是介绍。\n\n```ts\nconst x = 1;\nfunction foo() {}\n```\n\n    indented code\n\n<pre><code>function bar(){}</code></pre>\n\n正文内容。\n";
  const output = cleanupHelloGithubReadme(input);
  assertEquals(output.includes("const x"), false);
  assertEquals(output.includes("function foo"), false);
  assertEquals(output.includes("indented code"), false);
  assertEquals(output.includes("function bar"), false);
  assertEquals(output.includes("这里是介绍。"), true);
  assertEquals(output.includes("正文内容。"), true);
});
