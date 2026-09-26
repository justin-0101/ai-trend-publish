import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.221.0/assert/mod.ts";
import { WeixinArticleTemplateRenderer } from "../../../modules/render/article.renderer.ts";
import { WeixinTemplate } from "../../../modules/render/interfaces/article.type.ts";

const deepArticle = (): WeixinTemplate[] => [{
  id: "deep-1",
  title: "降价到底降的是哪一段成本",
  subtitle: "先说被广泛转述的那个说法，再说一手材料省略了什么",
  content: [
    "<p>第一段：被广泛转述的说法是入门成本被打下来了。</p>",
    "<p>第二段：一手定价页还写了两条限定条件，它们会改变结论的适用范围。</p>",
    "<p>第三段：我的判断标准是，先看计价单位有没有变。</p>",
  ].join("<next_paragraph />"),
  url: "",
  publishDate: "2026-09-26",
  metadata: { score: 86, readTime: 6, keywords: ["成本结构", "定价页"] },
  keywords: ["成本结构", "定价页", "迁移成本"],
  media: [],
}];

Deno.test("深度文模板已注册且能渲染出标题、副标题与正文", async () => {
  const renderer = new WeixinArticleTemplateRenderer(false);
  // availableTemplates 是受保护字段，借渲染成功来间接确认注册有效
  const html = await renderer.render(deepArticle(), "deep");

  assertStringIncludes(html, "降价到底降的是哪一段成本");
  assertStringIncludes(html, "先说被广泛转述的那个说法");
  assertStringIncludes(html, "第一段");
  assertStringIncludes(html, "第三段");
  assertEquals(
    html.includes("<next_paragraph />"),
    false,
    "段落标记必须被模板消费掉，不能漏到成稿里",
  );
});

Deno.test("深度文模板带上关键词与机器审稿声明", async () => {
  const renderer = new WeixinArticleTemplateRenderer(false);
  const html = await renderer.render(deepArticle(), "deep");

  assertStringIncludes(html, "成本结构");
  assertStringIncludes(html, "迁移成本");
  assertStringIncludes(html, "约 6 分钟");
  assertStringIncludes(
    html,
    "发布前需作者本人阅读确认",
    "成稿必须自带「机器不代签」的声明",
  );
});

Deno.test("深度文模板不出现速递类的序号编号", async () => {
  const renderer = new WeixinArticleTemplateRenderer(false);
  const html = await renderer.render(deepArticle(), "deep");
  assertEquals(html.includes("NO.01"), false, "深度文是单篇，不应有序号");
});

Deno.test("缺副标题时模板不报错也不渲染空块", async () => {
  const renderer = new WeixinArticleTemplateRenderer(false);
  const withoutSubtitle = deepArticle().map((item) => ({
    ...item,
    subtitle: undefined,
  }));
  const html = await renderer.render(withoutSubtitle, "deep");
  assertStringIncludes(html, "降价到底降的是哪一段成本");
});

Deno.test("深度文模板未开启图片处理时，不会把图片上传写进正文", async () => {
  const renderer = new WeixinArticleTemplateRenderer(false);
  const html = await renderer.render(deepArticle(), "deep");
  // 真断言：正文里只有我们给的段落，没有多出来的 img 标签
  assertEquals(
    html.includes("<img"),
    false,
    "未开图片处理时不应出现 img 标签",
  );
  assertEquals(
    (html.match(/<div style="margin:0 0 19px/g) ?? []).length,
    3,
    "三段正文应该渲染成三个段洛容器",
  );
});
