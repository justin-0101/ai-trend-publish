import * as fs from "node:fs";
import * as ejs from "npm:ejs@3.1.9";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Article {
  title: string;
  content: string;
}

async function testArticleTemplates() {
  try {
    // 准备测试数据
    const testArticles: Article[] = [
      {
        title: "测试文章标题",
        content: `
          <h2>测试标题</h2>
          <p>这是一段测试内容，包含了<strong>加粗文本</strong>和<code>代码片段</code>。</p>
          <pre><code>function test() {
            console.log("Hello World");
          }</code></pre>
          <ul>
            <li>列表项 1</li>
            <li>列表项 2</li>
          </ul>
        `,
      },
    ];

    // 测试不同的模板
    const templateNames = [
      "article.ejs",
      "article.mianpro.ejs",
      "article.data-report.ejs",
      "article.bytedance.ejs",
      "article.daimo.ejs",
      "article.modern.ejs",
      "article.tech.ejs",
    ];

    for (const templateName of templateNames) {
      // 读取模板
      const templatePath = path.join(
        __dirname,
        "../../templates/article",
        templateName,
      );
      const template = fs.readFileSync(templatePath, "utf-8");

      // 渲染模板
      const html = ejs.render(template, { articles: testArticles });

      // 保存结果
      const outputPath = path.join(
        __dirname,
        `../../output/test-${templateName}.html`,
      );
      fs.writeFileSync(outputPath, html, "utf-8");

      console.log(`模板 ${templateName} 渲染成功！输出文件:`, outputPath);
    }
  } catch (error: any) {
    console.error("模板测试失败:", error.message);
  }
}

// 运行测试
testArticleTemplates();