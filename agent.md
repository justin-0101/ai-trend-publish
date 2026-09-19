# ai-trend-publish 项目说明

> 面向后续维护 Agent 的速查文档。本文基于当前本地代码结构整理，不包含 `.env` 中的真实密钥。

## 1. 项目定位

`ai-trend-publish` 是一个基于 **Deno + TypeScript** 的 AI 趋势内容采集、加工和微信公众号发布系统。

核心目标：

1. 从多类数据源采集 AI 相关信息；
2. 调用大模型做内容筛选、摘要、标题生成；
3. 使用 EJS 模板渲染微信公众号 HTML；
4. 生成或上传封面图；
5. 发布到微信公众号草稿箱，或保存为本地草稿供人工编辑。

当前主要服务三类内容：

- AI 资讯聚合文章：`WeixinArticleWorkflow`
- AI 模型榜单文章：`WeixinAIBenchWorkflow`
- HelloGitHub AI 开源项目推荐：`WeixinHelloGithubWorkflow`

## 2. 技术栈

- 运行时：Deno v2+
- 语言：TypeScript
- Web 服务：`Deno.serve`
- 定时任务：`Deno.cron`
- 数据库：MySQL + Drizzle ORM
- 模板：EJS
- AI 接口：OpenAI 兼容接口、DeepSeek、Qwen、Together、Custom、讯飞
- 数据源：FireCrawl、Twitter/X、HelloGitHub、LiveBench、GitHub API
- 发布端：微信公众号草稿 API
- 通知：Bark、钉钉
- 图片生成：阿里云 DashScope / 通义万相相关封装

## 3. 重要目录

```text
.
├─ src/
│  ├─ index.ts                         # 当前 Web 控制台入口，启动 UI/API/定时任务
│  ├─ main.ts                          # 较老的 CLI 入口 TrendPublisher
│  ├─ controllers/cron.ts              # 每日 03:00 定时工作流
│  ├─ services/                        # 三个核心微信工作流
│  │  ├─ weixin-article.workflow.ts
│  │  ├─ weixin-aibench.workflow.ts
│  │  └─ weixin-hellogithub.workflow.ts
│  ├─ modules/
│  │  ├─ scrapers/                     # FireCrawl、Twitter、HelloGitHub 抓取
│  │  ├─ content-rank/                 # AI 内容评分排序
│  │  ├─ summarizer/                   # AI 摘要和标题生成
│  │  ├─ render/                       # 微信模板渲染
│  │  ├─ publishers/                   # 微信等发布器
│  │  └─ notify/                       # Bark / DingTalk 通知
│  ├─ providers/
│  │  ├─ llm/                          # LLM Provider 工厂
│  │  └─ image-gen/                    # 图片生成器
│  ├─ utils/                           # 配置、HTTP、日志、重试、调度等
│  └─ works/                           # 自定义 Workflow 执行框架
├─ docs/                               # Web 控制台静态页面
├─ templates/article/                  # 文章模板 default/modern/tech/mianpro
├─ drizzle/                            # Drizzle schema / migration 记录
├─ logs/                               # 运行日志、本地 UI 配置、本地草稿
├─ output/                             # 模板预览导出结果
├─ publish-file.ts                     # 发布本地 HTML 文件到微信草稿
├─ publish-with-images.ts              # 处理文章图片后发布
├─ deno.json                           # Deno 任务和 import 配置
├─ .env.example                        # 环境变量示例
└─ ENV_CONFIGURATION.md                # 环境变量说明
```

## 4. 启动方式

### 4.1 Web 控制台

当前 `deno.json` 中可用任务：

```bash
deno task start
```

实际执行：

```bash
deno run --watch --allow-env --allow-ffi --allow-read --allow-sys --allow-net --env src/index.ts --no-check
```

默认 UI 端口来自 `src/index.ts`：

```text
UI_PORT 环境变量；未配置时默认 8002
```

访问：

```text
http://localhost:8002
```

推荐启动（一键启动脚本）：

```powershell
.\start-web.ps1
```

双击 `start-web.bat` 等效。脚本会：定位 Deno → 解析端口 → 检查端口占用（若已是本服务，直接提示已在运行并打开浏览器）→ 启动 → 等就绪 → 打开浏览器；常用参数 `-Port 8010` / `-Dev` / `-NoBrowser` / `-Stop` / `-InstallDeno`。详见 `启动方式.txt`。

或使用 Deno task：

```powershell
deno task web
deno task production
deno task prod
```

### 4.2 测试/调试任务

```bash
deno task test
deno task test:simple
deno task test:publish
```

### 4.3 编译

