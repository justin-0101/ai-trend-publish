# 更新日志

## [未发布] - 2026-09-26

### X 搜索优先展开 X Article

- 搜索结果识别 X Article，并在截断与深度文素材限额前优先保留。
- 搜索卡片未暴露文章链接时，按 `/status/ID` → `/article/ID` 探测。
- 读取 `twitterArticleRichTextView` / `longformRichTextComponent`，把文章全文回填到素材。
- 原始 JSON 增加 `isArticle`、`articleFetched`、`articleTitle` 字段，避免把搜索摘要误当全文。

### 新增深度文工作流：从时效窗口内素材里选一个主题，按写作 skill 出稿

#### 起因

原有的三条链路都是「合集」形态：文章工作流出 10 条摘要、HelloGitHub
出项目卡片、AI Bench 出榜单。 缺一条能出**单篇成文**的链路。已有的写作 skill
`write-ai-wechat-article`（13 步专家系统、 2500 行
references）没法直接塞进工作流，因为有三处硬冲突：

1. **四领域是封闭集**（家庭教育／人生职业／认知升级／AI
   工具），而每天抓到的是行业素材， 按 skill 规则会被判「四个领域都不匹配」→
   天天空转；
2. **材料门槛要求作者亲历**（家长对话、决策代价、测试环境），而自动化没有亲历，
   且 skill 明文禁止把公开故事写成自己的经历；
3. **发布硬门槛把「作者本人阅读反馈」放在量表之上**，自动化在定义上就无法通过「可发布」。

#### 定了什么

| 冲突     | 处理                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺领域   | skill 新增**第五领域「AI 行业与技术观察」**（含材料门槛、写作链路、可用机制、结尾禁区）                                                              |
| 没亲历   | 新增 **`references/observer-stance.md`**：固定观察者评论位，作者性来自判断位置、取舍标准、边界承认、可复用观察标准；不虚构亲历                       |
| 不能代签 | 发布状态分两级：`机器达标`（总分≥80 且 材料/观点机制/作者性 各≥12）与 `作者已确认`；自动化**只敢声明前者**，成稿自带「发布前需作者本人阅读确认」声明 |

#### 改了什么

