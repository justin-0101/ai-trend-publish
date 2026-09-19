export function getSourceHeaderText(selected, dirty) {
  if (!selected) {
    return "未选择 · 请先选择采集源";
  }
  const base = "选中：" + selected.platform + " · " + selected.identifier;
  if (dirty) {
    return base + " · 未保存";
  }
  return base + " · 已保存 · 可试跑";
}

export function isSourceRunDisabled(selected, dirty) {
  return !selected || Boolean(dirty);
}

export function isSourceFormDisabled(selected) {
  return !selected;
}

export function getWorkflowSaveStateText(hasType, dirty) {
  if (!hasType) {
    return "请选择工作流类型";
  }
  return dirty ? "未保存" : "已保存";
}

export function isWorkflowActionsDisabled(hasType) {
  return !hasType;
}

export function isWorkflowInputsDisabled(hasType) {
  return !hasType;
}