```bash
deno task build:win
deno task build:mac-x64
deno task build:mac-arm64
deno task build:linux-x64
deno task build:linux-arm64
deno task build:all
```

## 5. Web API 概览

`src/index.ts` 启动静态页面和 API：

| 路径 | 方法 | 作用 |
|---|---:|---|
| `/api/overview` | GET | 获取 KPI、时间线、活动摘要 |
| `/api/workflows/run` | POST | 异步启动工作流，type 支持 `weixin-article` / `weixin-aibench` / `weixin-hellogithub` |
| `/api/workflows/status?jobId=...` | GET | 查询工作流状态 |
| `/api/drafts` | GET | 列出本地草稿，不返回 HTML 正文 |
| `/api/drafts/:id` | GET/PUT/DELETE | 获取、更新、删除草稿 |
| `/api/drafts/:id/publish` | POST | 将本地草稿发布到微信公众号草稿箱 |
| `/api/data-sources` | GET | 查看合并后的数据源 |
| `/api/data-source-rules` | GET/PUT | 获取或保存单个数据源过滤规则 |
| `/api/workflow-settings` | GET/PUT | 获取或保存 UI 工作流配置 |
| `/api/templates/preview` | POST | 生成模板预览 HTML |
| `/api/templates/export` | POST | 导出模板预览到 `output/` |
| `/api/templates/default` | POST | 设置默认文章模板 |

静态页面默认从 `docs/` 目录读取，根路径 `/` 会映射到 `docs/prototype.html`。

## 6. 三条主工作流

### 6.1 AI 资讯聚合：`WeixinArticleWorkflow`

文件：`src/services/weixin-article.workflow.ts`

流程：

1. 从 `getDataSources()` 获取 FireCrawl、Twitter、Twitter Cookie 数据源；
2. 根据 `sourceType` 选择数据源：`all` / `firecrawl` / `twitter` / `twitter-cookie`；
3. 抓取内容；
4. 按 `includeKeywords` / `excludeKeywords` 过滤；
5. 调用 `ContentRanker` 评分排序；
6. 取前 `maxArticles` 条，未传时读取 `ARTICLE_NUM`；
7. 调用 `AISummarizer` 做摘要、关键词、标题重写；
8. 生成总标题；
9. 调用图片生成器 `ALIWANX_POSTER` 生成封面；
10. 上传封面图片；
11. 用 `WeixinArticleTemplateRenderer` 渲染文章；
12. 根据 `publishMode` 决定保存草稿或发布。

参数示例：

```json
{
  "type": "weixin-article",
  "payload": {
    "sourceType": "all",
    "maxArticles": 10,
    "publishMode": "draft",
    "includeKeywords": ["agent", "AI"],
    "excludeKeywords": ["广告"]
  }
}
```

### 6.2 AI 模型榜单：`WeixinAIBenchWorkflow`

文件：`src/services/weixin-aibench.workflow.ts`

流程：

1. 从 LiveBench 拉取分类和 CSV 排行数据；
2. 对每个模型调用 Qwen 判断所属组织；
3. 计算各类平均分和全局平均分；
4. 找到第一名模型；
5. 渲染 AIBench 模板；
6. 用 `PDD920_LOGO` 生成封面；
7. 上传封面；
8. 保存草稿或发布。

注意：这个流程会对较多模型逐个调用 LLM，耗时和费用都可能较高。

### 6.3 HelloGitHub 推荐：`WeixinHelloGithubWorkflow`

文件：`src/services/weixin-hellogithub.workflow.ts`

流程：

1. 调用 HelloGitHub API 获取 AI 类热门项目；
2. 逐个抓取项目详情页；
3. 对 GitHub 仓库读取 README 并清理代码块；
4. 生成封面图；
5. 渲染 HelloGitHub 模板；
6. 保存草稿或发布。

参数示例：

```json
{
  "type": "weixin-hellogithub",
  "payload": {
    "maxItems": 20,
    "publishMode": "draft"
  }
}
```

## 7. 数据源机制

文件：`src/data-sources/getDataSources.ts`

默认内置数据源：

```ts
firecrawl: https://news.ycombinator.com/
twitter: https://x.com/OpenAIDevs
twitter-cookie: https://x.com/OpenAIDevs
github: GitHub AI 仓库搜索
hellogithub: HelloGitHub AI 分类
weixin: 微信素材 API
```

如果 `ENABLE_DB=true`，会额外读取 MySQL 表 `data_sources`，并与本地默认源合并去重。

表结构：

```sql
config(id, key, value)
data_sources(id, platform, identifier)
```

## 8. 配置系统

配置入口：`src/utils/config/config-manager.ts`

加载顺序：

