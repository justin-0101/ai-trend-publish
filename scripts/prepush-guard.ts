/**
 * 推送前守卫（pre-push guard）
 *
 * 规则（来自本人指令）：
 *   1. **不推 `.env` 里的真实值** —— 尤其是 AppID / AppSecret / API Key / Token / 密码 / Webhook；
 *   2. **不推具体公司名称**，需要用占位符（`<公司A>`、`<客户A>` …）替代。
 *
 * 为什么做成工具：靠人记必然漏。这个脚本由 `.git/hooks/pre-push` 调用，
 * 命中就以退出码 1 拒绝推送；只在本地跑，不联网、不上传任何东西。
 *
 * 用法：
 *   deno run --allow-read --allow-run --allow-env --no-check scripts/prepush-guard.ts
 *     ↑ 在 git pre-push 钩子里调用：从 stdin 读 refs，只扫「这次要推的文件」
 *   ... --all              扫当前 HEAD 的整棵树（体检用）
 *   ... --range A..B       扫指定范围
 *
 * 命中后怎么办：
 *   - 换成占位符（真值/公司名都是）；
 *   - 或者把误报词写进 scripts/prepush-blocklist.txt 的 `allow:` 行；
 *   - 确认无误要强推：`git push --no-verify`（不推荐，自己承担）。
 */

const CWD = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = decodeURIComponent(CWD.replace(/\/scripts\/?$/, ""));
const BLOCKLIST = `${REPO}/scripts/prepush-blocklist.txt`;
/** 本地敏感名单：绝不入库（.gitignore 已排除），真实单位名/客户名/姓名写这里 */
const LOCAL_BLOCKLIST = `${REPO}/.prepush-blocklist.local.txt`;

// ---------------------------------------------------------------- 规则表

/** `.env` 里哪些键算凭证：这些键的**真实值**出现在任何被推文件里 → 拦 */
const SECRET_KEY_RE =
  /(API_?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|APP_?ID|APPID|WEBHOOK|COOKIE|CSRF|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY)/i;

/** 公司名的「形状」：中文后缀 —— 不需要名单也能拦住的那些 */
const COMPANY_SUFFIX_RE =
  /[\u4e00-\u9fa5A-Za-z0-9（）()·]{2,24}(?:有限公司|股份有限公司|有限责任公司|集团|研究院|事务所|工作室)/g;

/**
 * 公开大厂/开源组织名：科技资讯正文里本来就会出现（本仓库的内容就是 AI 新闻），
 * 一律拦会把所有稿子都卡死。它们进白名单；但**一旦和客户类上下文词同现**，照样拦（见下）。
 */
const DEFAULT_ALLOW = [
  "OpenAI", "Google", "DeepMind", "Alphabet", "Microsoft", "Meta", "Apple",
  "Amazon", "NVIDIA", "Anthropic", "DeepSeek", "Moonshot", "MiniMax", "Mistral",
  "Hugging Face", "HuggingFace", "GitHub", "Reddit", "YouTube", "Stripe",
  "阿里巴巴", "阿里云", "腾讯", "字节跳动", "百度", "华为", "小米", "美团",
  "京东", "网易", "滴滴", "快手", "智谱", "月之暗面", "阶跃星辰", "零一万物",
  "深度求索", "科大讯飞", "商汤", "旷视", "寒武纪", "联想", "浪潮", "中兴",
];

/** 客户类上下文：与公司名同现时，白名单也失效 —— 因为这已经不是「新闻里的公司」 */
const CLIENT_CONTEXT_RE =
  /(客户|甲方|乙方|需求方|对接人|合同|报价|回款|商机|报备|中标|采购|供应商|招标|项目名称)/;

