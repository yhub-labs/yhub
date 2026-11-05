[English](https://github.com/yhub-labs/yhub/blob/main/README.md) | 简体中文

# Y-Hub

Y-Hub（项目名 `yhub`，CLI 命令 `yhub`）是一个本地优先的个人信息中枢：一个本机后端加一套适配器，每项能力只声明一次，同时暴露成 **HTTP 接口 / MCP 工具 / CLI 命令** 三面，再用 Web 工作台、信息墙和 macOS 桌面壳把它用起来。

## 架构速览

```text
yhub/server/adapters/      一个工具一个文件：导出 TOOL_META，路由 + MCP + CLI 自动出现
yhub/server/main.py        FastAPI 应用：发现适配器 → 注册 → 托管前端
yhub/server/mcp_server.py  同一套适配器走 MCP（stdio）
yhub/cli/                  宿主命令 + 由适配器声明生成的 CLI
web/                       Vite + React + TS 界面：启动器、工作台、设置、信息墙
tauri/                     macOS 桌面壳：托盘、全局热键、无边框窗（不含 Python）
capsules/                  随包分发的单文件 HTML 胶囊（构建产物 + TiddlyWiki）
```

- 能力写在 `yhub/server/adapters/`，界面只负责显示。
- 三面对齐：`yhub <cmd> --json` 的输出与对应 HTTP 接口是同一份 body。
- 信息墙的格子由产地插件声明，中心只做注册表与聚合。

细节见 [`docs/architecture.md`](https://github.com/yhub-labs/yhub/blob/main/docs/architecture.md) 与 [`api-contract.md`](https://github.com/yhub-labs/yhub/blob/main/api-contract.md)。

## 快速开始

```bash
uv sync                      # 需要 Python 3.10+（本机用 uv）
uv run yhub --help
uv run yhub gui              # 后端 + Web 工作台 → http://127.0.0.1:8790
uv run yhub gui --no-open    # 只起服务（--dev 只起 API，--port N 换端口）

uv tool install . --force    # 可选：任意目录可直接用 `yhub`
```

MCP 客户端接入：

```json
{ "mcpServers": { "yhub": { "command": "yhub", "args": ["mcp"] } } }
```

前端开发：一个终端跑 `uv run yhub gui --dev`，另一个跑 `cd web && npm install && npm run dev`（Vite 把 `/api` 代理到 8790）。改完界面要跑 `cd web && npm run build`；后端直接托管 `web/dist`，打包时再收进 wheel。

## 主要命令

| 入口 | 做什么 |
| --- | --- |
| `yhub gui` | 后端 + Web 工作台，监听 `127.0.0.1:8790` |
| `yhub mcp` | 走 stdio 的 MCP 服务 |
| `yhub plugin list\|install\|remove\|enable\|disable` | 核心插件（随包分发，只能禁用）与第三方插件 |
| `yhub completion zsh` | 从命令解析树生成的 shell 补全 |

核心插件（`rclone`、`rss`、`schedule`）以及本机装好的第三方插件声明的命令会自动出现在 `yhub --help` 里。桌面壳默认用 `Option+Space` 唤起启动器；`make install` 会装好 `/Applications/Y-Hub.app`。配置只有一份文件 `~/.yhub/settings.json`，通过网页设置页（`/?view=settings`）或桌面设置写入——见 [`docs/config.md`](https://github.com/yhub-labs/yhub/blob/main/docs/config.md)。

## 扩展点

1. **适配器** — 新增 `yhub/server/adapters/<id>.py` 并导出 `TOOL_META`（`faces.routes` / `faces.mcp` / `faces.cli`，信息墙格子另加 `presentation.tiles`），其它文件不用动。
2. **胶囊** — 单文件 HTML 应用，按 `/capsules/<path>` 托管，`PUT` 即存回磁盘。TiddlyWiki 随包自带（打包时从官网下载）；内置胶囊第一次保存会落成用户库副本，升级永远不会覆盖你的编辑。见 [`docs/capsules.md`](https://github.com/yhub-labs/yhub/blob/main/docs/capsules.md)。
3. **插件** — 第三方适配器，用 `yhub plugin install <id | owner/repo | path>` 装进配置根目录，不随本仓库分发。registry 格式见 [`examples/registry.example.json`](https://github.com/yhub-labs/yhub/blob/main/examples/registry.example.json)，约定见 [`docs/plugins.md`](https://github.com/yhub-labs/yhub/blob/main/docs/plugins.md)。

## 验收

```bash
uv run yhub gui --no-open &          # 部分检查需要后端在跑
cd web && npm run build              # 类型检查 + 构建
cd web && npm run smoke              # 真实 Chrome 端到端
cd web && node verify-cli.mjs        # MCP tools/list + CLI --json ≡ HTTP body
cd web && node verify-settings-ui.mjs && node verify-edit-mode.mjs
./scripts/check-versions.sh          # Python / 前端 / Tauri / Cargo 版本一致
cd tauri && cargo test config::      # 配置读写与校验
./tauri/scripts/verify-settings-parity.sh
make verify-backend verify-plugins   # 后端接口 + 插件机制
make verify-app                      # 装机版端到端
```

后端不在 `.app` 里：壳启动的是已安装的 `yhub`，所以改完 Python 代码要跑 `make install-backend`（或重启源码态后端）。打包、签名与装机见 [`docs/packaging.md`](https://github.com/yhub-labs/yhub/blob/main/docs/packaging.md)；下一步方向见 [`docs/roadmap.md`](https://github.com/yhub-labs/yhub/blob/main/docs/roadmap.md)。

## 许可

MIT。见 [`LICENSE`](https://github.com/yhub-labs/yhub/blob/main/LICENSE)；第三方资产声明见 [`THIRD-PARTY.md`](https://github.com/yhub-labs/yhub/blob/main/THIRD-PARTY.md)。
参与贡献见 [`CONTRIBUTING.md`](https://github.com/yhub-labs/yhub/blob/main/CONTRIBUTING.md)，安全问题见 [`SECURITY.md`](https://github.com/yhub-labs/yhub/blob/main/SECURITY.md)。

## 文档

[`AGENTS.md`](https://github.com/yhub-labs/yhub/blob/main/AGENTS.md) · [`docs/architecture.md`](https://github.com/yhub-labs/yhub/blob/main/docs/architecture.md) · [`api-contract.md`](https://github.com/yhub-labs/yhub/blob/main/api-contract.md) · [`docs/config.md`](https://github.com/yhub-labs/yhub/blob/main/docs/config.md) · [`docs/plugins.md`](https://github.com/yhub-labs/yhub/blob/main/docs/plugins.md) · [`docs/capsules.md`](https://github.com/yhub-labs/yhub/blob/main/docs/capsules.md) · [`docs/rclone.md`](https://github.com/yhub-labs/yhub/blob/main/docs/rclone.md) · [`docs/gui-development.md`](https://github.com/yhub-labs/yhub/blob/main/docs/gui-development.md) · [`docs/i18n.md`](https://github.com/yhub-labs/yhub/blob/main/docs/i18n.md) · [`docs/packaging.md`](https://github.com/yhub-labs/yhub/blob/main/docs/packaging.md) · [`docs/roadmap.md`](https://github.com/yhub-labs/yhub/blob/main/docs/roadmap.md)
