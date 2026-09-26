/**
 * 隐私后检（纯函数，无 IO、无 LLM）。
 *
 * 规则来自 skill 的 `references/privacy-redaction.md`。与那份文档的分工：
 * 文档给模型看（语义层），本文件给代码看（模式层）。两层都要过，因为模型会漏。
 *
 * 设计取舍：机构名、公开人名（OpenAI、中科院）本身不是泄露，公开报道里必须能写。
 * 所以模式一律要求**第一人称或关系词锚点**，只有「我所在的单位」「我朋友张三」
 * 这种把作者和具体人或组织绑定的写法才算命中。宽泛匹配会把正常文章全拦下来，
 * 那样闸门会被绕过或被关掉，等于没有。
 *
 * 具体姓名与单位名不写在源码里，由调用方从配置和本地敏感名单读取后传入
 * （见 `src/services/privacy-guard.ts`）。
 */

export type PrivacySeverity = "block" | "warn";

export interface PrivacyHit {
  category: string;
  severity: PrivacySeverity;
  /** 命中的原文片段 */
  text: string;
  /** 字符位置，便于正文定位 */
  index: number;
  advice: string;
}

export interface PrivacyRule {
  category: string;
  severity: PrivacySeverity;
  pattern: RegExp;
  advice: string;
}

const RELATION =
  "(儿子|女儿|孩子|娃|老婆|妻子|老公|丈夫|爸爸|妈妈|父亲|母亲|哥哥|姐姐|弟弟|妹妹|爷爷|奶奶|外公|外婆|朋友|同学|同事|邻居|亲戚|领导|老板|客户|供应商)";
const ORG_WORD =
  "(公司|单位|集团|部门|事业群|研究院|研究所|医院|学校|银行|工厂|项目部)";

/**
 * 规则顺序即优先级：先命中先记录，位置重叠时后来的跳过。
 * 联系方式与金额放最前，因为它们最不可挽回。
 */
export const CHINESE_NAME_HINT = "(?:(?:我|我们|俺|咱)[^。；\\n]{0,6})?";