/** 其它凭证形状：不依赖 .env 也能认出来的 */
const GENERIC_SECRET_RES: Array<{ name: string; re: RegExp }> = [
  { name: "OpenAI 风格密钥", re: /sk-[A-Za-z0-9_\-]{20,}/ },
  { name: "Bearer 令牌", re: /bearer\s+[A-Za-z0-9_\-.]{20,}/i },
  { name: "带密码的连接串", re: /(mysql|postgres|postgresql|mongodb|redis):\/\/[^\s"'@/]+:[^\s"'@/]+@/i },
  { name: "密钥赋值", re: /(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["'](?!your|example|placeholder|change|xxx|xxx|demo|sample|test|todo|<)[^"'\s]{16,}["']/i },
  { name: "手机号", re: /(?<![0-9])1[3-9]\d{9}(?![0-9])/ },
  { name: "身份证号", re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
];

/** 只看文本文件；二进制/大文件跳过 */
const TEXT_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|txt|html|htm|css|scss|yml|yaml|ps1|bat|cmd|vbs|ejs|example|sql|toml|sh|xml|env|ini|conf|cfg|properties)$/i;
const MAX_SCAN_BYTES = 3 * 1024 * 1024;

/**
 * 这几个文件是「规则本身」（实现 / 词表 / 钩子），里面必然写着公司名后缀的示例文字，
 * 对它们跳过「公司名形状」检查；但黑名单词与 .env 真值检查**照常执行** ——
 * 也就是说「在代码注释里写出真实单位名」照样会被拦下。
 */
const SUFFIX_EXEMPT = new Set([
  "scripts/prepush-guard.ts",
  "scripts/prepush-blocklist.txt",
  "scripts/git-hooks/pre-push",
]);

// ---------------------------------------------------------------- 工具

const git = (args: string[]): string => {
  const out = new Deno.Command("git", {
    args,
    cwd: REPO,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")} 失败：${new TextDecoder().decode(out.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
};

const readBlocklist = (): { block: string[]; allow: string[] } => {
  const block: string[] = [];
  const allow: string[] = [...DEFAULT_ALLOW];
  // 公共模板 + 本地名单（本地文件不入库）：
  // 把真实客户名写进入库的词表，等于换个地方公开客户名 —— 要拦的东西不该自己泄露。
  for (const file of [BLOCKLIST, LOCAL_BLOCKLIST]) {
    let raw = "";
    try {
      raw = Deno.readTextFileSync(file);
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith("#")) continue;
      if (text.startsWith("allow:")) allow.push(text.slice(6).trim());
      else if (text.startsWith("block:")) block.push(text.slice(6).trim());
      else block.push(text);
    }
  }
  return { block: block.filter(Boolean), allow: allow.filter(Boolean) };
};

/** 本地 `.env` 的敏感键真实值（**只在内存里比对，绝不打印**） */
const readSecretValues = (): Array<{ key: string; value: string }> => {
  let raw = "";
  try {
    raw = Deno.readTextFileSync(`${REPO}/.env`);
  } catch {
    return [];
  }
  const out: Array<{ key: string; value: string }> = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (!SECRET_KEY_RE.test(key)) continue;
    if (value.length < 6) continue;
    out.push({ key, value });
  }
  return out;
};

interface Finding {
  file: string;
  line: number;
  kind: string;
  detail: string;
  hint: string;
}

const scanText = (
  file: string,
  text: string,
  secrets: Array<{ key: string; value: string }>,
  blocklist: { block: string[]; allow: string[] },
  skipCompanySuffix = false,
): Finding[] => {
  const findings: Finding[] = [];
  const lines = text.split("\n");

  // 1) 本地 .env 的真实值（不打印值，只报键名）
  //    短值（如 6 位的弱密码）按子串搜会天天误报（代码注释里的 `123456` 并不是密钥），
  //    所以分两档：长值（≥12）允许在任意位置命中；短值只在「同一行还出现了键名」时报——
  //    那正是「把 .env 贴进文档」的情形。
  for (const { key, value } of secrets) {
    const strong = value.length >= 12;
    const idx = lines.findIndex((l) =>
      strong
        ? l.includes(value)
        : (l.includes(key) && l.includes(value))
    );
    if (idx >= 0) {
      findings.push({
        file,
        line: idx + 1,
        kind: ".env 真值",
        detail: `命中 .env 的 ${key}（值不打印）`,
        hint: "换成占位符，例如 wx_your_appid / your-api-key",
      });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 2) 黑名单词（本人单位、姓名、客户名…）
    for (const word of blocklist.block) {
      if (line.includes(word)) {
        findings.push({
          file,
          line: i + 1,
          kind: "黑名单词",
          detail: `「${word}」`,
          hint: "替换为占位符（如 <公司A>）；若是误报，把词加进 prepush-blocklist.txt 的 allow: 行",
        });
        break; // 一行只报一次，避免长词被短词重复命中
      }
    }

    // 3) 公司名形状
    if (!skipCompanySuffix) {
      for (const name of new Set(line.match(COMPANY_SUFFIX_RE) ?? [])) {
        const allowed = blocklist.allow.some((a) => name.includes(a));
        const inClientContext = CLIENT_CONTEXT_RE.test(line);
        if (inClientContext) {
          findings.push({
            file,
            line: i + 1,
            kind: "客户上下文里的公司名",
            detail: `「${name}」同行出现客户类词`,
            hint: "替换为占位符（如 <客户A>）",
          });
        } else if (!allowed) {
          findings.push({
            file,
            line: i + 1,
            kind: "公司名",
            detail: `「${name}」`,
            hint:
              "替换为占位符（如 <公司A>）；公开大厂名可加进 prepush-blocklist.txt 的 allow: 行",
          });
        }
      }
    }

    // 4) 其它凭证形状
    for (const { name, re } of GENERIC_SECRET_RES) {
      if (re.test(line)) {
        findings.push({
          file,
          line: i + 1,
          kind: name,
          detail: "命中凭证/隐私模式（内容不打印）",
          hint: "移除或改写成占位符",
        });
      }
    }
  }

  return findings;
};

// ---------------------------------------------------------------- 主流程

const wantsAll = Deno.args.includes("--all");
const rangeArgIdx = Deno.args.indexOf("--range");
const explicitRange = rangeArgIdx >= 0 ? Deno.args[rangeArgIdx + 1] : null;

interface Target {
  commit: string;
  files: string[];
  /** 要推的提交信息（提交信息同样会公开，客户名写在这里一样是泄露） */
  messages: Array<{ label: string; text: string }>;
}

/** 取某范围的提交信息 */
const commitMessages = (range: string): Array<{ label: string; text: string }> => {
  const raw = git(["log", "--format=%h%x1f%B%x1e", range]);
  return raw
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, ...rest] = chunk.split("\x1f");
      return { label: `提交信息 ${sha.trim()}`, text: rest.join("\x1f") };
    });
};