| 位置                                                                        | 改动                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `references/content-lanes.md`、`SKILL.md`                                   | 四领域 → 五领域；新增 `topic-package.md`（多条素材→主题包→爆款评分）、`privacy-redaction.md`（隐私红线）                                                                              |
| `references/skill-step-map.json`（新增）                                    | **步骤→reference 映射外置**：工作流按步注入片段，不整包读 2498 行；skill 迭代改 JSON，不动 TS                                                                                         |
| `modules/deep-article/skill-loader.ts`                                      | 定位 skill 根、读步骤表、按区域抽 markdown 章节、按段落边界截断；每步强制注入隐私与观察者位两条红线                                                                                   |
| `modules/deep-article/step-runner.ts`                                       | 装配 system 段 → 调 LLM（`response_format: json_object`）→ 宽松解析；`DeepArticleRunnerLike` 结构接口留出测试接缝                                                                     |
| `services/topic-cluster.ts`                                                 | 主题包聚类 + 爆款评分；**分值代码夹取、总分代码相加、硬淘汰代码执行**；防幻觉剔除不存在的素材 id；发现「整簇素材未被聚类」；单素材主题必须有可抓取的补料入口（素材 URL 或正文内链接），但该入口不自动等于一手来源 |
| `modules/deep-article/material-date.ts`、`services/deep-article-collect.ts` | 素材统一按 `publishDate` 做 180 天时效过滤；日期缺失保留但单列；`00-素材清单.md` 逐条审计保留、过期与去重结果                                                                         |
| `modules/deep-article/source-link.ts`                                       | 从真实素材中提取、去重和筛选补料链接；排除 X/微博等社交平台及静态资源，不采信模型编造的 URL                                                                                           |
| `services/author-context.ts`                                                | 只读加载 `E:\agent_person_txt\` 与档案目录，**先脱敏再注入**，带文件数/字数上限，路径不存在降级不报错；新增**记忆包本地摘要**（见下）                                                 |
| `services/privacy-guard.ts`、`modules/deep-article/privacy.ts`              | 隐私闸门：代码层模式匹配（需第一人称/关系词锚点，公开机构名不误拦）+ 名单来源接本地推送守卫名单                                                                                       |
| `modules/deep-article/review-gate.ts`                                       | 量表闸门：总分与关键三项下限，硬门槛失败即停止评分                                                                                                                                    |
| `services/weixin-deep-article.workflow.ts`、`modules/scrapers/fireCrawl.scraper.ts` | 13 个 LLM 步骤 + 17 份编号中间产物落盘 `output/deep-article-*/`；`material-gap` 先用专用 `scrapePage()` 读取最多 3 个候选页，再让模型看原文做来源资格与充分度判断；只有和真实 URL 对账一致、判为一手且可用的补料才进入证据锁定、作者立场、研究包和起草；缺少 `scrapePage` 时失败关闭，不回退“今日新闻列表”提取 |
| `templates/article/article.deep.ejs`                                        | 单篇长文模板（无序号、带副标题与机器审稿声明）                                                                                                                                        |
| `controllers/cron.ts`、`src/index.ts`、`docs/workflows.html`                | 注册进定时任务、API 与 Web 控制台（含模板预览）                                                                                                                                       |

#### 记忆包：本地摘要后送

需求是「只送认知、观点、价值观、原则」而不要把事实性内容送出去。实作用**确定性章节筛选**，
不用 LLM
摘要：只有标题命中允许清单的章节才会进摘要，所以送出去了什么可以逐字审计，
也不存在模型把隐私事实改写进摘要的路径。三个刻意选择：

1. **默认全不放行**：漏写一条 deny 不会导致误送——这是刻意选的失败方向；
2. **deny 优先于 allow**；
3. **路径不存在就降级为「本次无记忆包」**，绝不回退到整包送。

实测真实记忆包（265 行）：**采用 16 节 3737
字**（世界观人生观、稳定优势、全链路观、商务判断特点、
职业决策默认原则、决策十问、验证顺序、三种声音、底色、文章骨架 7
步、语言偏好、价值冲突默认排序、 九类认知风险模式…），**挡住 19
节**（时间线、家庭与现状、MBTI、项目评分表、副业定位、权限边界、来源…），
事实性关键词漏检为零。

另外修了两处泄漏：章节标题带姓名（「某某 · Agent
记忆包」）会被写进审计文件——已对审计元数据做词表脱敏；
送给模型的语料块从绝对路径改成了匿名编号（`作者材料-1`），真实路径只留在本地审计里。

#### 两个是靠真跑才发现的

**1. 模型会自创领域名。** 单步冒烟（3 条合成素材）时模型返回「AI
模型服务与商业化」 「模型评测与选型」——按字面比对，3
个主题包全被硬淘汰，工作流空转。
修了两处：提示词里列出五个领域名要求逐字取值；**未知领域名不再在本步淘汰**，
原样带出交由 `lane-routing`
裁决（那一步手上有完整领域规则，确实能判定「五个都不匹配」）。

**2. `workflow.ts` 的 `executeWithTimeout` 从不清理定时器。** 每个 `step.do`
都留下 一个最长 30 分钟的挂起 timer，十几个步骤既拖住事件循环退出、也让测试报
leaks。 已在 `finally` 里 `clearTimeout`（对既有工作流同为修复）。

#### reviewer 评审与修复

改完后调 `reviewer` 独立评审（无 P0，verdict：「修完 P1 再合并」）。已修：

| 档 | 问题                                                                                                     | 修法                                                                                 |
| -- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P1 | 第三轮审稿的 `privacyHits` 非数组时 `.map` 抛 TypeError，而此时**正文已生成、草稿未落**，一稿丢尽        | `asArray` 收口 + 异常路径补偿落盘                                                    |
| P1 | 模型层隐私命中只写进报告、不进发布判据（代码层故意收窄了机构名识别，漏掉的只有它有信号）                 | `reconcileLlmPrivacyHits`：命中文本**确实出现在正文里**才计入拦截；幻觉命中忽略      |
| P1 | `toText` 把对象 `String()` 成 `"[object Object]"`，非空，于是坏稿静默走到归档                            | `toText` 只接受基元；新增 `asRecord`/`asArray`/`hasContent` 在步骤边界统一收口 11 处 |
| P2 | 非终止错误不落盘，第 7 步挂了前 6 张卡跟着丢                                                             | `catch` 里补偿落盘（且只落一次）                                                     |
| P2 | `extractMarkdownSection` 命中非标题行时返回「到文件末尾」而非 `null`                                     | `startLevel === 0` 返回 `null`                                                       |
| P2 | 中间卡返回 `{}` 时静默跑完打分与发布                                                                     | `checkCard`：证据表/立论为空即终止，其余告警                                         |
| P2 | 模型写 `<next_paragraph/>`（无空格）时 2000 字渲染成一个大 div，无告警                                   | `normalizeParagraphMarkers` 归一化后渲染/归档                                        |
| P2 | 发布步骤带重试，而 `publish()` 用返回值报错不抛异常，能重试的只有「请求可能已落地」的时刻 → 可能重复推送 | `retries.limit: 0`                                                                   |
| P2 | cron 触发时 payload 为空，默认 `x-search` 必因缺关键词终止                                               | 默认改 `all`；未接 `draftWriter` 时把成稿 HTML 落到 `16-草稿.html`                   |
| P2 | 记忆包路径（含姓名拼音）原样进审计与日志                                                                 | `redactTerms` 扩展到审计元数据与日志                                                 |
| P2 | 三条永远通过的断言（领域互不串链路、`WeixinImageProcessor`、`newestRunDir` 回退取历史目录）              | 改为真断言；`newestRunDir` 没新建就报错                                              |

另修了两处自己引入的缺陷：终止分支已落盘后 `catch` 又补写一遍；测试复制造型使
`BaseTemplateRenderer` 的构造期读文件被 Deno 判成
leak（改为全文件复用同一渲染器实例）。

还顺手堵了一个被本次改动放大的既有注入面：`docs/publish.html` 用 `innerHTML`
渲染草稿标题（标题现在是「素材 → LLM → 标题」的产物），并且回显草稿 HTML
时不清理标签。已改为标题转义 + id 编码，并对回显 HTML
做最小清理（不是完整消毒器，真正稳的做法是 preview 放 sandbox iframe）。

#### 首次真跑（2026-09-26，483s，12 步全过）

`sourceType: "all"`、`publish: false`。链路完整跑通，**闸门拦住了稿子**（76/100，“材料与具体性”
11 < 12，未达标）——
这是设计预期：不为一份薄材料的稿子背书。正文本身质量尚可（观察者位成立、无虚构亲历、三间判断标准可复用），
但这次真跑暴露了真正的瓶颈，不在本工作流，而在**输入深度**：

| 现象                                 | 根源                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **21 个主题包全部是「素材 1 条」**   | twitterapi.io 欠费(402) → 回退到单账号 syndication 时间线，一条推文就是一个事件，聚类退化成 1:1 |
| 21 个主题包**全部路由到「AI 工具」** | 素材全是工具公告；而该链路的材料门槛要求“测试环境/目标/失败/修改/验证”                          |
| 「素材充分」单条未核验推文给了 14/20 | 打分只问“素材多不多”，没问“该领域的材料门槛能不能满足”                                          |

结果：工具链路 + 单条推文 ⇒ **结构性地永远卡在材料分**，跑 8
分钟只为得到一篇注定被拦的稿。

**我的实现还漏了 skill 的第 5
步（判断素材缺口并定向检索）**：该步正是为了把“一条公告”补成“能支撑机制判断的材料”（去抓官方文档、原始评测、多源报道）。没有它，新闻类素材撑不起
skill 的材料门槛。这是缺口，不是调参问题。

#### 真跑发现并修掉的缺陷

| 问题                                          | 修法                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **去重失效**：日志写“保留 21”，实际送出 41 条 | 根因：同一条推文被两个源各抽一次，`id` 取的就是 url，重复项的 id 与代表项相同；而我是**按 id 过滤存活项**，于是重复项全被捞回。改为按位置去重的 `dedupeScrapedContents`（`content-dedup.ts` 新增 `keyByIndex` 选项，默认行为不变），并加了 8 条回归测试——其中一条直接断言旧写法确实会失效 |
| `sourceType: "all"` 会把 x-search 也拉进来    | 与文章工作流统一：x-search 必须显式选，不混进“全量跑”                                                                                                                                                                                                                                     |

#### 验证

- `deno test src/test/modules/deep-article/`：**81
  项全过**（闸门／隐私／主题包／步骤装载／提示词预算／渲染／JSON
  与类型收口／记忆包摘要／编排 11 个场景）；
- 单步真实 LLM 冒烟：provider 解析 → JSON → 夹取 → 排序全链路通，并选中主题；
- 编排测试用桩 runner 覆盖 11 个场景：默认不发、作者性 11
  分拦住、硬门槛不进打分、隐私命中拦住、模型层命中对账拦/放、三条件齐备才发、领域不匹配不出稿、`privacyHits`
  非数组不崩、正文是对象不产生坏稿、中间卡为空即终止；
- 全项目类型错误 13 → **6**（剩下的全是既有的 `ToutiaoArticleWorkflow`
  未导入等问题，与本次无关）。

#### 没做的

- **没跑过完整真跑**：需要关键词搜索的浏览器采集、12 次 LLM
  调用与作者语料参与，要人工确认后再跑；
- 第五领域的链路是**新写的**，还没有一篇真实成稿检验过；
- 记忆包文件名含姓名拼音，会原样出现在 `output/deep-article-*/02-作者背景.md`
  的路径行里（该目录已 gitignore，但仍在本机磁盘上）。想一并隐去就把拼音加进
  `.prepush-blocklist.local.txt`；
- 依赖仓库外 skill 的两个测试文件在 skill 缺失时会整体失败（刻意不用 ignore
  静默跳过）；
- `cron.ts` 里 `WorkflowType.ToutiaoArticle` / `ToutiaoArticleWorkflow`
  未定义，任一星期被配成该类型就会在 `getWorkflow()` 抛
  ReferenceError（既有问题，未动）。

#### 第二次真跑（续跑 GEO 素材）发现并修掉的缺陷

这一轮的现场是：x-search 采到 30 条后浏览器桥瞬间中断，工作流整体失败。
把已落盘的原始 JSON 直接当采集结果续跑（不再碰 X），一路跑到 `material-gap`，
暴露了两个此前没被覆盖的缺陷。

| 问题 | 根因 | 修法 |
| --- | --- | --- |
| **8 个主题包全部硬淘汰**，理由是“没有可抓取的补料入口” | x.com 的 DOM `innerText` 会按显示宽度把 URL 拆成多行（`https://` + `github.com/x/y` + `ntent-writer`），链接提取器把它当成无效链接 | `source-link.ts` 新增 `unwrapLineWrappedUrls`：只拼接由纯 URL 字符构成的续行，遇中文/空行/列表标题立即停止（避免把下一条正文吞进地址）；3 条回归测试 |
| **模型把“今天”猜成 2026-05-07**，据此把 05-08 之后发布的合法素材判成“未来数据 → 不可用”，直接压低一手来源数 | 输入里没有任何时间基准，模型只能凭记忆推 | `topic-cluster.buildMaterialPayload` 与 `renderTopicBrief` 都注入代码生成的 `【当前日期】`，并为每条素材加“距当前 N 天”；skill 步骤表同步写明“时效判断只能以此为准，不得凭记忆推测今天是几号” |

