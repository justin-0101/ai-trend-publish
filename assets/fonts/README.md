# 中文字体资源（封面图文字渲染用）

本目录存放封面图生成所需的**中文字体**，全部为 **SIL Open Font License 1.1 (OFL-1.1)** 授权，
允许免费商用、允许随软件分发（OFL 明确许可嵌入与再分发）。

授权全文见同目录 `LICENSE-OFL-1.1.txt`。

## 为什么字体要做「子集化」

渲染引擎用 `imagescript@1.2.17`，其 WASM 字体库会解析字体**全部字形表**，
解析耗时与字体体积近似成正比。完整中文字体（2–6 万字形）解析需 12–220 秒，无法用于线上出稿。

因此本目录的字体均已用 `pyftsubset` 裁剪为「通用规范汉字表 8105 字 + ASCII + 常用标点」，
体积降至原始的 **30%**，解析耗时降至 **0.4–1.2 秒**。

| 字体 | 原始体积 | 子集体积 | 渲染耗时（原始 → 子集） |
|---|---:|---:|---|
| 霞鹜新晰黑 | 7.13 MB | 2.05 MB | 12.4 s → **0.41 s** |
| 霞鹜文楷 | 24.39 MB | 4.05 MB | 221.5 s → **1.18 s** |
| 霞鹜新致宋 | 9.98 MB | 2.88 MB | 44.3 s → **0.55 s** |

**已知取舍**：子集化后仅覆盖《通用规范汉字表》8105 字。
遇到表外生僻字（如「龘」「𠮷」等）会渲染为空白或方块。
如需扩容，见文末「重新子集化」。

## 字体清单

### 艺术字体（标题用）

| 文件 | 字体名 | 风格 | 来源 | 版本 |
|---|---|---|---|---|
| `SmileySans-Oblique.ttf` | 得意黑 | 倾斜艺术黑体，**科技感最强**（推荐封面主选） | [atelier-anchor/smiley-sans](https://github.com/atelier-anchor/smiley-sans) | v2.0.1 |
| `GlowSansSC-Compressed-Bold.otf` | 未来荧黑 压缩 Bold | 紧凑黑体，字距窄，适合长标题 | [welai/glow-sans](https://github.com/welai/glow-sans) | v0.93 |
| `GlowSansSC-Compressed-Medium.otf` | 未来荧黑 压缩 Medium | 同上，中等字重 | 同上 | v0.93 |
| `MonuTitl-CnBd.ttf` | 典迹题幕 粗体 | 窄体标题黑，适合副标题 | [MY1L/Monu](https://github.com/MY1L/Monu) | Titl / 0.96CnBd |
| `LXGWMarkerGothic-Regular.ttf` | 霞鹜马克黑 | 马克笔手写风 | [lxgw/LxgwMarkerGothic](https://github.com/lxgw/LxgwMarkerGothic) | v1.003 |

### 常用字体（正文/通用）

| 文件 | 字体名 | 风格 | 来源 | 版本 |
|---|---|---|---|---|
| `LXGWNeoXiHei.ttf` | 霞鹜新晰黑 | 现代无衬线黑体，干净通用 | [lxgw/LxgwNeoXiHei](https://github.com/lxgw/LxgwNeoXiHei) | v1.305 |
| `LXGWNeoZhiSong.ttf` | 霞鹜新致宋 | 宋体 | [lxgw/LxgwNeoZhiSong](https://github.com/lxgw/LxgwNeoZhiSong) | v1.067 |
| `NotoSansSC-Regular.otf` | 思源黑体 Regular | 最通用的开源黑体（兜底首选） | [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk) | Sans 2.004 |
| `NotoSansSC-Bold.otf` | 思源黑体 Bold | 同上，粗字重 | 同上 | Sans 2.004 |

### 文学字体（文艺风）

| 文件 | 字体名 | 风格 | 来源 | 版本 |
|---|---|---|---|---|
| `LXGWWenKai-Regular.ttf` | 霞鹜文楷 | 楷体 / 手写温度 | [lxgw/LxgwWenKai](https://github.com/lxgw/LxgwWenKai) | v1.522 |
| `LXGWZhenKaiGB-Regular.ttf` | 霞鹜臻楷 | 加粗楷体，标题也压得住 | [lxgw/LxgwZhenKai](https://github.com/lxgw/LxgwZhenKai) | v0.825 |
| `ZhuqueFangsong-Regular.ttf` | 朱雀仿宋 | 仿宋体 | [TrionesType/zhuque](https://github.com/TrionesType/zhuque) | v0.212 |

## 未采用的字体及原因

| 字体 | 原因 |
|---|---|
| MiSans（小米） | 授权条款禁止「单独分发字体文件」，放入公开仓库有合规风险 |
| HarmonyOS Sans（华为） | 授权条款不够明确，企业商用存疑 |
| 阿里巴巴普惠体 | 仅有官网/网盘下载，无 GitHub Release，无法自动化获取与版本校验 |
| 文津宋体 WenJinMincho | 仅提供 `.7z` 格式，本机无 7z 解压工具 |

## 子集化参数（可复现）

```bash
# 1) 字符集 = 通用规范汉字表 8105 字 + ASCII(0x20-0x7E) + CJK标点(0x3000-0x303F)
#    + 全角(0xFF01-0xFF5E) + 通用标点(0x2000-0x206F) + 常用符号
#    已生成： .font-tmp/_subset_chars.txt （8491 个字符）

# 2) 裁剪
pyftsubset input.ttf \
  --text-file=.font-tmp/_subset_chars.txt \
  --output-file=output.ttf \
  --layout-features='*' \
  --drop-tables+=DSIG \
  --no-hinting \
  --name-IDs='*' \
  --recalc-bounds
```

《通用规范汉字表》字符表来源：
[jaywcjlove/table-of-general-standard-chinese-characters](https://github.com/jaywcjlove/table-of-general-standard-chinese-characters)
→ `data/characters.txt`（共 8105 字，含扩展 A/B 区）。

## 重新子集化 / 扩容字符集

原始完整字体（未裁剪）体积约 114 MB，不在版本库中。如需扩容：

1. 按上表「来源」列从各 GitHub Release 重新下载原始字体
2. 扩充 `.font-tmp/_subset_chars.txt`（追加所需字符）
3. 重跑上述 `pyftsubset` 命令

## 合规提醒

- 本目录所有字体均为 OFL-1.1，**允许商用与再分发**
- OFL 要求：**不得单独售卖字体文件本身**；再分发时须保留本 README 与 `LICENSE-OFL-1.1.txt`
- 若将来新增字体，必须先核对授权允许「随软件分发」，再入库