export const PRIVACY_RULES: PrivacyRule[] = [
  {
    category: "联系方式",
    severity: "block",
    pattern:
      /(?:1[3-9]\d{9})|(?:[\w.+-]+@[\w-]+\.[\w.]+)|(?:微信号|微信[:：]|QQ[:：]|抖音号[:：])/g,
    advice: "联系方式一律不进正文，直接删除。",
  },
  {
    category: "财务金额",
    severity: "block",
    pattern:
      /(?:欠|债|贷款|借款|负债|月供|房贷|车贷|还款|信用卡|月薪|年薪|工资|收入|流水|存款|理财|投资|持仓)\D{0,12}\d+(?:\.\d+)?\s*(?:万|万元|亿|元|块)/g,
    advice:
      "家庭财务与债务数字不进正文，改成处境描述（如「手上有笔账要还」）。",
  },
  {
    category: "财务金额",
    severity: "block",
    pattern:
      /\d+(?:\.\d+)?\s*(?:万|万元|亿|元|块)\D{0,12}(?:欠|债|贷款|借款|负债|月供|房贷|车贷|还款|信用卡|月薪|年薪|工资|收入|存款)/g,
    advice: "家庭财务与债务数字不进正文，改成处境描述。",
  },
  {
    category: "家人姓名",
    severity: "block",
    pattern: new RegExp(
      `(?:我|我们|俺|咱)(?:的)?${RELATION}(?:叫|名叫|名字[是为])?\\s*[\\u4e00-\\u9fa5]{2,4}`,
      "g",
    ),
    advice: "亲属一律用关系词（孩子、家里人），不写姓名与小名。",
  },
  {
    category: "关联单位",
    severity: "block",
    pattern: new RegExp(
      `(?:我|我们|俺|咱)(?:的|所在|所在的|就职于|任职于)?\\s*${ORG_WORD}`,
      "g",
    ),
    advice: "不写与作者绑定的单位，改成行业角色（如「做企业侧项目的人」）。",
  },
  {
    category: "关联单位",
    severity: "block",
    pattern: new RegExp(
      `(?:我|我们)(?:的)?${RELATION}\\s*[\\u4e00-\\u9fa5]{2,6}(?:公司|集团|单位|研究院|医院)`,
      "g",
    ),
    advice: "不写亲属或朋友所在的单位。",
  },
  {
    category: "未成年人与学校",
    severity: "block",
    pattern:
      /(?:孩子|儿子|女儿|娃|小孩)\S{0,10}(?:学校|中学|小学|附中|实验学校|校区|班级)/g,
    advice: "不写孩子所在学校与班级；只保留学段（如「孩子上高中」）。",
  },
  {
    category: "未成年人与学校",
    severity: "block",
    pattern:
      /(?:高[一二三]|初[一二三]|小学[一二三四五六]年级|\d+年级|\d+班)\S{0,6}(?:学生|同学|孩子|儿子|女儿)/g,
    advice: "不写可识别未成年人身份的年级与班级组合。",
  },
  {
    category: "精确地址",
    severity: "block",
    pattern:
      /(?:住|住在|搬(?:到|去)|地址)\S{0,12}(?:小区|花园|大厦|公寓|城中村|村|镇|街道)\S{0,8}/g,
    advice: "不写住址与小区，改成「还在租房」一类处境描述。",
  },
  {
    category: "健康与心理",
    severity: "block",
    pattern:
      /(?:我|我们)\S{0,6}(?:确诊|住院|手术|病历|体检报告|抑郁症|焦虑症|失眠症)/g,
    advice: "健康与心理诊断不进正文，写行为与影响即可。",
  },
  {
    category: "第三方聊天内容",
    severity: "warn",
    pattern: /(?:聊天记录|私信|对话截图)\S{0,10}(?:里|中|显示|截图)/g,
    advice: "第三方聊天内容需另找公开材料替代，或删除该论据。",
  },
  {
    category: "机构与职级",
    severity: "warn",
    pattern:
      /(?:我|我们)\S{0,8}(?:总监|经理|主管|部长|处长|副总|总经理|负责人)\S{0,6}(?:职位|岗位|职级|任职)/g,
    advice: "不用职级证明观点，删掉或改成角色说明。",
  },
];

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 名单词转成一条字面量规则；空名单返回 null，不生成「匹配一切」的规则。 */
export const buildBlockedTermRule = (
  terms: string[],
): PrivacyRule | null => {
  const cleaned = [
    ...new Set(terms.map((term) => term.trim()).filter(Boolean)),
  ];
  if (cleaned.length === 0) return null;
  return {
    category: "敏感名单",
    severity: "block",
    pattern: new RegExp(cleaned.map(escapeRegExp).join("|"), "g"),
    advice: "命中本地敏感名单（姓名或单位）。正文改用关系词或行业角色。",
  };
};

export interface ScanPrivacyOptions {
  /** 敏感名单：真实姓名、单位名等，由调用方从配置或本地名单读取 */
  blockedTerms?: string[];
  /** 追加自定义规则，测试与扩展用 */
  extraRules?: PrivacyRule[];
}

/**
 * 扫描文本，返回按出现位置排序的命中项。
 * 名单规则放最前，保证「姓名」优先于宽泛的关系词规则被记录。
 */
export const scanPrivacy = (
  text: string,
  options: ScanPrivacyOptions = {},
): PrivacyHit[] => {
  const source = String(text ?? "");
  if (!source) return [];

  const termRule = buildBlockedTermRule(options.blockedTerms ?? []);
  const rules = [
    ...(termRule ? [termRule] : []),
    ...PRIVACY_RULES,
    ...(options.extraRules ?? []),
  ];

  const hits: PrivacyHit[] = [];
  const covered: Array<[number, number]> = [];

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(source)) !== null) {
      if (match[0].length === 0) {
        rule.pattern.lastIndex++;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      // 先命中的规则优先级更高，位置重叠时后续规则跳过
      if (covered.some(([s, e]) => start < e && end > s)) continue;
      covered.push([start, end]);
      hits.push({
        category: rule.category,
        severity: rule.severity,
        text: match[0],
        index: start,
        advice: rule.advice,
      });
    }
  }

  return hits.sort((a, b) => a.index - b.index);
};

export interface PrivacyScanResult {
  hits: PrivacyHit[];
  blocking: PrivacyHit[];
  warnings: PrivacyHit[];
  /** 无 block 级命中即通过 */
  passed: boolean;
}