#### 第二次真跑结果

- 全 13 步跑通：选中「315 后 GEO 服务商乱象与开源替代」（80 分，4 条素材），
  抓到 GitHub 仓库作为补料；
- 审稿闸门：**机器达标 84/100**，关键三项 16/18/15 均过 12 分下限；
- 隐私后检：代码层与模型层均 0 命中；
- **未发布**：`publish=false`，只落 18 份留档 + 本地草稿，成稿自带“需作者阅读确认”；
- 留下两个待作者处理的风险：多条素材同源却并列为“两条线”、
  关键开源仓库未给可落地地址。

#### 新增：X 短推文过滤（`DEEP_ARTICLE_MIN_TWEET_CHARS`）

起因：上面那篇成稿里，有一条「行业信号」其实是一句 **20 字的回复**
（「姚老师这个估计卷掉了很多商业化 geo 系统」）。它被聚进主题包、写进正文，
还带出了待核实的身份推断。X 按关键词召回的是整片时间线，里面本来就混着
大量一句半句的回复、转发、感叹和跨语言噪音。几十个字的推文既给不出事实与数字，
也撑不起机制判断，进主题包只会让「素材充分度」看起来比实际高。

| 项 | 决定 |
| --- | --- |
| 门槛 | 默认 **120 字**，`DEEP_ARTICLE_MIN_TWEET_CHARS` 可调 |
| 适用范围 | 只卡 X 系来源（`x-search` / `twitter` / `twitter-cookie` / `twitter-frontend`）；firecrawl 的文章页不受限 |
| 位置 | 去重与时效之后、条数上限**之前**（否则 20 字的回复会把长帖挤在截断线外） |
| 长度口径 | 正文**原始字符数**，不剔 URL、不剔空白 |
| 留档 | `00-素材清单.md` 新增「因过短被筛掉的 X 推文」段，逐条列出字数 |

口径为什么不去 URL：真跑里那条 2026-06-27 的直播资料帖原文 205 字，
剔掉三个 `doc.laoyao.cn` 链接后只剩 66 字，但它是三份文档的唯一入口，
正是补料要用的素材 —— 按「剔完剩多少字」判会误杀。

阈值取 120 的依据（关键词 GEO 的真实分布）：41 条里最短 20 字、中位数 138 字；
所有 7 条有分析价值的推文都在 **144–205 字**，取 120 能全部保住，
同时筛掉 18 条几十个字的噪音（41 → 23）。

已知边界：这条规则管不住「长但跑题」的推文（如把 GEO 当卫星云图、
日本二手回收、地缘政治用的同形异义帖）。那类靠主题包硬淘汰，
不靠长度门槛。


## [未发布] - 2026-09-26

### 选题相关度：排序纳入关键词，内容去重从 LLM 搬进代码

#### 起因（两个实测数字）

做「GEO（生成式引擎优化）」这个垂直选题时，采集回来 30 条里有 20 条与主题相关，
但**成稿 10 条只有 2 条在题上**，标题被带成「AI
大考期：制药、Web3、Agent…」。查下来两个原因：

1. **排序提示词里没有一个字说这次要什么主题** —— 它只按创新性/实用度/热度打分，
   「AI 制药跨越临床」「Web3 无限游戏」这类高热泛新闻稳定排前面；
2. **去重是让 LLM 顺手做的** —— 提示词写着「相似文章只保留分数最高的一篇」，
   实测 30 条输入只回来 17~29 条，而它认的「相似」里混着同主题、不同事件的内容。
   丢哪一条不可控，而且「关键词相关优先」在排序之后才起作用，条目在 LLM
   那步就没了的话， 后面再怎么排也救不回来。

#### 改了什么

