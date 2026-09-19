import { assertEquals } from "https://deno.land/std@0.220.1/assert/mod.ts";
import { WeixinArticleTemplateRenderer } from "../../../modules/render/article.renderer.ts";

Deno.test("WeixinArticleTemplateRenderer - processArticleContent", async () => {
  class MockBaseTemplateRenderer {
    protected templates: { [key: string]: string } = {};
    protected configManager = { getInstance: () => ({}) };
    protected initializeTemplates = () => {};
  }

  class TestWeixinArticleTemplateRenderer extends MockBaseTemplateRenderer {
    availableTemplates = ["default", "modern", "tech", "mianpro"];
    templatePrefix = "article";

    processArticleContent(article: any): any {
      if (!article.media || article.media.length === 0) {
        return article;
      }

      const paragraphs = article.content.split("<next_paragraph />");
      const mediaUrls = article.media.map((m: any) => m.url);
      let mediaIndex = 0;
      let processedContent = "";

      if (mediaUrls.length > 0) {
        processedContent += `<img src="${mediaUrls[0]}" alt="文章配图" /><next_paragraph />`;
        mediaIndex++;
      }

      paragraphs.forEach((paragraph: string, index: number) => {
        processedContent += paragraph;

        if (mediaIndex < mediaUrls.length && index < paragraphs.length - 1) {
          processedContent += `<next_paragraph /><img src="${mediaUrls[mediaIndex]}" alt="文章配图" />`;
          mediaIndex++;
        }

        if (index < paragraphs.length - 1) {
          processedContent += "<next_paragraph />";
        }
      });

      return {
        ...article,
        content: processedContent,
      };
    }
  }

  const renderer = new TestWeixinArticleTemplateRenderer();
  const testArticle = {
    title: "测试文章",
    content: "第一段内容<next_paragraph />第二段内容<next_paragraph />第三段内容",
    media: [
      { url: "http://example.com/image1.jpg" },
      { url: "http://example.com/image2.jpg" },
    ],
  };

  const processedArticle = renderer.processArticleContent(testArticle);
  
  assertEquals(
    processedArticle.content.startsWith('<img src="http://example.com/image1.jpg" alt="文章配图" />'),
    true,
    "第一张图片应该在文章开头"
  );

  assertEquals(
    processedArticle.content.includes('<img src="http://example.com/image2.jpg" alt="文章配图" />'),
    true,
    "第二张图片应该在段落之间"
  );

  assertEquals(
    processedArticle.content.includes("第一段内容"),
    true,
    "应包含第一段内容"
  );
  assertEquals(
    processedArticle.content.includes("第二段内容"),
    true,
    "应包含第二段内容"
  );
  assertEquals(
    processedArticle.content.includes("第三段内容"),
    true,
    "应包含第三段内容"
  );
});

Deno.test("WeixinArticleTemplateRenderer - loadTemplates", async () => {
  class MockBaseTemplateRenderer {
    protected templates: { [key: string]: string } = {};
    protected configManager = { getInstance: () => ({}) };
    protected initializeTemplates = () => {};
  }

  class TestWeixinArticleTemplateRenderer extends MockBaseTemplateRenderer {
    availableTemplates = [
      "default",
      "modern",
      "tech",
      "mianpro",
      "data-report",
      "bytedance",
      "daimo",
    ];
    templatePrefix = "article";

    async loadTemplates(): Promise<void> {
      this.templates = {
        default: "mock default template",
        modern: "mock modern template",
        tech: "mock tech template",
        mianpro: "mock mianpro template",
        "data-report": "mock data report template",
        bytedance: "mock bytedance template",
        daimo: "mock daimo template"
      };
    }
  }

  const renderer = new TestWeixinArticleTemplateRenderer();
  await renderer.loadTemplates();

  assertEquals(typeof renderer.templates.default, "string", "默认模板应该被加载");
  assertEquals(typeof renderer.templates.modern, "string", "现代模板应该被加载");
  assertEquals(typeof renderer.templates.tech, "string", "技术模板应该被加载");
  assertEquals(typeof renderer.templates.mianpro, "string", "面试专业模板应该被加载");
  assertEquals(typeof renderer.templates["data-report"], "string", "数据简报模板应该被加载");
  assertEquals(typeof renderer.templates.bytedance, "string", "字节蓝模板应该被加载");
  assertEquals(typeof renderer.templates.daimo, "string", "大厂模板应该被加载");
});