export const scanAndJudge = (
  text: string,
  options: ScanPrivacyOptions = {},
): PrivacyScanResult => {
  const hits = scanPrivacy(text, options);
  const blocking = hits.filter((hit) => hit.severity === "block");
  const warnings = hits.filter((hit) => hit.severity === "warn");
  return { hits, blocking, warnings, passed: blocking.length === 0 };
};

/**
 * 把**模型层**报的隐私命中与真实正文对账。
 *
 * 为什么要对账：代码层是故意收窄的（机构名需带第一人称锚点），所以会漏掉
 * 「在某某公司做项目」这类写法；唯一能抳住的信号是第三轮审稿的 privacyHits。
 * 但模型也会报出不存在的命中（重复指令里的例子、或直接幻觉），如果照单全收，
 * 闸门会因假阳性而失去可信度，最后被人整个关掉。
 *
 * 所以取中间那条线：**只有命中文本确实出现在正文里，才算真命中**。
 * 假阳性不影响发布，真命中一律拦住。
 */
export const reconcileLlmPrivacyHits = (
  raw: unknown,
  content: string,
): Array<{ category: string; text: string }> => {
  if (!Array.isArray(raw)) return [];
  const haystack = String(content ?? "");
  const reconciled: Array<{ category: string; text: string }> = [];

  for (const item of raw) {
    let category = "模型层命中";
    let text = "";
    if (typeof item === "string") {
      text = item;
    } else if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      category = typeof record.category === "string" && record.category.trim()
        ? record.category.trim()
        : category;
      for (const key of ["text", "hit", "quote", "原文"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim()) {
          text = candidate;
          break;
        }
      }
    }

    const needle = text.trim();
    // 过短的文本（如「我」）在正文里必然出现，不构成证据
    if (needle.length < 2) continue;
    if (!haystack.includes(needle)) continue;
    reconciled.push({ category, text: needle });
  }

  return reconciled;
};

/**
 * 把文本里的名单词整词改写成占位符。
 *
 * 用在**审计元数据**上（章节路径、文件路径等）：正文已经整行删除，
 * 但元数据里的标题也常常带姓名（例如「<姓名> · Agent 记忆包」），
 * 不处理的话名字会被写进落盘的审计文件。
 */
export const redactTerms = (text: string, terms: string[]): string => {
  let output = String(text ?? "");
  for (const term of terms) {
    const needle = term.trim();
    if (needle.length === 0) continue;
    output = output.split(needle).join("「已隐去」");
  }
  return output;
};

/** 命中项转成可读行，附字符位置便于定位。 */
export const formatPrivacyHits = (hits: PrivacyHit[]): string =>
  hits
    .map((hit) =>
      `[${
        hit.severity === "block" ? "拦截" : "提醒"
      }] ${hit.category} @${hit.index}：${
        hit.text.replace(/\s+/g, " ").slice(0, 60)
      }｜${hit.advice}`
    )
    .join("\n");

/**
 * 为「作者背景」送进模型前的脱敏。
 *
 * 与正文后检不同：背景材料的用途是让模型理解作者立场，不是原文引用，
 * 所以这里可以把命中所在的整行删掉，而不是替换成关系词——半句残留会形成
 * 新的可识别片段，整行删更干净。删掉的是数字与身份，留下的是判断与处境类型。
 */
export const sanitizeAuthorContext = (
  text: string,
  options: ScanPrivacyOptions = {},
): { text: string; removed: PrivacyHit[] } => {
  const source = String(text ?? "");
  if (!source) return { text: "", removed: [] };

  const blocking = scanPrivacy(source, options).filter(
    (hit) => hit.severity === "block",
  );
  if (blocking.length === 0) return { text: source, removed: [] };

  const lines = source.split("\n");
  const lineStarts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length + 1;
  }

  const dropLines = new Set<number>();
  for (const hit of blocking) {
    for (let i = 0; i < lineStarts.length; i++) {
      const start = lineStarts[i];
      const end = start + lines[i].length;
      if (hit.index >= start && hit.index <= end) {
        dropLines.add(i);
        break;
      }
    }
  }

  return {
    text: lines
      .filter((_, index) => !dropLines.has(index))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    removed: blocking,
  };
};
