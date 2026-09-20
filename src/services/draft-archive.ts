/**
 * 出稿归档：把「发布结果」和「本地草稿」这两件容易各说各话的事收在一个地方。
 *
 * 三条规则，三个工作流共用一份实现：
 *
 * 1. **不论哪种发布方式，都先落一份本地草稿。**
 *    发布是外部调用，会因为 IP 白名单、限流、网络、token 过期而失败。
 *    先把稿子存下来，失败时才不会连内容一起丢。顺序必须是「先归档、再发布」——
 *    反过来时一旦发布失败，文章在本地也不剩，整轮白跑。
 *
 * 2. **发布成功后把归档草稿标成 published。**
 *    不标的话，草稿箱里会留一条显示「草稿」的记录、下面还挂着「发布」按钮，
 *    用户点一下就是重复提交到公众号。
 *
 * 3. **`publish()` 用返回值报错，不抛异常。**
 *    `WeixinPublisher.publish` 失败时返回 `{success:false, error}`，
 *    所以「调用了 publish」不等于「发布成功」。只看有没有抛异常就会把失败当成功。
 */

export type ArchivedDraftStatus = "draft" | "published";

export interface DraftArchiveEnv {
  draftWriter?: (
    draft: { title: string; html: string; workflowType: string },
  ) => Promise<unknown>;
  draftStatusWriter?: (
    id: string,
    status: ArchivedDraftStatus,
  ) => Promise<unknown>;
}

/**
 * 只需要 info/warn 两个方法，且都允许缺失：
 * 各工作流的 logger 形状不一致（模块级 Logger 类 / 内联对象），
 * 为了归档把 logger 接口改统一不值得，所以这里“有就用、没有就静默跳过”。
 */
export interface DraftArchiveLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

const say = (
  log: DraftArchiveLogger | undefined,
  level: "info" | "warn",
  msg: string,
) => {
  // 日志本身不能成为失败原因
  try {
    log?.[level]?.(msg);
  } catch { /* 忽略 */ }
};

/** `publish()` 的返回值形状（结构类型，不 import 那个有重名的接口） */
export interface PublishOutcome {
  success?: boolean;
  status?: string;
  publishId?: string;
  error?: string;
}

/** draftWriter 的返回值可能是 DraftItem，也可能被实现改成只回 id */
const pickDraftId = (value: unknown): string | null => {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
};

/**
 * 归档一份本地草稿，返回草稿 id（拿不到 id 时返回 null —— 归档失败不该打断出稿）。
 */
export const archiveDraft = async (
  env: DraftArchiveEnv | undefined,
  input: { title: string; html: string; workflowType: string },
  log: DraftArchiveLogger,
): Promise<string | null> => {
  const draftWriter = env?.draftWriter;
  if (!draftWriter) {
    say(log, "warn", "[归档] 未接入 draftWriter，本轮不留本地草稿");
    return null;
  }
  try {
    const created = await draftWriter(input);
    const id = pickDraftId(created);
    say(log, "info", `[归档] 本地草稿已保存${id ? ` id=${id}` : ""}`);
    return id;
  } catch (error) {
    // 归档只是安全网，它坏了不能把一条本来能发的稿子拖死
    say(
      log,
      "warn",
      `[归档] 保存本地草稿失败（不影响发布）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
};

/**
 * 发布成功后把归档草稿标成已发布，避免草稿箱里留下一条会诱人重复发布的「草稿」。
 * 同样不抛异常：标记失败顶多是草稿箱状态不准，不该把已经成功的发布判成失败。
 */
export const markArchivedDraftPublished = async (
  env: DraftArchiveEnv | undefined,
  draftId: string | null,
  log: DraftArchiveLogger,
): Promise<void> => {
  if (!draftId) return;
  const writer = env?.draftStatusWriter;
  if (!writer) {
    say(
      log,
      "warn",
      `[归档] 未接入 draftStatusWriter，草稿 ${draftId} 仍显示为「草稿」；` +
        "请在草稿箱里留意别重复发布",
    );
    return;
  }
  try {
    await writer(draftId, "published");
    say(log, "info", `[归档] 草稿 ${draftId} 已标记为已发布`);
  } catch (error) {
    say(
      log,
      "warn",
      `[归档] 标记草稿 ${draftId} 为已发布失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/**
 * 把 `publish()` 的返回值收口成一句失败原因；成功返回 null。
 *
 * 之所以要这一步：`publish()` 失败时是**返回** `{success:false}` 而不是抛异常，
 * 所以调用方如果只看「有没有抛错」，就会出现「界面说发布成功、实际什么都没发出去」。
 */
export const readPublishFailure = (result: unknown): string | null => {
  if (result && typeof result === "object" && "success" in result) {
    const outcome = result as PublishOutcome;
    if (outcome.success === true) return null;
    return outcome.error || "发布接口返回 success=false（未给出原因）";
  }
  // 没有 success 字段就不是 PublishResult 的形状，不替它猜
  return null;
};