| 位置                                        | 改动                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompts/content-ranker.prompt.ts`          | 排序带上本次选题关键词（直接讨论该主题的从 50 分起评、泛 AI 热点最高 40 分）；删掉「相似内容只保留一篇」，改为「对每一篇都要给分，一篇都不能少」                                               |
| `modules/content-rank/ai.content-ranker.ts` | `rankContents(contents, keywords?)` 透传关键词（可选参数，旧调用不变）                                                                                                                         |
| `services/content-dedup.ts`（新增）         | 去重改用代码：url / same-text / same-title / contained / 字符二元组包含度 ≥ 0.9                                                                                                                |
| `services/weixin-article.workflow.ts`       | 排序前把 LLM 漏评的条目按 0 分补在末尾（不补等于悄悄丢掉）；排序后先做「关键词命中优先」再做去重；新增 `[排序] LLM 漏评 N 条`、`[去重] 输入 N → 保留 M｜原因:id→id` 两条日志（0 合并也留一行） |

#### 去重阈值是量出来的，不是拍的

| 指标（X 搜索 30 条真实数据）         | 实测                               |
| ------------------------------------ | ---------------------------------- |
| char-4-gram Jaccard 上限             | 0.25（用不上）                     |
| 字符二元组包含度上限                 | 0.76，且那几对是「同主题、不同帖」 |
| 标题完全相同 / 正文完全相同 / 同 URL | 0 对 / 0 对 / 0 组                 |

短帖只要把阈值放低就会开始合并「同主题但内容不同」的帖子，所以定 0.9：
**宁可少合并，也不误删** ——
少合并只是文章里多一条同类内容，误合并是内容凭空消失。

#### 实测效果（x-search 源，`publishMode=draft`，未发布任何内容）

| 版本                                | 成稿 10 条主题命中           |
| ----------------------------------- | ---------------------------- |
| 改动前（纯热度排序）                | 2 / 10                       |
| 改动后（关键词入提示词 + 命中优先） | **10 / 10**（连跑 3 次复现） |

排序/去重日志（可直接在工作流详情里核对）：

```
[内容排序] 开始排序 30 条内容
[排序] 关键词相关优先：命中 14 条，未命中 16 条（检索词: generative engine optimization | 生成式引擎优化）
[去重] 输入 30 → 保留 29｜contained:2103385767037092279→1989365105549783235
```

补充一个反直觉发现：查询词加**中文引号**做精确短语会**反而失效** ——
`"生成式引擎优化"` 的原始精度只有 6%（返回一堆泛 AI 内容）， 改用
`"generative engine optimization" OR 生成式引擎优化` 后升到 82%。

#### 遗留

1. **语义级重复仍识别不了**：能合并的是字面重复/包含；同一事件被不同账号用完全不同措辞讲，
   字符指纹抓不到（要解决得上向量相似度）。
2. 阈值 0.9 按短帖定，长文源（FireCrawl）本次 0 合并，没有反例可校准。

#### 新增核查脚本

`scripts/smoke-collect.ts`（逐采集通道冒烟）、`scripts/smoke-filter.ts`（采集→关键词过滤联测）、
`scripts/check-keyword-relevance.ts`（相关度与缩写匹配自检）、`scripts/check-dedup.ts`（去重自检）。
均只读网络请求，不发布、不写草稿。

---

### 推送防线：`.env` 真值与具体公司名一律不推

**背景**：`ENV_CONFIGURATION.md` 里的微信公众号 **AppID 曾经是真值**（不是
AppSecret，AppID 本身不是凭证， 但属不该公开的配置）——
排查「已推内容里有没有真值」时发现的，且它早已在公开仓库里。

**改了什么**

1. 该处换成占位符 `wx_your_appid`；
2. 新增 `scripts/prepush-guard.ts` +
   `.git/hooks/pre-push`：推送前扫「本次要推的文件」，命中就**拒绝推送**（退出码
   1）。检查项：
   - `.env`
     里**凭证类键**（`APP_ID`/`APP_SECRET`/`API_KEY`/`TOKEN`/`PASSWORD`/`WEBHOOK`/`COOKIE`…）的真实值（只报键名，**不打印值**）；
   - **具体公司名**：带中文公司后缀的名称（后缀清单见 `scripts/prepush-guard.ts`
     里的
     `COMPANY_SUFFIX_RE`）；与「客户/甲方/合同/报价/回款/商机/报备」等词同现时，即使是大厂名也拦；
   - 通用凭证形状（`sk-…`、`Bearer …`、带密码的连接串）、手机号、身份证号。
3. 词表分两份：`scripts/prepush-blocklist.txt`（**入库**，只放公开品牌白名单）+
   `.prepush-blocklist.local.txt`（**不入库**，真实单位名/客户名写这里）。
   为什么分开：把真实客户名写进入库的词表，等于换个地方公开客户名 ——
   要拦的东西不能自己泄露。

**实测**

| 场景                                            | 结果                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 修复前的全库扫描                                | 报出 1 处真值（AppID），其余均为占位符/弱值误报（已收紧规则：占位符跳过、短值只在同行出现键名时才报） |
| 自测：含公司后缀的客户行                        | ✅ 拦住                                                                                               |
| 自测：`公开新闻：OpenAI 发布新模型，腾讯云跟进` | ✅ 放行（公开品牌白名单）                                                                             |
| 自测：客户名已写成 `<客户A>` 占位符             | ✅ 放行                                                                                               |

**安装**（新克隆的仓库需执行一次）：

```bash
cp scripts/git-hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

**附带清理**：作者名的兑底默认值原本写着**真实公众号名**（3
处：`publish-with-images.ts`、`src/index.ts`、`src/modules/publishers/weixin.publisher.ts`），
现改为占位符 `your_name`，真实值只留在 `.env` 的 `AUTHOR`。与 AppID 同理，这 3
处此前已在公开仓库里。

**已知边界**：不带公司后缀的名称（如单写「腾讯」）只能靠「同现客户类上下文词」或本地名单拦住
——
所以真实客户名要么写进本地名单，要么接受这个缺口。守卫是防手滑，不是防有意绕过（`--no-verify`
可跳过）。

---

## [未发布] - 2026-09-20

### 发布方式口径统一：立即发布真发，任何模式都同步存一份本地草稿

**决策（本人）**：「真发，不用发送到草稿箱」+「同时也可以保存到草稿箱」。
即：**一键 = 真发 + 同时归档一份本地草稿**。

#### 先摆一个必须知道的事实

本项目的「发布」= **创建公众号草稿**，不是群发。 `WeixinPublisher.publish()`
只调 `POST /cgi-bin/draft/add`（`weixin.publisher.ts:376`）， 全项目搜不到
`freepublish` / `mass` 调用 ——
也就是说**这个代码库从来没有把文章推送给粉丝的能力**。
所以「真发」在现有能力内只能落成「真的调微信接口、真的进公众号后台草稿箱」；
要不要真群发是另一个决定（涉及群发配额与不可撤销），未做。 UI
文案已按这个事实写，不再让人误以为点下去粉丝就收到了。

#### 修的三个真问题

**1. 「立即发布」会静默地什么都不做**

`workflows.html` 的 `publish` 推导是
`publishMode === "draft" ? false : (settings.run.publish ?? core.article.publish)`，
而两个 fallback 都是 `false`。所以选「立即发布」发出的是：

```
{"publishMode":"immediate","publish":false}   ← 实测请求体
```

工作流侧：`publishMode !== 'draft'` → 看 `publish` = false → 不发布； 而
`publishMode === 'draft'` 才写草稿 —— 于是 immediate
模式**既不真发、也不存档，文章渲染完直接丢弃**。

现在 `publish` 一律由 `publishMode`
推导（`publish: publishMode === 'immediate'`），三个工作流都一样。

**2. 发布失败被当成成功**

`publish()` 失败时是**返回**
`{success:false, error}`，**不抛异常**（`weixin.publisher.ts:353`）。
而三个工作流都只 `await step.do("publish-article", …)`、不查返回值 →
`publish-article` 永远绿、工作流永远 success，哪怕微信一个字节都没收到。

现在新增 `readPublishFailure()` 收口：`success !== true` 就抛
`WorkflowTerminateError`， 工作流如实变 `error`，消息里带微信给的原因。

**3. 发布失败 = 内容全丢**

旧逻辑下发布失败时文章没有任何副本（草稿只在 draft 模式写）。
现在**先归档、再发布**：顺序不能反 —— 反过来时发布一失败，文章在本地也不剩。
因此任何模式都会留一份本地草稿，发布失败的消息里也写明「内容已归档到本地草稿箱」。

#### 新增：`src/services/draft-archive.ts`

三个工作流共用一份实现（不再各自抄一遍）：