1. `EnvConfigSource`：读取 `.env` / 环境变量；
2. 如果 `ENABLE_DB=true`，再加入 `DbConfigSource`。

常用环境变量见 `.env.example` 和 `ENV_CONFIGURATION.md`。

关键配置：

```text
# LLM
DEEPSEEK_BASE_URL
DEEPSEEK_API_KEY
DEEPSEEK_MODEL
QWEN_BASE_URL
QWEN_API_KEY
QWEN_MODEL
CUSTOM_LLM_BASE_URL
CUSTOM_LLM_API_KEY
CUSTOM_LLM_MODEL
DEFAULT_LLM_PROVIDER
AI_CONTENT_RANKER_LLM_PROVIDER
AI_SUMMARIZER_LLM_PROVIDER

# 微信公众号
WEIXIN_APP_ID
WEIXIN_APP_SECRET
WEIXIN_THUMB_MEDIA_ID
WEIXIN_THUMB_IMAGE_URL
AUTHOR

# 数据抓取
FIRE_CRAWL_API_KEY
X_API_KEY
X_API_BEARER_TOKEN
TWITTER_COOKIE
TWITTER_CSRF_TOKEN
TWITTER_WEB_BEARER_TOKEN
TWITTER_USER_BY_NAME_QUERY_ID
TWITTER_USER_TWEETS_QUERY_ID
GITHUB_TOKEN

# 图片生成
DASHSCOPE_API_KEY

# 数据库
ENABLE_DB
DB_HOST
DB_PORT
DB_USER
DB_PASSWORD
DB_DATABASE

# 通知
ENABLE_BARK
BARK_URL
ENABLE_DINGDING
DINGDING_WEBHOOK

# UI
UI_PORT
DISABLE_UI_SERVER
```

安全要求：不要把 `.env`、真实 Cookie、AppSecret、API Key 写入文档或提交到仓库。

## 9. 微信发布逻辑

文件：`src/modules/publishers/weixin.publisher.ts`

发布器当前行为：

1. 读取 `WEIXIN_APP_ID` / `WEIXIN_APP_SECRET`；
2. 获取 `access_token`；
3. 如有图片 URL，上传为微信图片；
4. 创建微信公众号草稿：`/cgi-bin/draft/add`；
5. 返回草稿 `media_id`，状态为 `draft`。

注意：当前代码是“生成微信草稿”，不是直接群发。

正确调用形式：

```ts
await publisher.publish(html, {
  title: "标题",
  author: "作者",
  thumbMediaId: "封面素材 media_id"
});
```

## 10. 模板系统

文章模板位置：

```text
templates/article/article.ejs
templates/article/article.modern.ejs
templates/article/article.tech.ejs
templates/article/article.mianpro.ejs
```

`WeixinArticleTemplateRenderer` 支持模板：

```text
default / modern / tech / mianpro
```

配置项：

```text
ARTICLE_TEMPLATE_TYPE=default|modern|tech|mianpro|random
HELLOGITHUB_TEMPLATE_TYPE=default|random
AIBENCH_TEMPLATE_TYPE=default|random
```

模板预览可通过 Web API 或 UI 生成，并导出到 `output/`。

## 11. 定时任务

文件：`src/controllers/cron.ts`

行为：

- 启动时调用 `startCronJobs()`；
- 如果当前 Deno 不支持 `Deno.cron`，会跳过；
- 注册每日凌晨 3 点任务；
- 按星期几读取配置键：`1_of_week_workflow` 到 `7_of_week_workflow`；
- 未配置时默认执行 `WeixinArticleWorkflow`。

配置值预期为枚举 key：

```text
WeixinArticle
WeixinAIBench
WeixinHelloGithub
```

## 12. 本地草稿机制

草稿文件：

```text
logs/drafts.json
```

当工作流参数为：

```json
{ "publishMode": "draft" }
```

工作流不会立即调用微信发布，而是把 `{ title, html, workflowType }` 写入本地草稿。之后可以通过 UI 或 API 修改、删除、发布。

## 13. 已发现的维护注意点

这些不是全部问题，只是当前阅读代码时看到的高优先级风险：

1. **网页版已补齐启动配置**  
   当前默认端口为 `8002`，可用 `start-web.ps1` / `start-web.bat` / `deno task web` / `deno task production` / `deno task prod` 启动。

2. **`cron.ts` 有疑似残留代码**  
   `getWorkflow()` 中出现 `WorkflowType.ToutiaoArticle` 和 `ToutiaoArticleWorkflow`，但当前枚举和 import 中没有对应定义。因为 `deno task start` 带 `--no-check`，可能运行时只有触发相关分支才暴露。

