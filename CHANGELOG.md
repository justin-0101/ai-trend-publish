# 更新日志

## [未发布] - 2026-09-20

### 封面图改为「AI 底图 + 本地字体重排」（解决 AI 直出中文乱码）

**问题**：原先封面由文生图模型直接生成整张图（包含标题文字）。实测智谱 cogview-4 渲染中文严重乱码——
「AI 三连炸」被画成「AI三连如人」，日期画成 2027/9/20，还凭空冒出「4P+」「#001IEF」等无意义字符。
根因：扩散模型把文字当**像素图案**画，不是排版，中文几乎必然出错。

另外智谱返回的 HTTP header 标 `image/png`，实际字节是 JPEG；且 1440×720 输出约 117KB，
超过微信 `thumb` 素材 64KB 的硬性上限。

**改法**：拆成两步，各用其所长。

1. 智谱 cogview-4 只负责生成**无文字**的科技感底图
   （prompt 明确要求 `no text, no letters, no words, no numbers, no logo, no signature`）
2. 标题由字体引擎（imagescript WASM 字体库）**本地渲染**后叠加 —— 100% 准确

**新增文件**

- `src/utils/image/cover-composer.ts`
  - `composeCover()`：背景（AI 底图 / 本地渐变）+ 三层中文标题 → 自适应暗底板 → 压缩到 <64KB JPEG
  - `splitCoverTitle()`：草稿标题拆三层
    （`2026/9/17 AI速递 | AI 三连炸：GPT-6 Astra 赋能 Devin，…` → 页脚 / 主标题 / 次标题）
  - 字号按可用宽度自动缩放；长标题按标点断行，不会把单词切成半截
  - 输出质量逐档下调（92→20），仍超 64KB 再按比例缩尺寸，确保符合微信 thumb 限制
  - 字体字节进程内缓存，同一进程只读一次磁盘
- `src/providers/image-gen/zhipu-cogview4.image.ts`
  - 智谱 `cogView-4-250304` 生成器（`0.06 元/张`），Bearer 鉴权，输出 1440×720
  - `buildTechCoverPrompt()`：只描述**底图**，明确禁止任何文字
- `assets/fonts/`：12 款中文字体（**全部 SIL OFL-1.1，可商用、可随软件分发**）
  - 用 `pyftsubset` 子集化为「通用规范汉字表 8105 字 + ASCII + 常用标点」
  - 体积 114.4MB → **34.0MB**；渲染耗时从最慢 221s 降到 **0.4–1.2s**
  - 来源、版本、子集化参数、合规说明见 `assets/fonts/README.md`

**改动文件**

- `src/providers/interfaces/image-gen.interface.ts`：新增 `ZHIPU_COGVIEW4` 类型与映射
- `src/providers/image-gen/image-generator-factory.ts`：新增 `ZHIPU_COGVIEW4` 分支
- `src/index.ts`：`publishDraftById` 封面三级降级
  1. 智谱底图 + 本地标题 → 上传
  2. 智谱失败 → 本地渐变底图 + 本地标题（标题依然正确，只是底图朴素）
  3. 连本地合成都失败 → 无封面出稿
- `ENV_CONFIGURATION.md`：补 `ZHIPU_API_KEY` 说明
- `.gitignore`：忽略字体构建中间目录 `.font-tmp/`、临时探针脚本、智谱 key 临时文件

**顺带修的 bug**

- `publishDraftById` 原先调用 `publisher.publish(draft.html)` **不传 title**，
  导致微信草稿标题落到默认值「每日AI趋势」、封面丢失。现已传 `{title, author, thumbMediaId}`。
- `DraftItem` 新增可选 `thumbMediaId` 字段，发布成功后写回 `logs/drafts.json`，同一条草稿二次发布不再重复扣费。

**水印处理**

智谱在底图右下角强制叠加圆角药丸水印「AI生成」（非 prompt 可控，服务域名里就带 `watermark`）。
实测水印包围盒：x 1308–1422 / y 663–712（1440×720 底图），**距下边仅 8px**。

因此 `composeCover()` 提供 `watermark` 参数（默认 `crop`）：

| 取值 | 做法 | 效果 |
|---|---|---|
| `crop`（默认） | 合成前从底图底部裁掉 64px 再铺满画布 | 水印彻底消失、无痕迹；代价是丢弃底部 8% 画面 |
| `footer` | 保留整图，底部压 13% 高的不透光页脚带（带青色装饰线 + 可自定义品牌文字） | 水印被盖住，顺带变成品牌位；代价是底部一条硬边 |
| `none` | 不处理 | 仅用于对比 |