/** 要检查的 [commit, 文件清单]：一律从 git 对象读，保证查的就是「推送出去的内容」 */
const collectTargets = async (): Promise<Target[]> => {
  if (explicitRange) {
    const [from] = explicitRange.split("..");
    const commit = explicitRange.split("..")[1] || "HEAD";
    const files = git(["diff", "--name-only", "--diff-filter=ACMR", from, commit])
      .split("\n").map((s) => s.trim()).filter(Boolean);
    return [{ commit, files, messages: commitMessages(explicitRange) }];
  }
  if (wantsAll || Deno.stdin.isTerminal()) {
    const commit = "HEAD";
    const files = git(["ls-tree", "-r", "--name-only", commit])
      .split("\n").map((s) => s.trim()).filter(Boolean);
    return [{ commit, files, messages: commitMessages(commit) }];
  }
  // pre-push：stdin 每行 = <local ref> <local sha> <remote ref> <remote sha>
  const stdin = await new Response(Deno.stdin.readable).text();
  const targets: Target[] = [];
  for (const line of stdin.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const localSha = parts[1];
    const remoteSha = parts[3];
    const zero = /^0+$/.test(remoteSha);
    const range = zero ? localSha : `${remoteSha}..${localSha}`;
    const files = zero
      ? git(["ls-tree", "-r", "--name-only", localSha]).split("\n")
      : git(["diff", "--name-only", "--diff-filter=ACMR", remoteSha, localSha]).split("\n");
    targets.push({
      commit: localSha,
      files: files.map((s) => s.trim()).filter(Boolean),
      messages: commitMessages(range),
    });
  }
  return targets;
};

const main = async () => {
  const secrets = readSecretValues();
  const blocklist = readBlocklist();
  const targets = await collectTargets();
  const findings: Finding[] = [];
  let scanned = 0;

  for (const { commit, files, messages } of targets) {
    for (const { label, text } of messages) {
      findings.push(...scanText(label, text, secrets, blocklist));
    }
    for (const file of files) {
      if (!TEXT_EXT_RE.test(file)) continue;
      let text = "";
      try {
        const info = git(["cat-file", "-s", `${commit}:${file}`]).trim();
        if (Number(info) > MAX_SCAN_BYTES) continue;
        text = git(["show", `${commit}:${file}`]);
      } catch {
        continue; // 已删除或读不到，跳过
      }
      scanned++;
      findings.push(
        ...scanText(file, text, secrets, blocklist, SUFFIX_EXEMPT.has(file)),
      );
    }
  }

  console.log(
    `[推送守卫] 检查 ${scanned} 个文本文件 · 黑名单 ${blocklist.block.length} 词 · ` +
      `白名单 ${blocklist.allow.length} 词 · .env 敏感键 ${secrets.length} 个`,
  );

  if (findings.length === 0) {
    console.log("[推送守卫] 通过：没发现 .env 真值或公司名。");
    return 0;
  }

  console.error(`\n[推送守卫] 拒绝推送：发现 ${findings.length} 处需要替换为占位符的内容\n`);
  const grouped = new Map<string, Finding[]>();
  for (const f of findings) {
    grouped.set(f.file, [...(grouped.get(f.file) ?? []), f]);
  }
  let n = 0;
  for (const [file, list] of grouped) {
    console.error(`  ${file}`);
    for (const f of list.slice(0, 6)) {
      console.error(`    L${f.line}  [${f.kind}] ${f.detail}  → ${f.hint}`);
      n++;
    }
    if (list.length > 6) console.error(`    … 另有 ${list.length - 6} 处`);
  }
  console.error(
    `\n  处理：把上面内容换成占位符后重新提交；误报词写进 ${BLOCKLIST} 的 allow: 行。` +
      `\n  要拦的真实客户名写进本地名单 ${LOCAL_BLOCKLIST}（不入库）。` +
      `\n  确实要强推：git push --no-verify（不推荐）。\n`,
  );
  return 1;
};

Deno.exit(await main());
