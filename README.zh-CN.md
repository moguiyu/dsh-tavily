# dsh-tavily

[English](README.md) | 简体中文

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/moguiyu/dsh-tavily--packages-dsh-tavily/) [![推荐 dshfind](https://img.shields.io/badge/%E6%8E%A8%E8%8D%90-dshfind-ffd700?labelColor=555555)](https://dshfind.com/zh/plugins/moguiyu/dsh-tavily?ref=badge)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供基于 Tavily 的**可选高级搜索工具**——支持**多个 API Key**、**轮换/故障转移**、**实时用量仪表盘**，以及一个接入插件配置页的设置卡片。

内置的 `web_search` 工具**永远不会被替换**：Tavily 是默认搜索之外的*选项*，而不是替代品。本插件不注册任何 web 搜索提供方，也绝不改写 `web.searchProvider`。

<p align="center">
  <img src="assets/tavily-search.png" alt="Tavily Search 设置卡片：带绿色主 Key 圆点的遮罩 Key 列表、各 Key 用量圆环、策略选择器以及高级工具开关——位于 Settings → Plugins → plugin configuration" width="560" />
</p>

## 亮点

- 🧩 **插件配置设置卡片** — 位于 **Settings → Plugins → plugin configuration** 的原生卡片：添加、删除、查看 Key，选择 Key 用量策略，并单独开关高级 `tavily_search` 工具。
- 🔑 **多 Tavily API Key** — 在 DSH 设置界面中管理扁平化 Key 列表。
- 🔁 **Key 轮换与故障转移** — 轮询多 Key；遇到 HTTP 401/429 自动切换下一个 Key。
- 📊 **实时用量仪表盘** — 服务端获取每个 Key 的 Tavily 用量与汇总，不暴露 Key。
- 🚫 **`web_search` 不受影响** — 不注册 `ctx.web` 提供方；卡片开关只控制额外的 `tavily_search` 工具。

## 安装

一条命令安装工作区 bundle，会自动组合出 `dsh-tavily` 行：

```sh
dsh plugin --profile web add github:moguiyu/dsh-tavily
```

刷新浏览器后，**Tavily Search** 卡片会出现在 **Settings → Plugins → plugin configuration**。只有当 Host 半身确实被组合时卡片才会出现——配置页只按 Host 已提供（served）的命名空间派发对应键的卡片。

> **要求** — DSH 为开发者预览版（`0.1.0-rc.x`）；keyed 插件配置卡片需要 **0.1.0-rc.7 或更新**。npm 名为作用域包 `@moguiyu/dsh-tavily`，并非同名社区 `dsh-tavily` 提供方替换插件。

## 包

| 包 | 作用 |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | 推荐插件：`tavily_search` 工具 + 设置卡片 + 本地后端 + `tavily-search` 命名空间 |
| [`@moguiyu/dsh-tavily-backend`](packages/dsh-tavily-backend) | 独立设置后端（Key 管理、用量、工具开关） |
| [`@moguiyu/dsh-tool-tavily-search`](packages/dsh-tool-tavily-search) | 独立高级 `tavily_search` 工具（无界面） |

## 凭据

- `TAVILY_API_KEYS` — 逗号分隔 Key 列表；`tavily_search` 轮换使用，遇到 HTTP 401/429 自动重试。
- `TAVILY_API_KEY` — 自动同步为首个 Key 的主 Key。

两者都由设置卡片自动管理。Key 不会以明文离开服务器，任何状态文件都不保存密钥。

## Key 用量策略

- **轮流使用每个 Key** — 轮询；遇到 401/429 自动尝试下一个。
- **按用量最少优先 / 用量最多优先** — 保存时按 Tavily 实时用量重新排序。

## 高级 `tavily_search` 工具

高级模型工具**默认关闭，按需开启**。它用于直接访问 Tavily 专属参数（`search_depth`、`topic`、`days`、域名过滤、`include_answer`、`include_raw_content`），与 `web_search` 相互独立：

- 开启它不会改变默认的 `web_search`（内置 DeepSeek 提供方及其原生 schema 保持不变）；
- 关闭它只会注销额外的 `tavily_search` 工具。

开关保存在 `tavily-search` 设置命名空间（settings.yaml）中，并镜像到 `~/.dsh/tavily-tool.json`，保证每次重启读到相同值。

## 状态文件

- `~/.dsh/tavily-manager.json` — Key 保存日期 + 策略
- `~/.dsh/tavily-tool.json` — 高级工具 `{ "enabled": boolean }`（设置命名空间的镜像）
- `~/.dsh/tavily-toggle.json` — 旧版工具状态，仅用于迁移读取

权限 `600`，不保存密钥。

## 开发

```sh
pnpm install
pnpm test
pnpm build
```

## 许可证

MIT