相关可调参数：`watermarkCropPx`（默认 64）、`footerText`。

**已知限制**

- `watermark=crop` 会丢弃底图底部约 8% 画面（对城市/场景图影响很小，实测无可见劣化）
- 字体子集化只覆盖《通用规范汉字表》8105 字，表外生僻字会渲染为空白；扩容方法见 `assets/fonts/README.md`
- 本次只改 `publishDraftById`（手动「立即发布」路径）；
  `weixin-article` / `weixin-hellogithub` / `weixin-aibench` 三个工作流仍走 `ALIWANX_POSTER`，未接智谱

## [未发布] - 2026-09-17

### 封面图失败降级（不再让第三方图片服务拖垮工作流）

- 新增降级策略 `COVER_FALLBACK_MODE`（`src/utils/image/cover-fallback.ts`，可不配置，默认 `skip`）
  - `skip`：封面生成失败只告警（`[封面降级] ...`），继续出稿（无封面）
  - `placeholder`：失败时用本地生成的占位封面（`src/utils/image/placeholder-cover.ts`，纯 JS 生成渐变 PNG，无外部依赖/字体，不渲染文字）；占位也失败则退回 skip
  - `fail`：保持老行为，封面失败即失败（需要严格封面时用）
- 封面改为上传成**真正的草稿封面素材**：新增 `WeixinPublisher.uploadThumb(source)`（`material/add_material?type=thumb`，返回 `thumb_media_id`，同图进程内缓存）
  - 原先用 `uploadImage()`（`cgi-bin/media/uploadimg`）的返回值当封面是错的：那是正文图片 URL，不是 `thumb_media_id`
- 修掉 `publish` 参数传递错误（三个工作流都中招）
  - 原来写的是 `publish(html, title, thumbMediaId)` 这类位置参数，而 `publish` 只有 `(content, options?)`：字符串被当成 options → 草稿标题落到默认值「每日AI趋势」、生成好的封面被丢弃
  - 现在统一传 `{ title, thumbMediaId }`；`ContentPublisher.publish` 签名也从 `(...args: any[])` 收紧为 `options?: {...}`，以后再写错编译期就会报错
- 三个工作流的封面步骤都接入降级：`weixin-article`（generate-article 内）、`weixin-hellogithub`、`weixin-aibench`
- `src/utils/config/optional-config.ts`：新增可选配置读取（缺键不打 warn），`ai.summarizer.ts` 与封面降级共用

### 标题生成的 token 预算

- `src/modules/summarizer/ai.summarizer.ts`：标题生成 `max_tokens` 100 → 1200（可用 `AI_SUMMARIZER_TITLE_MAX_TOKENS` 配置，缺键/非法值静默回落）
  - 推理模型（如 `deepseek-reasoner`）会先把预算花在 reasoning token 上，100 会得到 `finish_reason=length` 且 content 为空
  - content 为空时的报错带上诊断：`未获取到有效的标题（finish_reason=length, reasoning_tokens=100, max_tokens=100）`

### 工作流运行详情（补上设计里缺失的「详情抽屉」）

- 后端运行记录升级（`src/index.ts`）
  - `WorkflowJob` 增加 `payload`（本次运行参数）、`steps[]`（每步的状态/耗时/重试次数/错误/结果预览）、`error{message,stack}`、`logs[]`（本次运行期间的 console 输出，保留最后 200 行 / 32KB）、`drafts[]`（运行期间写出的草稿）
  - 运行记录落盘到 `logs/workflow-jobs.json`（保留最近 50 条，原子写）；启动时回读，`/api/workflows/status` 内存未命中时回查落盘，服务重启后「查看」仍可用
  - 工作流运行期间接管 `console` 把输出归到对应 job（并发时归到各运行中 job，结束后恢复），并剔除日志里的 ANSI 颜色码
- 步骤级记录（`src/works/workflow.ts`）
  - `WorkflowStep.do` 增加可选观察者 `addWorkflowStepObserver`，三个工作流自动获得步骤轨迹；未注册时零行为变化，观察者抛错不影响主流程
