import { XSearchScraper } from "../src/modules/scrapers/x-search.scraper.ts";

const query = Deno.args[0] ?? "GEO优化";
const scraper = new XSearchScraper();
const t0 = Date.now();
const contents = await scraper.scrape(query);
console.log(`\n[结果] query=${query} 条数=${contents.length} 用时=${((Date.now()-t0)/1000).toFixed(1)}s`);
for (const c of contents.slice(0, 5)) {
  console.log(`- ${c.id} | ${c.publishDate} | @${c.metadata.username} | ♥${c.metadata.likes}`);
  console.log(`  ${c.title.slice(0, 70)}`);
  console.log(`  ${c.url}`);
}
if (contents.length === 0) { console.error("0 条 —— 需要排查"); Deno.exit(1); }
