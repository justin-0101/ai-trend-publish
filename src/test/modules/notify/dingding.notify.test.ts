import { assertEquals, assertRejects } from "https://deno.land/std@0.221.0/assert/mod.ts";
import { DingdingNotify } from "../../../modules/notify/dingding.notify.ts";
import type { Level } from "../../../modules/interfaces/notify.interface.ts";

Deno.test("DingdingNotify - 基础功能测试", async () => {
  const notifier = new DingdingNotify();
  await notifier.refresh();

  // 测试通知发送
  const testTitle = "测试标题";
  const testContent = "测试内容";
  const options = {
    level: "active" as Level,
    icon: "https://example.com/icon.png",
    group: "test",
  };

  try {
    await notifier.notify(testTitle, testContent, options);
    console.log("✓ 通知发送测试通过");
  } catch (error) {
    if (error.message.includes("DINGDING_WEBHOOK not configured")) {
      console.log("✓ 未配置DINGDING_WEBHOOK时的错误处理正确");
    } else {
      throw error;
    }
  }
});

Deno.test("DingdingNotify - 错误处理测试", async () => {
  const notifier = new DingdingNotify();
  await notifier.refresh();

  // 测试空标题
  if (notifier.isEnabled()) {
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
  } else {
    console.log("✓ 钉钉通知未启用，跳过空标题和空内容测试");
  }

  // 测试无效的webhook
  const notifierWithInvalidWebhook = new DingdingNotify();
  await notifierWithInvalidWebhook.refresh();
  if (notifierWithInvalidWebhook.isEnabled()) {
    await assertRejects(
      async () => {
        await notifierWithInvalidWebhook.notify("测试标题", "测试内容", {});
      },
      Error,
      "Failed to send DingDing notification",
    );
  } else {
    console.log("✓ 钉钉通知未启用，跳过无效webhook测试");
  }
});