| 导出                           | 作用                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `archiveDraft()`               | 出稿后落本地草稿；拿不到 id / 写失败只 warn，**不打断发布** |
| `markArchivedDraftPublished()` | 发布成功后把归档草稿标为 `published`                        |
| `readPublishFailure()`         | 把 `{success:false}` 收口成一句失败原因                     |

配套：`src/index.ts` 新增 `updateDraftStatusById()`，并作为 `draftStatusWriter`
接进三个工作流的 env。

**为何必须标
`published`**：不标的话，草稿箱里会留一条显示「草稿」、下面还挂着「发布」按钮的记录，
用户点一下就是**重复提交到公众号**。

#### UI（`docs/workflows.html`）

- 选项重排：「只存本地草稿」在前、为默认；`publishMode` 的所有 fallback 从
  `"immediate"` 改为 `"draft"`
- 「立即发布」增加确认框，写明会真实提交、不可撤销、且会先存本地草稿
- 新增随模式联动的诚实提示： `立即发布到公众号` →
  「会真实调微信接口，提交后进公众号后台的草稿箱（本项不代为群发）；失败时本地草稿仍在。」

#### 验证（端到端，用不调 LLM 的 hellogithub 工作流）

```
A) publishMode=draft      → status=success，新建本地草稿 status=draft，无微信调用
B) publishMode=immediate  → status=success，publish-article 步骤执行，
                            归档草稿 status=published
                           日志：[归档] 本地草稿已保存 id=5e7e80d3…
                                [发布] 发布到微信公众号
```

**意外收获：微信 IP 白名单已经通了。** `GET /api/weixin/ip-check?force=1` →
`{"ok":true,"reason":"ok"}`。 （今天早上 09:0x 那次跑还是
40164，中间被修好了。）所以 B 那次是**真的建了一条公众号草稿**。
测试草稿已在本地删除；微信后台那条需本人手动删（代码库无 `draft/delete`）：
标题「本期精选 GitHub 热门 AI 开源项目…」、时间 2026-09-20 09:41。

#### 未做

- **真群发**（`freepublish/submit`）：需单独决定，有配额限制且不可撤销。
- `docs/publish.html` 的选项文案仍是「立即发布到公众号」/「保存到草稿箱」， 未加
  workflows.html 那句「不代为群发」的提示 —— 两页文案待下次对齐。

---

### 发布中心：默认只生成草稿，堵住「点一下就真发出去」的洞

**问题（真实弧口）**：`docs/publish.html` 把 `publish: true`
**写死在请求体里**，
按钮还叫「立即发布」——点一下就是一次真实公众号推送，**没有任何中间态、没有确认、没有撤销**。
旁边的「强制发布」复选框标题里看着像个安全开关，实际完全空转： 工作流只读
`publish` / `publishMode`，而 `publish` 恒为 `true`，勾不勾都一样。
**标签在lie，而且lie的方向是「看起来还有一道关」。**

**改动**

| 位置                   | 之前                                 | 现在                                                |
| ---------------------- | ------------------------------------ | --------------------------------------------------- |
| 发布参数面板           | 「强制发布」复选框（默认勾选、空转） | **发布方式下拉，默认「保存到草稿箱」**              |
| 顶部按钮文案           | 固定「立即发布」                     | 随模式联动：「生成草稿」/「立即发布」               |
| 请求体                 | `publish: true` + `forcePublish`     | `publishMode` + 由其推导的 `publish`（单一口径）    |
| 顶部按钮点击           | 直接发                               | immediate 模式才先过 `window.confirm()`，取消则不发 |
| 草稿行内「发布」       | 直接发                               | 同样过 `window.confirm()`                           |
| 草稿弹窗内「立即发布」 | 直接发                               | 同样过 `window.confirm()`                           |

**为什么 `publish` 必须由 `publishMode` 推导**：工作流里 `forcePublish`
的优先级高于 `publish`， 两个字段各说各话时 `forcePublish:true` 会盖掉
`draft`，结果就是「明明选了草稿却发了出去」。 本次修改后请求体只发
`publishMode` + 推导出来的 `publish`，不再传 `forcePublish`。

**为什么用 `confirm()` 而不是 toast**：toast
不阻断、挡不住误点，而误点的代价是一条公开推文。 确认框里把「会真实推送到公众号
/ 微信侧不支持撤销 / 当前来源类型 / 当前入选数量」都写出来，
让确认的是具体的事，不是一句「确定吗」。

**验证**（浏览器实测，拦截 `fetch` 只采集请求体，不产生真实副作用）

```
首次访问     → 发布方式=draft，按钮=「生成草稿」，
                无「强制发布」复选框
draft 模式点按钮 → {"publishMode":"draft","publish":false}，不弹确认
immediate 切后   → 按钮变「立即发布」
取消确认     → confirm 文案正确，**零请求**（没发）
确认后       → {"publishMode":"immediate","publish":true} → 发出 /api/workflows/run
草稿行内发布   → confirm("确认把这篇草稿发布到微信公众号？…")；取消→零请求；确认→发 /api/drafts/<id>/publish
草稿弹窗发布   → confirm 文案带标题；取消→零请求
```

**清理**：验证过程在测试浏览器里写入过 `tp.publish.mode=immediate`、
以及拦截测试伪造的 jobId
`capture-only`（污染了「最近任务」列表）。**已全部回滚**： 删除
`tp.publish.mode`、删除 `activeJobId=capture-only`、`recentJobs` 从 10 条清回 8
条（只剔掉两条伪造记录）。

**说明：`docs/publish.html` 不是唯一入口，`docs/workflows.html`
有一个反方向的同类问题（本次未改）**

同一个 UI 里另一个「发布方式 → 立即发布」实测发出的请求体是：

```
{"sourceType":"twitter","publish":false,"publishMode":"immediate", …}
```

也就是 **选了「立即发布」实际不会发布**（工作流：`publishMode !== 'draft'` → 看
`forcePublish`（未传） → 看 `publish`（false）→ 不发）。 两个页面的 `publish`
推导口径不一致（一个写死 true、一个跟 `core.article.publish` 走且默认 false），
且 workflows.html 完全没有发布确认。

**本次不动它**：把「立即发布」改成真发布 = 改变一个按钮的实际行为，
而这个名字用户可能已经用过、并且习惯了它“不会真发”。这个决定留给本人做。

---

### X 关键词全网搜索：封装为 skill，并接入文章工作流自动调用

**背景**：上一轮修好了「Twitter 源抓不到内容」，但恢复的是**固定账号时间线**。
在 UI 里选 Twitter + 关键词 `GEO`，得到的仍然是 @OpenAIDevs 的最新 20
条（关键词只做正文过滤）， 拿不到「全网在聊 GEO 的推文」。要关键词全网搜索，只有
twitterapi.io 付费路线支持，而它当前欠费 402。

**方案**：把采集方法本体封装成 skill，让**文章工作流在运行时自动调用它**。

