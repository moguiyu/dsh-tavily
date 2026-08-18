# dsh-tavily

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供基于 Tavily 的**可选高级搜索工具**，支持**多个 API Key**、**轮换/故障转移**、**实时用量仪表盘**，以及接入 rc.7 插件管理（插件管理）的设置卡片。

内置的 `web_search` 工具**永远不会被替换**：Tavily 是默认搜索之外的*选项*，而不是替代品。本仓库不注册任何 web 搜索提供方，也绝不改写 `web.searchProvider`。

## 亮点

- 🧩 **rc.7 插件管理** — Host 注册 `tavily-search` 设置命名空间，卡片以该命名空间为键，部署一经组合本插件，**Settings（设置）→ Plugins（插件）→ plugin configuration（插件配置）** 即自动配对并展示该卡片。
- 🔑 **多 Tavily API Key** — 在 DSH 设置界面中管理扁平化 Key 列表。
- 🔁 **Key 轮换与故障转移** — 轮询多 Key；遇到 HTTP 401/429 自动切换下一个 Key。
- 📊 **用量仪表盘** — 服务端获取每个 Key 的 Tavily 用量与汇总，不暴露 Key。
- 🎛️ **设置卡片** — 添加/删除/查看 Key、选择用量策略，并单独开关高级 `tavily_search` 工具。
- 🚫 **`web_search` 不受影响** — 不注册 `ctx.web` 提供方；卡片开关只控制额外的 `tavily_search` 工具。

## 包

| 包 | 作用 |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | 推荐插件：`tavily_search` 工具 + 设置卡片 + 本地后端 + `tavily-search` 命名空间 |
| [`@moguiyu/dsh-tavily-backend`](packages/dsh-tavily-backend) | 独立设置后端（Key 管理、用量、工具开关） |
| [`@moguiyu/dsh-tool-tavily-search`](packages/dsh-tool-tavily-search) | 独立高级 `tavily_search` 工具（无界面） |

## 安装

一条命令安装工作区 bundle，会自动插入组合版 `dsh-tavily` 行：

```sh
dsh plugin --profile web add github:moguiyu/dsh-tavily
```

刷新浏览器后，**Tavily Search** 卡片会出现在 **Settings → Plugins → plugin configuration**（`tavily-search`）。只有当 Host 半身确实被组合时卡片才会出现——rc.7 配置页只按 Host 已提供（served）的命名空间派发对应键的卡片。

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

## 截图

![Tavily Search for DSH](assets/tavily-search.png)

## 开发

```sh
pnpm install
pnpm test
pnpm build
```

## 许可证

MIT

---

[English](README.md)
