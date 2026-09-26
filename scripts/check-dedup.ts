/**
 * 自检 content-dedup：真实数据 + 构造用例。
 * 跑法：deno run --env --allow-env --allow-read --allow-write --no-check scripts/check-dedup.ts
 */
import { dedupeContents } from "../src/services/content-dedup.ts";

interface Item {
  id: string;
  title: string;
  content: string;
  url?: string;
}

// ---------- 1. 真实数据：X 搜索 30 条，看会不会误合并 ----------
const files: Array<{ name: string; mtime: number }> = [];
for await (const entry of Deno.readDir("logs")) {
  if (!entry.name.startsWith("x-search-") || !entry.name.endsWith(".json")) continue;
  const stat = await Deno.stat(`logs/${entry.name}`);
  files.push({ name: entry.name, mtime: stat.mtime?.getTime() ?? 0 });
}
files.sort((a, b) => b.mtime - a.mtime);
const doc = JSON.parse(await Deno.readTextFile(`logs/${files[0].name}`));
const real: Item[] = (doc.posts ?? [])
  .map((p: { ref?: string; text?: string }) => {
    const id = String(p.ref ?? "").match(/\/status\/(\d+)/)?.[1] ?? "";
    const text = String(p.text ?? "").trim();
    return id && text ? { id, title: text.split("\n")[0], content: text } : null;
  })
  .filter(Boolean)
  .slice(0, 30);

const realRanked = real.map((item, index) => ({ id: item.id, score: 100 - index }));
const realResult = dedupeContents(realRanked, real as never);
console.log(
  `真实数据（${files[0].name}）: 输入 ${real.length} → 保留 ${realResult.kept.length}，合并 ${realResult.dropped.length}`,
);
console.log("  合并明细:", JSON.stringify(realResult.dropped));

// ---------- 2. 构造用例：明确的重复必须被合并 ----------
const longText =
  "生成式引擎优化（GEO）正在改变搜索流量的分配方式：内容要先被大模型引用，才可能被用户看到。" +
  "这篇文章拆解了品牌在 ChatGPT、豆包等生成式引擎里的可见性来源与常见误区。";
const fixtures: Item[] = [
  { id: "A", title: "GEO 入门", content: longText, url: "https://example.com/geo" },
  // 同 URL
  { id: "B", title: "GEO 入门（转发）", content: "换个说法讲讲 GEO 的价值。", url: "https://example.com/geo" },
  // 同正文
  { id: "C", title: "作者 C 转载", content: longText, url: "https://c.com/1" },
  // 同标题
  { id: "D", title: "GEO 入门", content: "完全不同的角度：从 SEO 的失败经验倒推 GEO。", url: "https://d.com/1" },
  // 高度相似（在长文后追加一句）
  { id: "E", title: "GEN 摘要", content: `${longText} 更多案例见文末。`, url: "https://e.com/1" },
  // 完整包含
  { id: "F", title: "引用版", content: `${longText}`, url: "https://f.com/1" },
  // 真正不同的内容（不该被合并）
  { id: "G", title: "无关内容", content: "今天研究了 LLM 推理引擎的批处理调度，和内容营销无关。", url: "https://g.com/1" },
  { id: "H", title: "另一个话题", content: "本地部署向量库的选型对比：pgvector、Milvus、Qdrant。", url: "https://h.com/1" },
];
const fxRanked = fixtures.map((item, index) => ({ id: item.id, score: 100 - index }));
const fxResult = dedupeContents(fxRanked as never, fixtures as never);
console.log(`\n构造用例: 输入 ${fixtures.length} → 保留 ${fxResult.kept.length}`);
console.log("  保留:", fxResult.kept.map((r) => r.id).join(","));
fxResult.dropped.forEach((d) => console.log(`  合并 ${d.id} → ${d.duplicateOf}（${d.reason}${d.similarity ? " " + d.similarity : ""}）`));

const expectKept = ["A", "G", "H"];
const keptIds = fxResult.kept.map((r) => r.id);
const pass = expectKept.every((id) => keptIds.includes(id)) && fxResult.dropped.length === 5;
console.log(pass ? "\n✅ 构造用例符合预期（A/G/H 保留，5 条重复被合并）" : `\n❌ 不符合预期：保留 ${keptIds.join(",")}，期望含 ${expectKept.join(",")}`);