```
E:\openclaw-skills\x-search-collector\
  SKILL.md                        ← 方法论：为什么只能走浏览器、有哪些坑、验收标准
  scripts\collect-x-search.mjs    ← 唯一一份可执行实现（Node，零依赖）
```

工作流侧只做「调用方」该做的事，**一行采集逻辑都不复制**（避免两份实现各自漂移）：

| 文件                                        | 作用                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| `src/modules/scrapers/x-search.scraper.ts`  | 定位 skill → 传参 → 校验退出码 → 映射为 `ScrapedContent` |
| `src/services/weixin-article.workflow.ts`   | `scrape-contents` 步骤新增 `x-search` 分支               |
| `docs/workflows.html` / `docs/publish.html` | 来源类型新增「X 关键词搜索」+ 关键词输入框               |
| `deno.json` / `start-web.ps1`               | 加 `--allow-run`（工作流要 spawn node 跑 skill）         |
| `scripts/verify-x-search.ts`                | 不跑整个工作流、单独验证 skill 的 1 条命令               |

#### 为什么是「工作流 spawn skill」，不是「让 agent 跑 skill」

因为这是**流水线**，不是一次对话。工作流需要确定性的输入输出、退出码、超时和重试。
所以 skill 以「可执行目录」形式落地：`SKILL.md` 给人/agent
读，`collect-x-search.mjs` 给流水线调。
两边共用同一份方法，不存在「文档说的和代码做的不一样」。

#### 三个必须理解的行为差异

1. **关键词在 x-search 里是「搜什么」，不是「过滤什么」。** 之前
   `includeKeywords` 是事后过滤器；x-search 的关键词是搜索请求本身。 X
   的检索是宽匹配，拿同一个词再筛一遍正文会剔掉「搜到了但正文没字面命中」的内容，
   最后报「过滤后无可用内容」——这正是「设了 GEO 却一条都没有」的假故障成因。
   现在过滤步骤对 `platform === "x-search"` 的内容**跳过 includeKeywords，但保留
   excludeKeywords**。

2. **x-search 不进 `all`，也不做 fallback。** 它要开着
   Chrome、靠本机代理、单次约 1~2 分钟；塞进 `all`
   会让每次全量跑都变成一次浏览器自动化。
   失败时也不回退到账号时间线：那会给出「与关键词无关的内容」却当成功，比直接失败更坏。
   所以它**硬失败**，并把「代理没开 / 扩展离线 / 未登录 X」原样抛出。

3. **原始 JSON 落盘且从不覆盖。**
   `logs/x-search-<slug>-<本地时间戳>.json`。之前用「日期」命名，同一天重跑会把上一次的证据默默盖掉。
   （本次开发中就真的盖掉了一份上一轮的 `logs/x-search-geo-2026-09-19.json`；
   可读版 `output/x-search-geo-2026-09-19.md` 仍在，但原始 JSON 已不可复原。）

#### 验证证据

单 skill 直跑：

```
$ node scripts/verify-x-search.ts "GEO优化"   # 实际是 deno run scripts/verify-x-search.ts
[X搜索] GEO优化 抓到 81 条，可用 30 条，用时 73.0s
```

工作流端到端（`POST /api/workflows/run`，`sourceType=x-search`，`includeKeywords=["GEO优化"]`，`publishMode=draft`）：

```
[数据源] 发现 1 个数据源
[X搜索] 采集关键词: GEO优化（script=E:/openclaw-skills/x-search-collector/scripts/collect-x-search.mjs, pages=top,latest）
[X搜索] GEO优化 抓到 72 条，可用 30 条，用时 76.9s，原始数据: logs/x-search-geo-20260920-075638.json
[内容排序] 开始排序 30 条内容
[发布] 已跳过发布
→ status: success，5 个步骤全绿，产出草稿 16483e25（标题含「GEO」）
```

浏览器 UI 路径（拦截 `fetch` 只采集请求体，不产生真实副作用）：

```
workflows.html → {"sourceType":"x-search","includeKeywords":["GEO优化","\"AI coding agent\""],"publishMode":"draft"}
publish.html   → {"sourceType":"x-search","includeKeywords":["GEO优化"],"publish":true}
```

关键词框只在选「X 关键词搜索」时出现（已实测三态切换：初始隐藏 → 选 x-search
显示 → 切回 Twitter 隐藏）。

#### 已知遗留（本次未做）

- **publish.html 的「立即发布」按钮发的是 `publish: true`**：本次**未在 UI
  上点过它**， 只验证了它构造的请求体正确。该按钮在 2026-09-20
  晚些时候的「发布方式口径统一」里已改成 由 `publishMode` 推导，详见上一条。
- **草稿正文没有回链到原推文 URL**：模板没渲染 `url`
  字段（数据里有），是上一轮就存在的老问题。
- **媒体 URL 缺失**：DOM 路线只能判断「这条推有没有图」，拿不到图片地址，故
  `media: []`。

---

### 发布页新增 IP 白名单检测（根治“发布报错但界面说成功”）

**背景（真实故障）**：排查时发现微信所有需要 `access_token` 的接口（含
`draft/add` 创建草稿） 都必须先通过**调用方 IP 白名单**校验。本机当前被拒：

```
errcode: 40164
 errmsg : invalid ip 120.239.70.0 ipv6 ::ffff:120.239.70.0, not in whitelist
```

即“点立即发布”**必定失败**，但旧前端只看 `response.ok`（后端失败也返回 200） →
页面照样提示“发布成功”。已在下一条修复。

**新增接口** `GET /api/weixin/ip-check`

- 直连微信 token 接口取状态；失败时从 `errmsg` 里**反查出微信侧看到的那个 IP**
- 为什么不用本机自测出口 IP（如 ipify）：实测两者并不一致 （本机查到
  `161.118.247.247`，微信看到 `120.239.70.0`，中间有代理/VPN）——
  真正要加进白名单的是**微信报错里的那个地址**
- 返回 `{ ok, reason, ip?, errcode?, errmsg?, checkedAt }` （`reason`: `ok` /
  `ip-not-whitelisted` / `missing-credentials` / `error`）
- 带 60 秒缓存（`WEIXIN_IP_CHECK_TTL_MS`），避免每次刷新页面都打微信 token 接口
- 支持 `?force=1` 跳过缓存重测

**发布页 UI**

- 顶部新增红色警告横幅：显示待加入白名单的 IP（可直接复制）+ 重新检测 +
  打开公众号后台
- 横幅带操作路径提示：设置与开发 → 基本配置 → IP 白名单，并提醒家庭宽带 IP 会变
- 「平台状态」原先写死的「已连接 / 草稿箱可用」改为动态： 按检测结果分别显示
  已连接 / 微信待配置 / 微信未配置 / 微信异常 / 检测失败
- 检测失败不阻断页面（静默降级）

### 发布提示与弹窗交互优化

- **根因**：`.toast` 没设 `z-index`，而 `.modal-overlay` 是 `z-index:20` →
  提示被压在 60% 暗色遮罩下面，用户看到的是被压暗的模糊小字
