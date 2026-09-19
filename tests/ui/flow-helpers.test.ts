import { assertEquals } from "@std/assert";
import {
  getSourceHeaderText,
  getWorkflowSaveStateText,
  isSourceFormDisabled,
  isSourceRunDisabled,
  isWorkflowActionsDisabled,
  isWorkflowInputsDisabled,
} from "../../docs/js/flow-helpers.js";

Deno.test("source header text for unselected source", () => {
  assertEquals(getSourceHeaderText(null, false), "未选择 · 请先选择采集源");
});

Deno.test("source header text for selected source dirty", () => {
  assertEquals(
    getSourceHeaderText({ platform: "twitter", identifier: "x.com/foo" }, true),
    "选中：twitter · x.com/foo · 未保存",
  );
});

Deno.test("source header text for selected source saved", () => {
  assertEquals(
    getSourceHeaderText({ platform: "twitter", identifier: "x.com/foo" }, false),
    "选中：twitter · x.com/foo · 已保存 · 可试跑",
  );
});

Deno.test("source run disabled when not selected or dirty", () => {
  assertEquals(isSourceRunDisabled(null, false), true);
  assertEquals(
    isSourceRunDisabled({ platform: "twitter", identifier: "x.com/foo" }, true),
    true,
  );
  assertEquals(
    isSourceRunDisabled({ platform: "twitter", identifier: "x.com/foo" }, false),
    false,
  );
});

Deno.test("source form disabled when not selected", () => {
  assertEquals(isSourceFormDisabled(null), true);
  assertEquals(
    isSourceFormDisabled({ platform: "twitter", identifier: "x.com/foo" }),
    false,
  );
});

Deno.test("workflow save state text by selection and dirty", () => {
  assertEquals(getWorkflowSaveStateText(false, false), "请选择工作流类型");
  assertEquals(getWorkflowSaveStateText(true, true), "未保存");
  assertEquals(getWorkflowSaveStateText(true, false), "已保存");
});

Deno.test("workflow actions disabled when type not selected", () => {
  assertEquals(isWorkflowActionsDisabled(false), true);
  assertEquals(isWorkflowActionsDisabled(true), false);
});

Deno.test("workflow inputs disabled when type not selected", () => {
  assertEquals(isWorkflowInputsDisabled(false), true);
  assertEquals(isWorkflowInputsDisabled(true), false);
});