3. **微信发布参数存在调用不一致**  
   `WeixinPublisher.publish()` 定义第二个参数是 options 对象，但部分工作流使用了多参数调用，例如 `publish(html, title, title, mediaId)`。Deno 当前 `--no-check` 会放过，但运行时多余参数会被忽略，可能导致标题和封面没有按预期传入。

4. **环境变量命名不统一**  
   `.env.example` 有 `X_API_BEARER_TOKEN`，但 `TwitterScraper` 读取的是 `X_API_KEY`；Cookie 抓取又读取 `TWITTER_COOKIE` 等配置。调试 Twitter 抓取时要先确认实际代码读取的 key。

5. **数据库 migration 文件被整体注释**  
   `drizzle/0000_typical_stepford_cuckoos.sql` 中建表 SQL 在注释块内，不能直接当迁移执行。

6. **Dockerfile 会复制整个项目**  
   当前 Dockerfile `COPY . .`，如果 `.env` 存在，会被复制进镜像。生产构建前应处理 `.dockerignore` 和密钥注入方式。

7. **LiveBench 工作流可能非常慢**  
   `LiveBenchAPI` 会对模型逐个调用 LLM 查询组织归属，没有明显缓存。建议加缓存后再跑生产。

## 14. 建议的下一步改造顺序

如果要继续维护，建议按这个顺序：

1. 统一启动方式：补 `prod/production` task 或更新 `启动方式.txt`；
2. 修正 `WeixinPublisher.publish()` 调用，保证标题、作者、封面参数生效；
3. 清理 `cron.ts` 中的 Toutiao 残留；
4. 统一 Twitter 配置 key；
5. 给 `.env`、`logs/`、`.vs/`、`.deno/`、`trendFinder.exe` 等确认 `.gitignore`；
6. 为 LiveBench 组织归属查询加缓存；
7. 补一份最小可运行的 MySQL 初始化 SQL；
8. 给三个工作流分别补不依赖真实外部 API 的单元测试或 mock 测试。

## 15. Agent 操作约定

后续 Agent 维护本项目时请遵守：

1. 不读取、不输出 `.env` 中的真实密钥；
2. 不在未确认的情况下真实发布微信公众号文章；
3. 默认使用 `publishMode: "draft"` 做验证；
4. 涉及微信发布、群发、定时生产任务前，必须让用户确认；
5. 修改模板后，优先用 `/api/templates/preview` 或 `deno task build:docs` 做本地预览；
6. 修改工作流后，先用小参数跑：`maxArticles: 1` 或 `maxItems: 1`；
7. 不要依赖 `--no-check` 掩盖类型错误，核心变更后建议补一次 `deno check`。

## 16. 本次验证记录：内容抓取 + 文章生成

验证时间：2026-09-16

本次只测试两个安全环节：**内容抓取** 和 **文章 HTML 生成**。没有调用微信公众号发布接口。

### 16.1 内容抓取测试

测试对象：`HelloGithubScraper`

执行方式：使用本地 Deno 运行一个最小脚本，调用：

```ts
const hotItems = await scraper.getHotItems(1);
const detail = await scraper.getItemDetail(hotItems[0].itemId);
```

结果：成功。

关键输出：

```json
{
  "step": "hot-items",
  "ok": true,
  "count": 20,
  "first": {
    "itemId": "46fa894a7a8f4a51908e7b86a551e83e",
    "author": "virgiliojr94",
    "title": "把技术书变成智能体技能"
  }
}
```

详情抓取成功，首个项目为：

```json
{
  "name": "book-to-skill",
  "url": "https://github.com/virgiliojr94/book-to-skill",
  "language": "Python",
  "totalStars": 30783,
  "lastWeekStars": 1439,
  "readmeChars": 2000
}
```

### 16.2 文章生成测试

测试对象：`HelloGithubTemplateRenderer`

执行方式：抓取前 2 个 HelloGitHub 项目详情后渲染模板：

```ts
const renderer = new HelloGithubTemplateRenderer();
const html = await renderer.render(details);
await Deno.writeTextFile("output/test-agent-hellogithub-generation.html", html);
```

结果：成功。

输出文件：

```text
output/test-agent-hellogithub-generation.html
```

关键输出：

```json
{
  "step": "article-generation",
  "ok": true,
  "items": 2,
  "itemNames": ["book-to-skill", "dashi-ppt-skill"],
  "htmlChars": 14426,
  "hasHtmlTag": true,
  "hasFirstItemName": true,
  "hasRenderDate": true
}
```

注意：生成时出现过 `HELLOGITHUB_TEMPLATE_TYPE` 未配置提示，但 `BaseTemplateRenderer` 自动回退到默认模板，最终 HTML 正常生成。
