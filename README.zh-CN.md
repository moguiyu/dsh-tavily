# dsh-tavily

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供 Tavily 网页搜索，支持**多个 Tavily API Key**、**自动轮换/故障转移**、**实时用量仪表盘**和完整的设置卡片。

## 亮点

- 🔑 **多 Tavily API Key** — 在 DSH 设置界面中管理扁平化 Key 列表。
- 🔁 **Key 轮换与故障转移** — 多 Key 轮询；遇到 HTTP 401/429 自动切换下一个 Key。
- 📊 **用量仪表盘** — 服务端获取每个 Key 的 Tavily 用量与汇总，不暴露 Key。
- 🎛️ **设置卡片** — 添加/删除/查看 Key、选择用量策略、切换 `web_search` 提供方。
- 🧩 **一个可安装的 DSH 插件** — 模型工具、设置卡片与本地后端整合在单一包中。

## 包

| 包 | 作用 |
|---|---|
| [`@moguiyu/dsh-tavily`](packages/dsh-tavily) | 单一插件：`tavily_search` 工具 + 设置卡片 + 本地后端 |

## 安装

最简单 — 一条命令，一个插件：

```sh
dsh plugin --profile web add github:moguiyu/dsh-tavily
```

或通过 npm 安装：

```sh
dsh plugin --profile web add @moguiyu/dsh-tavily
```

如需完整 `web_search` 提供方切换，请在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中添加提供方行与配置：

```yaml
- insert:
  - id: web-search-tavily
    name: '@crayonlu/dsh-web-search-tavily'
  - id: dsh-tavily
    name: '@moguiyu/dsh-tavily'
- id: web
  config:
    searchProvider: tavily
```

刷新浏览器后，卡片会出现在 **Settings → Plugins → plugin configuration**（`tavily-search`）。

## 凭据

- `TAVILY_API_KEYS` — `tavily_search` 使用的逗号分隔 Key 列表
- `TAVILY_API_KEY` — 自动同步为首个 Key 的主 Key，供 `web_search` 使用

两者都由设置卡片自动管理。

## Key 用量策略

- **轮流使用每个 Key** — 轮询；遇到 401/429 自动尝试下一个。
- **按用量最少优先 / 用量最多优先** — 保存时按 Tavily 实时用量重新排序。

## 开关

在内置 `web_search` 的 `tavily` 与原生 `deepseek-official` 提供方之间切换。选择会持久化到 `~/.dsh/tavily-toggle.json`。

## 状态文件

- `~/.dsh/tavily-manager.json` — Key 保存日期 + 策略
- `~/.dsh/tavily-toggle.json` — `{ "enabled": boolean }`

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
