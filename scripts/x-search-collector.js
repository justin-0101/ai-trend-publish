/**
 * ⚠️ 已废弃（2026-09-20）：本文件只保留为「当时那次采集的选择器与参数快照」，不要再引用它执行采集。
 *
 * 可执行实现已收归 skill，全项目只有一份：
 *   E:\openclaw-skills\x-search-collector\scripts\collect-x-search.mjs
 * 方法论、已知坑与验收标准：
 *   E:\openclaw-skills\x-search-collector\SKILL.md
 *
 * 留着它的唯一理由：下面这些常量记录了实测有效的取值（滚动轮数、DOM 选择器结构、过滤规则），
 * 将来采集质量退化时可以拿来比对。确认无用后可整文件删除。
 */
/**
 * X 搜索采集器（浏览器自动化版）
 *
 * 为什么不用 API/cookie：
 *   - twitterapi.io 账号欠费（402），且源码里 `X_API_KEY` 与 .env 的 `X_API_BEARER_TOKEN` 名字不一致
 *   - cookie 路线（TwitterCookieScraper）只实现了"账号时间线"，且要拿个人账号跑 GraphQL，风控风险高
 *   - 本方案只读"你已登录 Chrome 里的搜索页"，不落 cookie、不碰 ToS 灰区接口
 *
 * 前置条件：
 *   1. 本机代理在线（HTTP_PROXY/HTTPS_PROXY = http://127.0.0.1:7897），否则 x.com 打不开
 *   2. Chrome 已登录 X，且由 huashu-chrome 扩展接管
 *
 * 执行方式：由 Agent 通过 huashu-chrome MCP 驱动，分三步
 *   ① navigate 到 x.com/search?q=<query>[&f=live]，wait 选择器 'article'
 *   ② 循环 N 轮：eval(BROWSER_EXTRACT_EXPR) -> 按 ref 合并 -> scroll(down, 1400)
 *      （x.com 时间线是虚拟滚动，DOM 里只保留约 3-6 条，必须"滚一屏抓一屏"）
 *   ③ 合并结果通过 data: URL + huashu-chrome_download 落盘（实测：savePath 必须与
 *      Chrome 下载目录同盘符，即先用 C:\Users\user\AppData\Local\Temp，再拷到项目盘）
 *
 * 已知坑：
 *   - x.com 的 CSP 禁止页面内 eval 定义函数；BROWSER_EXTRACT_EXPR 必须是"单个表达式"
 *     （不能有分号、不能有 function 声明），所以下面用了箭头函数 + 三元/链式表达式
 *   - 浏览器 fetch 到 http://127.0.0.1 会被拦（实测 Failed to fetch），别指望用本地服务接收
 *   - data: URL 的 percent 编码会让 URL 膨胀约 3 倍（中文），45 条约 39KB URL，可用
 */

export const QUERY_GEO = '"generative engine optimization" OR "生成式引擎优化" OR "GEO优化"';

export const SEARCH_URL = (q, latest = false) =>
  'https://x.com/search?q=' + encodeURIComponent(q) + '&src=typed_query' + (latest ? '&f=live' : '');

export const BROWSER_EXTRACT_EXPR = `JSON.stringify(Array.from(document.querySelectorAll('article')).map(a=>({
  ref:((a.querySelector('time')&&a.querySelector('time').closest('a'))||a.querySelector('a[href*="/status/"]')||{getAttribute:()=>null}).getAttribute('href')||'',
  dt:(a.querySelector('time')&&a.querySelector('time').getAttribute('datetime'))||'',
  who:((a.querySelector('[data-testid="User-Name"]')||{}).innerText||'').replace(/\\n/g,' '),
  text:((a.querySelector('[data-testid="tweetText"]')||{}).innerText||''),
  likes:(a.querySelector('[data-testid="like"]')?(a.querySelector('[data-testid="like"]').getAttribute('aria-label')||'').replace(/[^0-9]/g,''):''),
  media:!!(a.querySelector('[data-testid="videoPlayer"]')||a.querySelector('[data-testid="tweetPhoto"]')),
  promo:!!a.querySelector('[data-testid="placementTracking"]')
})))`;

export const ROLL_ROUNDS_PER_PAGE = 11;   // 每页滚动次数；实测 Top 11 轮约 +31 条，Latest 约 +38 条
export const SCROLL_PIXELS = 1400;
export const DROP_PROMOTED = true;         // 广告帖（data-testid="placementTracking"）一律丢弃
export const KEEP_MIN_TEXT = 1;            // 无正文帖丢弃