- `.toast` 提到 `z-index:60`；改顶部居中、15px 加粗、显示 2.4~4.2 秒
- 新增 success / error / info 三态（颜色 + 外发光 + 圆形图标 ✓/✕/i）
- `showToast(message, type)` 强制重排，连续两次提示都能重放进入动画
- toast 加 `role=status` + `aria-live=polite`（读屏可播报）
- **修正误报**：`publishDraft` 原先只看 `response.ok`，而后端发布失败也返回 HTTP
  200， 导致失败提示“已推送到微信草稿箱”。现改为检查 `result.success`，
  失败时红框显示具体原因
- 发布成功后延时 900ms 自动关闭编辑弹窗，让用户先看清提示

### 提示条收敛为全站公共组件（消除 5 份重复实现）

**问题**：这个提示条原先在 **5 个页面**里各复制了一份（CSS + `showToast`
函数）， 所以修好了 `publish.html` 的“被弹窗遮罩压暗”，其余 4 页仍是旧的右下角
12px 小灰字—— 样式持续漂移。另外 `sources.html` 还是 `var` + `function`
的旧写法，与其余页不一致。

**改法**：新增 `docs/js/ui-toast.js`，一份定义供全站使用。

- 自注入 `<style>`（页面无需再写 toast 相关 CSS）
- 自建/复用 `#toast` 元素，统一内部结构（图标 + 文字）
- 导出 `window.showToast(message, type)`，`type` = `success` / `error` / `info`
- 幂等：重复引入、页面已自建 `#toast` 都不会出问题
- 顶部居中、`z-index:60`（高于 `.modal-overlay` 的 20）、三态颜色 + 圆形图标

**涉及页面**（每页：删内联 CSS + 删内联 `showToast` + 加一行
`<script src="./js/ui-toast.js">`）

`prototype.html` / `sources.html` / `templates.html` / `workflows.html` /
`publish.html`

- 共删除约 280 行重复代码，全站只剩一份实现
- 页内 `showToast(...)` 调用无需修改：移除局部定义后自然解析到全局函数

**验证**

- 5 页内联脚本全部通过 `node --check`（含 `sources.html` 的 module 脚本）
- 真实浏览器逐页实测：`window.showToast` 已加载、样式已注入、 `success`（✓）与
  `error`（✕）两态类名与图标均正确

### 封面图改为「AI 底图 + 本地字体重排」（解决 AI 直出中文乱码）

**问题**：原先封面由文生图模型直接生成整张图（包含标题文字）。实测智谱 cogview-4
渲染中文严重乱码—— 「AI 三连炸」被画成「AI三连如人」，日期画成
2027/9/20，还凭空冒出「4P+」「#001IEF」等无意义字符。
根因：扩散模型把文字当**像素图案**画，不是排版，中文几乎必然出错。

另外智谱返回的 HTTP header 标 `image/png`，实际字节是 JPEG；且 1440×720 输出约
117KB， 超过微信 `thumb` 素材 64KB 的硬性上限。

**改法**：拆成两步，各用其所长。

1. 智谱 cogview-4 只负责生成**无文字**的科技感底图 （prompt 明确要求
   `no text, no letters, no words, no numbers, no logo, no signature`）
2. 标题由字体引擎（imagescript WASM 字体库）**本地渲染**后叠加 —— 100% 准确

**新增文件**

- `src/utils/image/cover-composer.ts`
  - `composeCover()`：背景（AI 底图 / 本地渐变）+ 三层中文标题 → 自适应暗底板 →
    压缩到 <64KB JPEG
  - `splitCoverTitle()`：草稿标题拆三层
    （`2026/9/17 AI速递 | AI 三连炸：GPT-6 Astra 赋能 Devin，…` → 页脚 / 主标题
    / 次标题）
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

- `src/providers/interfaces/image-gen.interface.ts`：新增 `ZHIPU_COGVIEW4`
  类型与映射
- `src/providers/image-gen/image-generator-factory.ts`：新增 `ZHIPU_COGVIEW4`
  分支
- `src/index.ts`：`publishDraftById` 封面三级降级
  1. 智谱底图 + 本地标题 → 上传
  2. 智谱失败 → 本地渐变底图 + 本地标题（标题依然正确，只是底图朴素）
  3. 连本地合成都失败 → 无封面出稿
- `ENV_CONFIGURATION.md`：补 `ZHIPU_API_KEY` 说明
- `.gitignore`：忽略字体构建中间目录 `.font-tmp/`、临时探针脚本、智谱 key
  临时文件

**顺带修的 bug**

- `publishDraftById` 原先调用 `publisher.publish(draft.html)` **不传 title**，
  导致微信草稿标题落到默认值「每日AI趋势」、封面丢失。现已传
  `{title, author, thumbMediaId}`。
- `DraftItem` 新增可选 `thumbMediaId` 字段，发布成功后写回
  `logs/drafts.json`，同一条草稿二次发布不再重复扣费。

**水印处理**

智谱在底图右下角强制叠加圆角药丸水印「AI生成」（非 prompt 可控，服务域名里就带
`watermark`）。 实测水印包围盒：x 1308–1422 / y 663–712（1440×720
底图），**距下边仅 8px**。

因此 `composeCover()` 提供 `watermark` 参数（默认 `crop`）：

| 取值           | 做法                                                                     | 效果                                           |
| -------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| `crop`（默认） | 合成前从底图底部裁掉 64px 再铺满画布                                     | 水印彻底消失、无痕迹；代价是丢弃底部 8% 画面   |
| `footer`       | 保留整图，底部压 13% 高的不透光页脚带（带青色装饰线 + 可自定义品牌文字） | 水印被盖住，顺带变成品牌位；代价是底部一条硬边 |
| `none`         | 不处理                                                                   | 仅用于对比                                     |

相关可调参数：`watermarkCropPx`（默认 64）、`footerText`。

**已知限制**

- `watermark=crop` 会丢弃底图底部约 8%
  画面（对城市/场景图影响很小，实测无可见劣化）
- 字体子集化只覆盖《通用规范汉字表》8105 字，表外生僻字会渲染为空白；扩容方法见
  `assets/fonts/README.md`
- 本次只改 `publishDraftById`（手动「立即发布」路径）； `weixin-article` /
  `weixin-hellogithub` / `weixin-aibench` 三个工作流仍走
  `ALIWANX_POSTER`，未接智谱

## [未发布] - 2026-09-17

### 封面图失败降级（不再让第三方图片服务拖垮工作流）

- 新增降级策略
  `COVER_FALLBACK_MODE`（`src/utils/image/cover-fallback.ts`，可不配置，默认
  `skip`）
  - `skip`：封面生成失败只告警（`[封面降级] ...`），继续出稿（无封面）
  - `placeholder`：失败时用本地生成的占位封面（`src/utils/image/placeholder-cover.ts`，纯
    JS 生成渐变 PNG，无外部依赖/字体，不渲染文字）；占位也失败则退回 skip
  - `fail`：保持老行为，封面失败即失败（需要严格封面时用）
