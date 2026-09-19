import { assertEquals } from "https://deno.land/std@0.221.0/assert/mod.ts";
import { WorkflowConfigService } from "../../services/workflow-config.service.ts";
import { WorkflowType } from "../../controllers/cron.ts";

Deno.test("WorkflowConfigService - 获取每日工作流配置", async () => {
  const service = WorkflowConfigService.getInstance();

  // 测试周一到周日的工作流配置
  for (let day = 1; day <= 7; day++) {
    const workflow = await service.getDailyWorkflow(day as 1 | 2 | 3 | 4 | 5 | 6 | 7);
    console.log(`周${day}工作流配置:`, workflow);
    
    // 验证返回值是否为有效的工作流类型
    const isValidWorkflow = Object.values(WorkflowType).includes(workflow as WorkflowType);
    assertEquals(isValidWorkflow, true, `周${day}返回了无效的工作流类型`);
  }

  console.log("✓ 工作流配置获取测试通过");
});

Deno.test("WorkflowConfigService - 单例模式测试", () => {
  const instance1 = WorkflowConfigService.getInstance();
  const instance2 = WorkflowConfigService.getInstance();

  assertEquals(
    instance1 === instance2,
    true,
    "单例模式未正确实现，获取到了不同的实例"
  );

  console.log("✓ 单例模式测试通过");
});