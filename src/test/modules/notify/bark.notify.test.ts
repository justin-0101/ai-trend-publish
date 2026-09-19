import { assertEquals, assertRejects } from "https://deno.land/std@0.221.0/assert/mod.ts";
import { BarkNotifier } from "../../../modules/notify/bark.notify.ts";
import { Level } from "../../../modules/interfaces/notify.interface.ts";

Deno.test("BarkNotifier - 基础功能测试", async () => {
  const notifier = new BarkNotifier();
  await notifier.refresh();

  // 测试通知发送
  const testTitle = "测试标题";
  const testContent = "测试内容";
  const options = {
    level: Level.INFO,
    sound: "default",
    group: "test",
  };

  try {
    await notifier.notify(testTitle, testContent, options);
    console.log("✓ 通知发送测试通过");
  } catch (error) {
    if (error.message.includes("BARK_URL not configured")) {
      console.log("✓ 未配置BARK_URL时的错误处理正确");
    } else {
      throw error;
    }
  }
});

Deno.test("BarkNotifier - 错误处理测试", async () => {
  const notifier = new BarkNotifier();
  await notifier.refresh();

  // 测试空标题
  await assertRejects(
    async () => {
      await notifier.notify("", "测试内容", {});
    },
    Error,
    "标题不能为空",
  );

  // 测试空内容
  await assertRejects(
    async () => {
      await notifier.notify("测试标题", "", {});
    },
    Error,
    "内容不能为空",
  );

  console.log("✓ 参数验证测试通过");
});