- 封面改为上传成**真正的草稿封面素材**：新增
  `WeixinPublisher.uploadThumb(source)`（`material/add_material?type=thumb`，返回
  `thumb_media_id`，同图进程内缓存）
  - 原先用
    `uploadImage()`（`cgi-bin/media/uploadimg`）的返回值当封面是错的：那是正文图片
    URL，不是 `thumb_media_id`
- 修掉 `publish` 参数传递错误（三个工作流都中招）
  - 原来写的是 `publish(html, title, thumbMediaId)` 这类位置参数，而 `publish`
    只有 `(content, options?)`：字符串被当成 options →
    草稿标题落到默认值「每日AI趋势」、生成好的封面被丢弃
  - 现在统一传 `{ title, thumbMediaId }`；`ContentPublisher.publish` 签名也从
    `(...args: any[])` 收紧为 `options?: {...}`，以后再写错编译期就会报错
- 三个工作流的封面步骤都接入降级：`weixin-article`（generate-article
  内）、`weixin-hellogithub`、`weixin-aibench`
- `src/utils/config/optional-config.ts`：新增可选配置读取（缺键不打
  warn），`ai.summarizer.ts` 与封面降级共用

### 标题生成的 token 预算

- `src/modules/summarizer/ai.summarizer.ts`：标题生成 `max_tokens` 100 →
  1200（可用 `AI_SUMMARIZER_TITLE_MAX_TOKENS` 配置，缺键/非法值静默回落）
  - 推理模型（如 `deepseek-reasoner`）会先把预算花在 reasoning token 上，100
    会得到 `finish_reason=length` 且 content 为空
  - content
    为空时的报错带上诊断：`未获取到有效的标题（finish_reason=length, reasoning_tokens=100, max_tokens=100）`

### 工作流运行详情（补上设计里缺失的「详情抽屉」）

- 后端运行记录升级（`src/index.ts`）
  - `WorkflowJob` 增加
    `payload`（本次运行参数）、`steps[]`（每步的状态/耗时/重试次数/错误/结果预览）、`error{message,stack}`、`logs[]`（本次运行期间的
    console 输出，保留最后 200 行 / 32KB）、`drafts[]`（运行期间写出的草稿）
  - 运行记录落盘到 `logs/workflow-jobs.json`（保留最近 50
    条，原子写）；启动时回读，`/api/workflows/status`
    内存未命中时回查落盘，服务重启后「查看」仍可用
  - 工作流运行期间接管 `console` 把输出归到对应 job（并发时归到各运行中
    job，结束后恢复），并剔除日志里的 ANSI 颜色码
- 步骤级记录（`src/works/workflow.ts`）
  - `WorkflowStep.do` 增加可选观察者
    `addWorkflowStepObserver`，三个工作流自动获得步骤轨迹；未注册时零行为变化，观察者抛错不影响主流程
- 前端运行详情（`docs/workflows.html`）
  - 「查看」除了切换运行状态面板，还会打开右侧详情抽屉：概览 / 步骤时间线 /
    失败详情（message + stack）/ 参数 / 日志 / 产出（草稿）
  - 抽屉支持刷新、关闭按钮、Esc、点遮罩关闭；任务还在跑时每 2s 自动刷新
  - 修掉幽灵「运行中」：近期记录里非当前轮询的行会定期回查状态，404
    则标为失败（任务记录不存在）

### 模板库预览

- `docs/templates.html` 模板库新增预览能力
  - 每张模板卡片新增「预览」按钮（弹层内渲染，内置模板按各自 workflow 请求
    `/api/templates/preview`，自定义模板直接渲染本地 HTML）
  - 编辑区新增「模板预览」按钮（位于「保存修改」左侧），可直接预览 textarea
    里未保存的修改
  - 预览弹层支持刷新预览 / 关闭 / 点遮罩 / Esc，并加了 350ms
    防误关（避免双击第二次点击落在遮罩上直接关闭）

### 一键启动脚本

- 重写 `start-web.ps1` / `start-web.bat`
  - 自动定位 Deno（项目内 `.deno` → 用户级安装 → PATH → winget
    目录），缺失时给安装指引或 `-InstallDeno` 自动装
  - 端口解析优先级 `-Port` > `UI_PORT` 环境变量 > `.env` >
    8002；端口被占用时自动换空闲端口
  - 启动后等待服务就绪并自动打开浏览器（`-NoBrowser`
    可关）；若端口上已是本服务，直接提示已在运行并打开浏览器
  - 新增 `-Stop` 停止服务、`-Dev` 热重载
  - 本机探测绕过系统代理（`WebRequest` + `Proxy = $null`），避免 `HTTP_PROXY`
    环境变量拖死 localhost 探测
- 新增 `start-web-hidden.vbs`：双击无 cmd 黑窗启动
  - VBS 用 `WshShell.Popup` 弹一个 3 秒后自动关闭的「Starting TrendPublish Web
    Console...」提示框（VBS 默认 ANSI 编码，中文文案会导致 Popup
    构造失败，所以用纯英文），作为双击后的即时反馈
  - 然后 `WScript.Shell.Run` 第二参数 `0`（`SW_HIDE`）+ 第三参数 `False`（不阻塞
    VBS）异步启动 BAT，绕过 BAT 自弹 cmd 窗口的限制
  - 启动成功的标志：浏览器自动打开 http://localhost:8002/；启动失败由 BAT 末尾的
    MessageBox 弹到屏幕上兜底
  - 服务输出仍写 `logs\server.log`，浏览器自动打开
- 修 `start-web-hidden.vbs` 双击无反应的 bug
  - 原 `shell.Run """" & batPath & """", 0, False` 用 4 个 `"` 包裹路径，VBS
    解析后实际是 `"path"`，shell.Run 把带引号的字符串当作可执行文件名传给
    `CreateProcess`，系统找不到指定文件 → VBS 异常中断 → 用户双击后「Popup
    看不到」是因为脚本在 Popup 之前就抛错了
  - 改为 `shell.Run batPath, 0, False`（项目路径
    `F:\个人项目管理\ai-trend-publish\` 无空格，无需引号）
  - batPath 计算从 `Replace(..., ".vbs", ".bat")` 改为
    `Replace(..., "start-web-hidden.vbs", "start-web.bat")`，避免产出不存在的中间名
  - VBS 文件保存为 **UTF-16 LE + BOM**（`FF FE`）：VBS 默认 ANSI 解析会让
    `WScript.ScriptFullName` 里的中文路径变成乱码字节，`fso.FileExists` /
    `shell.Run` 都找不到文件；UTF-16 LE + BOM 让 wscript 按 Unicode
    解析整个脚本，中文路径正确处理
- `start-web.bat` 末尾 `pause` 改为默认行为「成功无感退出 / 失败弹系统通知框」
  - 成功：`exit /b 0`，cmd 窗口立即关闭（无感）
  - 失败：用 `System.Windows.Forms.MessageBox` 弹错误码 + 指向
    `logs\server.log`；退出码透传给 vbs 入口
  - 与 `start-web-hidden.vbs` 协同：vbs 隐藏窗口启动 BAT 后，失败仍能通过
    MessageBox 弹窗提示

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
