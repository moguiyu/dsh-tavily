# dsh-tavily

[English](README.md) | 简体中文

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/moguiyu/dsh-tavily--packages-dsh-tavily/) [![推荐 dshfind](https://img.shields.io/badge/%E6%8E%A8%E8%8D%90-dshfind-ffd700?labelColor=555555)](https://dshfind.com/zh/plugins/moguiyu/dsh-tavily?ref=badge)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供 Tavily 网页搜索：**多 API Key**、**轮换与故障转移**、**实时用量环**、**`extract` / `map` / `crawl` 直连工具**，以及 **Plugins（插件）页面**上的 Key 管理卡片。

内置的 `web_search` 工具**永不被替换**：Tavily 是原生搜索的*补充*，而不是替代。本插件不注册任何网页搜索 provider，也不会改写 `web.searchProvider`。

<p align="center">
  <img src="assets/tavily-search.png" alt="Plugins 页面上的 Tavily 卡片：脱敏 Key 列表、绿色主 Key 圆点、每 Key 用量环与 Key 使用策略选择器" width="760" />
</p>

## 亮点

- 🔑 **多个 Tavily API Key** —— 在 DSH 界面中维护一份扁平的 Key 列表。
- 🔁 **Key 轮换与故障转移** —— 轮询使用；遇到 HTTP 401/429 自动换下一个 Key。
- 📊 **实时用量** —— 每个 Key 的 Tavily 用量与总计，全部服务端获取，Key 不出服务端。
- ⚡ **Tavily 直连工具** —— `tavily_extract` 读取已知 URL 的完整内容，`tavily_map` 发现站点链接，`tavily_crawl` 抓取整站，共用同一套 Key 轮换。

## 安装

### 在 Plugins 页面安装

1. 打开 DSH 侧边栏的 **Plugins（插件）**页面，点击 **Add plugin**。
2. 填入 npm 包名 **`@moguiyu/dsh-tavily`**，或源码地址
   **`https://github.com/moguiyu/dsh-tavily`**。该输入框也接受 tarball 与本机绝对路径。
3. 点击 **Install**，再点击 **Enable now**。刚装好的 bundle 默认是**关闭**的，需要手动启用。

随后卡片会渲染在 `dsh-tavily` 这个 bundle 自己的页面上 —— 位于描述与其行列表之间。

### 用命令行安装

该对话框接受的内容与 `dsh plugin add` 完全一致，两种方式等价：

```sh
# 从 npm 安装 —— 稳定版，市场统计以此为准
dsh plugin --profile web add @moguiyu/dsh-tavily

# 从仓库安装 —— 永远是最新源码
dsh plugin --profile web add github:moguiyu/dsh-tavily
```

`--profile <name>` 指定安装到哪个 profile；两种写法解析到同一个插件。

> **环境要求** —— DSH 目前是开发者预览版（`0.1.x-rc/alpha`）。工具与 Key/用量路由在 `0.1.0-rc.7` 起的每一行都可用。**卡片与 Plugins 页面的安装入口都需要 `0.1.6-alpha.2` 或更新版本** —— 该版本新增了 Plugins 页面并把插件配置移到那里；更早的版本上插件功能完整、可用命令行安装，只是没有卡片。npm 包名是带 scope 的 `@moguiyu/dsh-tavily`，不是同名的社区 `dsh-tavily` provider 替换插件。

> **兼容性** —— `0.3.x` 是单一自包含包：工具、路由与卡片都在 `@moguiyu/dsh-tavily` 内，只使用长期稳定的 `ctx.tools` / `ctx.webServer` / `ctx.credentials` / `ctx.systemPrompt` 接缝，不再有任何按版本特性探测的代码路径。peer 范围按宿主元组逐条列出（`^0.1.0-rc.7`、`^0.1.1-rc.1`、`^0.1.2-alpha.2`、`^0.1.3-alpha.1`、`^0.1.5-0`、`^0.1.6-0`），因为预发布比较符不会级联 —— 新的宿主版本线要新增比较符，而不是放宽旧的。

## 包结构

**只有一个包。** 早期版本还发布过 `@moguiyu/dsh-tavily-backend` 与 `@moguiyu/dsh-tool-tavily-search`。自 `0.3.0` 起两者都并入 `@moguiyu/dsh-tavily`，该包已完全自包含；两个旧包已弃用，不再更新。

| 包 | 作用 |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | 全部功能：`tavily_search` + `tavily_extract` / `tavily_map` / `tavily_crawl`、Key/用量路由，以及 Plugins 页面上的卡片 |

## 凭据

- `TAVILY_API_KEYS` —— 逗号分隔的 Key 列表；工具按它轮换，遇到 HTTP 401/429 自动重试。
- `TAVILY_API_KEY` —— 主 Key，会自动同步为列表中的第一个 Key。

两者均由卡片自动维护。Key 离开服务端时始终脱敏，任何状态文件都不保存 Key 内容。

## Key 使用策略

- **轮流使用** —— 轮询；遇到 401/429 就换下一个 Key。
- **用量最少优先 / 用量最多优先** —— 保存时按 Tavily 实时用量重排 Key。

## Tavily 工具

`tavily_search` 以及直连工具，均独立于 `web_search`：

- `tavily_search` —— 完整搜索能力（`search_depth`、`topic`、`days`、域名过滤、`include_answer`、`include_raw_content`）；
- `tavily_extract` —— 抓取已知 HTTP(S) URL 的完整内容；
- `tavily_map` —— 只发现站点链接，不抓取页面内容；
- `tavily_crawl` —— 抓取整站并返回各页面提取内容。

compose 该插件即注册这些工具，没有单独的工具开关。若要关闭，请用其 Plugins 页面上的开关停用整个插件 —— 无论开关如何，内置 `web_search` 都保留自己的 provider，其 schema 也不会被改动。

## 状态文件

- `~/.dsh/tavily-manager.json` —— Key 保存日期 + 策略

权限 `600`，不保存任何密钥。

## 开发

```sh
pnpm install
pnpm test
pnpm build
```

## 许可证

MIT
