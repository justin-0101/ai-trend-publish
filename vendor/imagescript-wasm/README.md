# vendor/imagescript-wasm —— imagescript 的 WASM 编解码器本地副本

## 为什么有这个目录

`src/utils/image/image-processor.ts` 和 `src/utils/image/cover-composer.ts` 用了
`https://deno.land/x/imagescript@1.2.17/mod.ts`。imagescript 的每个编解码器
（`utils/wasm/*.js`）在**模块初始化阶段**就执行了一次顶层 await：

```js
const path = new URL(import.meta.url.replace('.js', '.wasm'));
wasm_mod = new WebAssembly.Module(await ('file:' === path.protocol
  ? Deno.readFile(path)
  : fetch(path).then(r => r.arrayBuffer())));
```

也就是说：**每次启动都要实时 fetch 7 个 `deno.land` 上的 .wasm**，
而这些 fetch 结果**不进 Deno 的模块缓存**（运行时 `fetch()` 没有磁盘缓存）。
后果：

- fetch 失败（网络抖动 / 代理断流 → `client error (Connect): tls handshake eof`）
  → 未捕获的 Promise 错误 → **进程在 `Deno.serve` 之前就退出**，8002 永远不监听；
- fetch 卡住不回包 → **进程静默挂起**，日志里连 `Listening on ...` 都不会出现。

两种情况从外面看都是「启动不起来」，而且和启动方式无关
（看板 `/api/service/start`、`start-web.bat`、`deno task web` 都一样会中招）。

## 怎么修的

把 7 个编解码器（loader `.js` + 对应 `.wasm`）放到本目录，并在 `deno.json` 里加一条
前缀映射：

```json
"https://deno.land/x/imagescript@1.2.17/utils/wasm/": "./vendor/imagescript-wasm/"
```

映射后 `mod.ts` 里 `import './utils/wasm/tiff.js'` 解析到本地文件，
`import.meta.url` 变成 `file:` 协议，上面的三元表达式走 `Deno.readFile(path)`
——**读本地 .wasm，全程不联网**。`src/` 一行没改。

## 文件来源与校验

全部来自 `https://deno.land/x/imagescript@1.2.17/utils/wasm/<name>.<ext>`
（imagescript 为 MIT 许可，版权归其作者所有）。

| 文件 | 字节 | sha256 前 16 位 |
|---|---|---|
| `font.js` | 4,157 | `9e75d842608c0570` |
| `font.wasm` | 211,325 | `c244cd87aa57bd3e` |
| `gif.js` | 3,509 | `8b86f7b96486bb8f` |
| `gif.wasm` | 58,969 | `533dd675f21eaad1` |
| `jpeg.js` | 1,693 | `75295e2fcf96b4f7` |
| `jpeg.wasm` | 91,769 | `019bcef4d864045e` |
| `png.js` | 1,142 | `0659536a8dd8f892` |
| `png.wasm` | 103,776 | `3687bebda95af757` |
| `svg.js` | 1,411 | `f5c8a9d1977b51a7` |
| `svg.wasm` | 1,069,320 | `85b663e8c33ead57` |
| `tiff.js` | 1,309 | `c2d7bdaef094df25` |
| `tiff.wasm` | 190,349 | `410db4831b9ddd82` |
| `zlib.js` | 2,796 | `749875f83abffe24` |
| `zlib.wasm` | 46,748 | `a9d289c84dad1cbb` |

## 注意

- **升级 imagescript 版本时必须一起处理这里**：改了 `deno.json` 之外的 import 版本号、
  或把 `mod.ts` 的 URL 换成别的版本，前缀映射就对不上了（映射不上就退回联网 fetch，
  又变回老问题）。升级步骤：换 URL → 重新下载同版本的 7 组 `.js`/`.wasm` 到本目录 → 改映射前缀。
- 其余模块（`mod.ts`、`utils/*.js` 等）仍走 Deno 模块缓存，缓存不会被自动清理，
  正常启动不需要联网；只有清空 `DENO_DIR` 或加 `--reload` 时才需要重新拉一次源码。
- 想彻底离线，可以改 `src/` 里两处 import 走本地 specifier；目前没这么做，
  是为了让改动尽可能小、可回滚。

## 验证方式（断网模拟）

把代理指到一个没人监听的端口，等价于「deno.land 不可达」：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:9'; $env:HTTP_PROXY='http://127.0.0.1:9'
.\.deno\bin\deno.exe run --allow-env --allow-ffi --allow-read --allow-write `
  --allow-sys --allow-net --allow-run --env src/index.ts --no-check
```

修复前：`Uncaught (in promise) TypeError: ... svg.wasm ... tcp connect error`，端口不监听。
修复后：正常打印 `Listening on http://localhost:8002/`。
