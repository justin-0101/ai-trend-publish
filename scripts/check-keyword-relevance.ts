/** 临时自检：验证 keywordTerms / prioritizeByKeywordRelevance 的真实行为（用真实采集数据）。 */
import {
  keywordTerms,
  prioritizeByKeywordRelevance,
} from "../src/services/weixin-article.workflow.ts";

const query = '"generative engine optimization" OR 生成式引擎优化';
const terms = keywordTerms([query]);
console.log("terms =", JSON.stringify(terms));

const doc = JSON.parse(
  await Deno.readTextFile("logs/x-search-generative-engine-optimization-or-20260921-232145.json"),
);
const posts: Array<{ ref?: string; text?: string }> = doc.posts ?? [];

// 复刻 XSearchScraper 的映射（id 取自 /status/<id>，title 取首行，content 取全文）
const extractId = (ref?: string) => String(ref ?? "").match(/\/status\/(\d+)/)?.[1] ?? null;
const contents = posts
  .map((p) => {
    const text = String(p.text ?? "").trim();
    const id = extractId(p.ref);
    return id && text
      ? { id, title: text.split("\n")[0].slice(0, 100), content: text }
      : null;
  })
  .filter(Boolean) as Array<{ id: string; title: string; content: string }>;
const usable = contents.slice(0, 30);

const ranked = usable.map((c, i) => ({ id: c.id, score: 100 - i }));
const out = prioritizeByKeywordRelevance(
  ranked as Array<{ id: string; score: number }>,
  usable as never,
  terms,
);

const hit = (c: { content: string }) =>
  terms.some((t) => c.content.toLowerCase().includes(t));
console.log(`入库 ${usable.length} 条 | 命中关键词 ${usable.filter(hit).length} 条`);
console.log("重排后前 5 条的命中情况:", out.slice(0, 5).map((r) => {
  const c = usable.find((x) => x.id === r.id);
  return `${hit(c!) ? "✅" : "❌"} ${c?.title.slice(0, 24)}`;
}));
console.log("重排后后 3 条的命中情况:", out.slice(-3).map((r) => {
  const c = usable.find((x) => x.id === r.id);
  return `${hit(c!) ? "✅" : "❌"} ${c?.title.slice(0, 24)}`;
}));