- 前端运行详情（`docs/workflows.html`）
  - 「查看」除了切换运行状态面板，还会打开右侧详情抽屉：概览 / 步骤时间线 / 失败详情（message + stack）/ 参数 / 日志 / 产出（草稿）
  - 抽屉支持刷新、关闭按钮、Esc、点遮罩关闭；任务还在跑时每 2s 自动刷新
  - 修掉幽灵「运行中」：近期记录里非当前轮询的行会定期回查状态，404 则标为失败（任务记录不存在）

### 模板库预览

- `docs/templates.html` 模板库新增预览能力
  - 每张模板卡片新增「预览」按钮（弹层内渲染，内置模板按各自 workflow 请求 `/api/templates/preview`，自定义模板直接渲染本地 HTML）
  - 编辑区新增「模板预览」按钮（位于「保存修改」左侧），可直接预览 textarea 里未保存的修改
  - 预览弹层支持刷新预览 / 关闭 / 点遮罩 / Esc，并加了 350ms 防误关（避免双击第二次点击落在遮罩上直接关闭）

### 一键启动脚本

- 重写 `start-web.ps1` / `start-web.bat`
  - 自动定位 Deno（项目内 `.deno` → 用户级安装 → PATH → winget 目录），缺失时给安装指引或 `-InstallDeno` 自动装
  - 端口解析优先级 `-Port` > `UI_PORT` 环境变量 > `.env` > 8002；端口被占用时自动换空闲端口
  - 启动后等待服务就绪并自动打开浏览器（`-NoBrowser` 可关）；若端口上已是本服务，直接提示已在运行并打开浏览器
  - 新增 `-Stop` 停止服务、`-Dev` 热重载
  - 本机探测绕过系统代理（`WebRequest` + `Proxy = $null`），避免 `HTTP_PROXY` 环境变量拖死 localhost 探测
- 新增 `start-web-hidden.vbs`：双击无 cmd 黑窗启动
  - VBS 用 `WshShell.Popup` 弹一个 3 秒后自动关闭的「Starting TrendPublish Web Console...」提示框（VBS 默认 ANSI 编码，中文文案会导致 Popup 构造失败，所以用纯英文），作为双击后的即时反馈
  - 然后 `WScript.Shell.Run` 第二参数 `0`（`SW_HIDE`）+ 第三参数 `False`（不阻塞 VBS）异步启动 BAT，绕过 BAT 自弹 cmd 窗口的限制
  - 启动成功的标志：浏览器自动打开 http://localhost:8002/；启动失败由 BAT 末尾的 MessageBox 弹到屏幕上兜底
  - 服务输出仍写 `logs\server.log`，浏览器自动打开
