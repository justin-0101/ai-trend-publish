/**
 * 记忆包的本地摘要（纯函数，无 IO、无 LLM）。
 *
 * 用途：把作者记忆包压成「只含认知、观点、价值观、原则」的一段背景，再送去模型。
 * 事实性内容（时间线、家庭现状、财务、具体单位与人名）一律不进摘要。
 *
 * 三个设计决定：
 *
 * 1. **默认全不放行**：只有标题命中允许清单的章节才会进入摘要。
 *    漏写一条 deny 不会导致误送——这是刻意选的失败方向。
 * 2. **不做 LLM 摘要**：摘要由确定性的章节筛选完成，所以「送出去了什么」
 *    可以逐字审计，也不存在模型把隐私事实改写进摘要的路径。
 * 3. **deny 优先于 allow**：同一章节同时命中两边时按拒收处理。
 *
 * 抽出的文本仍会在送入模型前过一遍 `privacy.ts` 的脱敏（第二道网）。
 */

export interface MemorySection {
  /** 标题层级，1 为最高 */
  level: number;
  /** 标题行原文（不含 # 号） */
  heading: string;
  /** 祖先标题链，用于在摘要里保留归属，例如 ["五、职业操作系统", "5.5 职业决策默认原则"] */
  path: string[];
  /** 本章节正文 */
  body: string;
}

/** 默认允许清单：只放行「他怎么想、他看重什么、他的原则」这类章节。 */
export const DEFAULT_MEMORY_ALLOW = [
  "世界观",
  "人生观",
  "稳定优势",
  "阴影面",
  "真正需要的支持",
  "全链路观",
  "需求分析七层",
  "商务判断",
  "职业决策默认原则",
  "决策十问",
  "验证顺序",
  "三种声音",
  "底色",
  "文章骨架",
  "语言偏好",
  "价值冲突时的默认排序",
  "认知风险模式",
];

/** 默认拒绝清单。即使误入允许清单也一律拒收。 */
export const DEFAULT_MEMORY_DENY = [
  "时间线",
  "家庭与现状",
  "评分表",
  "分场景规则",
  "家书",
  "副业",
  "收入",
  "MBTI",
  "权限边界",
  "待校准",
  "待确认",
  "来源",
];

export interface MemoryDigestOptions {
  allow?: string[];
  deny?: string[];
  maxChars?: number;
}

export interface MemoryDigestDropped {
  heading: string;
  path: string;
  reason: "未命中允许清单" | "命中拒绝清单" | "无正文" | "超出字数上限";
}

export interface MemoryDigest {
  /** 摘要正文，可直接注入 */
  text: string;
  /** 实际采用的章节 */
  kept: Array<{ heading: string; path: string; chars: number }>;
  /** 未采用的章节与原因（落盘审计用） */
  dropped: MemoryDigestDropped[];
  /** 是否取到任何内容 */
  available: boolean;
}

const matchesAny = (heading: string, patterns: string[]): boolean => {
  const target = heading.toLowerCase();
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    return needle.length > 0 && target.includes(needle);
  });
};

const headingOf = (line: string): { level: number; heading: string } | null => {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (!match) return null;
  return { level: match[1].length, heading: match[2] };
};

/**
 * 单遍扫描，把 markdown 切成「标题 + 直到下一个标题为止」的块，
 * 并记录每个块的祖先链。子标题本身就是块，所以可以逐块放行或拒收。
 */
export const parseSections = (markdown: string): MemorySection[] => {
  const lines = String(markdown ?? "").split("\n");
  const sections: MemorySection[] = [];
  const stack: Array<{ level: number; heading: string }> = [];
  let current: MemorySection | null = null;

  const close = (): void => {
    if (current) {
      current.body = current.body.replace(/\s+$/, "");
      sections.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    const parsed = headingOf(line);
    if (parsed) {
      close();
      while (stack.length > 0 && stack[stack.length - 1].level >= parsed.level) {
        stack.pop();
      }
      // H1 当作文档标题，不进祖先链：否则每个章节的路径都会带上标题。
      const path = [...stack.map((item) => item.heading), parsed.heading];
      current = { level: parsed.level, heading: parsed.heading, path, body: "" };
      if (parsed.level >= 2) stack.push(parsed);
      continue;
    }
    if (current) current.body += (current.body ? "\n" : "") + line;
  }
  close();
  return sections;
};

export const buildMemoryDigest = (
  markdown: string,
  options: MemoryDigestOptions = {},
): MemoryDigest => {
  const allow = options.allow ?? DEFAULT_MEMORY_ALLOW;
  const deny = options.deny ?? DEFAULT_MEMORY_DENY;
  const maxChars = options.maxChars && options.maxChars > 0
    ? options.maxChars
    : Number.POSITIVE_INFINITY;

  const kept: MemoryDigest["kept"] = [];
  const dropped: MemoryDigestDropped[] = [];
  const blocks: string[] = [];
  let used = 0;

  for (const section of parseSections(markdown)) {
    const pathLabel = section.path.join(" > ");

    if (matchesAny(section.heading, deny)) {
      dropped.push({ heading: section.heading, path: pathLabel, reason: "命中拒绝清单" });
      continue;
    }
    if (!matchesAny(section.heading, allow)) {
      dropped.push({ heading: section.heading, path: pathLabel, reason: "未命中允许清单" });
      continue;
    }
    const body = section.body.trim();
    if (body.length === 0) {
      // 只有标题、没有正文的父级标题：不算采用，也不必报成拒收
      continue;
    }

    const block = `【${section.heading}】\n${body}`;
    if (used + block.length > maxChars) {
      const remaining = maxChars - used;
      if (remaining < 200) {
        dropped.push({ heading: section.heading, path: pathLabel, reason: "超出字数上限" });
        continue;
      }
      // 按段落边界截断，避免留下半句话当成完整原则
      const head = block.slice(0, remaining);
      const cut = head.lastIndexOf("\n\n");
      const trimmed = (cut > remaining * 0.5 ? head.slice(0, cut) : head).trimEnd();
      blocks.push(`${trimmed}\n[本节已按字数上限截断]`);
      kept.push({ heading: section.heading, path: pathLabel, chars: trimmed.length });
      used += trimmed.length;
      continue;
    }

    blocks.push(block);
    kept.push({ heading: section.heading, path: pathLabel, chars: block.length });
    used += block.length;
  }

  const text = blocks.join("\n\n");
  return { text, kept, dropped, available: text.length > 0 };
};