- 修 `start-web-hidden.vbs` 双击无反应的 bug
  - 原 `shell.Run """" & batPath & """", 0, False` 用 4 个 `"` 包裹路径，VBS 解析后实际是 `"path"`，shell.Run 把带引号的字符串当作可执行文件名传给 `CreateProcess`，系统找不到指定文件 → VBS 异常中断 → 用户双击后「Popup 看不到」是因为脚本在 Popup 之前就抛错了
  - 改为 `shell.Run batPath, 0, False`（项目路径 `F:\个人项目管理\ai-trend-publish\` 无空格，无需引号）
  - batPath 计算从 `Replace(..., ".vbs", ".bat")` 改为 `Replace(..., "start-web-hidden.vbs", "start-web.bat")`，避免产出不存在的中间名
  - VBS 文件保存为 **UTF-16 LE + BOM**（`FF FE`）：VBS 默认 ANSI 解析会让 `WScript.ScriptFullName` 里的中文路径变成乱码字节，`fso.FileExists` / `shell.Run` 都找不到文件；UTF-16 LE + BOM 让 wscript 按 Unicode 解析整个脚本，中文路径正确处理
- `start-web.bat` 末尾 `pause` 改为默认行为「成功无感退出 / 失败弹系统通知框」
  - 成功：`exit /b 0`，cmd 窗口立即关闭（无感）
  - 失败：用 `System.Windows.Forms.MessageBox` 弹错误码 + 指向 `logs\server.log`；退出码透传给 vbs 入口
  - 与 `start-web-hidden.vbs` 协同：vbs 隐藏窗口启动 BAT 后，失败仍能通过 MessageBox 弹窗提示

## [1.0.2] - 2024-03-11

### 内容排名和工作流优化

- 优化内容排名系统
  - 更新内容排名提示词，调整评分权重
  - 在用户提示中添加图片URL日志记录
  - 改进ID解析机制，提升内容排名结果的一致性
- 增强微信工作流程
  - 添加内容过滤功能
  - 实现动态文章数量配置
  - 增加调试日志记录
  - 优化内容处理的错误处理机制

### 文章渲染和图片处理增强

- 改进文章模板渲染系统
  - 新增`processArticleContent`方法，支持段落间自动插入图片
  - 更新基础模板渲染器，支持数据预处理
  - 优化文章模板，移除默认文本缩进
  - 重命名`ArticleTemplateRenderer`为`WeixinArticleTemplateRenderer`
- 微信图片处理优化
  - 实现`uploadContentImage`方法，支持微信图片上传
  - 重构`WeixinImageProcessor`，改进图片处理方法

### Twitter爬虫增强

- 增加媒体内容支持
  - 添加Media和Size接口定义
  - 实现推文媒体内容提取
  - 支持引用推文的内容和媒体提取
- 性能优化
  - 将推文获取限制从10条增加到20条
  - 改进错误日志记录
  - 优化配置刷新机制

### 配置管理

- 新增文章数量环境变量配置
  - 在.env.example中添加ARTICLE_NUM配置项
  - 更新README.md文档，添加相关配置说明

### 依赖更新

- 升级axios至1.8.2版本
- 更新npm源配置，优化包管理
- 移除husky包依赖

### 类型系统优化

- 重构模板类型定义
  - 将`template.type.ts`重命名为`article.type.ts`
  - 新增`GeneratedTemplate`和`WeixinTemplate`接口
  - 更新相关文件的导入路径

### 文档更新

- 更新环境变量配置说明
- 完善README文档

## [1.0.0] - 2024-03-05

### 架构优化

- 重构LLM工厂模式，提升代码复用性和可维护性
  - 实现统一的LLM提供者接口，支持多种AI服务商
  - 优化模型切换机制，支持动态指定模型名称
  - 增强错误处理和重试机制

- 增强模型配置灵活性
  - 多模型配置支持：可在配置中为同一提供商定义多个可用模型
    - 使用竖线分隔多个模型名称，例如：`DEEPSEEK_MODEL="deepseek-chat|deepseek-reasoner"`
    - 默认使用列表中的第一个模型
  - 指定特定模型支持：可在使用LLM提供商时指定特定模型
    - 使用格式：`提供商:模型名称`，例如：`DEEPSEEK:deepseek-reasoner`
    - 适用于所有支持指定模型的配置项

- LLM工厂类技术改进
  - 重构getLLMProvider方法，支持解析`PROVIDER:model`格式的配置
  - 优化提供商缓存机制，使用`PROVIDER:model`作为缓存键
  - 添加配置字符串解析方法

- OpenAI兼容LLM类增强
  - 添加多模型支持和管理
  - 新增模型选择和查询方法：
    - `setModel(model: string)`：设置当前使用的模型
    - `getModel()`：获取当前使用的模型
    - `getAvailableModels()`：获取所有可用模型列表
  - 支持在请求时通过options指定模型

### 功能增强

- 优化AISummarizer模块
  - 重构摘要生成接口，支持自定义语言和长度
  - 增加JSON格式响应支持，提升数据处理效率
  - 完善错误处理机制，提供更详细的错误信息

- 改进ContentRanker模块
  - 优化内容排名算法，提升准确性
  - 支持自定义排名规则和权重
  - 增加批量处理能力

### 工具类优化

- 封装RetryUtil工具类
  - 实现统一的重试机制，支持自定义重试策略
  - 添加指数退避算法，优化重试间隔
  - 提供详细的重试日志，便于问题排查

### 配置管理

- 重构环境变量配置
  - 优化配置项结构，提升可维护性
  - 支持多环境配置，便于开发和部署
  - 完善配置文档，提供详细的配置说明

### 其他改进

- 优化项目目录结构，提升代码组织性
- 更新依赖包版本，修复潜在安全问题
- 完善错误处理机制，提供更友好的错误提示
- 增加单元测试覆盖率，提升代码质量

### 文档更新

- 更新环境变量配置文档
- 完善API接口文档
- 添加开发指南和最佳实践

### 依赖更新

- 升级sharp至0.33.5
- 升级mysql2至3.12.0
- 升级typeorm至0.3.20
- 升级其他依赖包到最新稳定版本
