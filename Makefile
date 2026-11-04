# yhub 构建入口（薄壳，真正逻辑都在 packaging/ 与 web/ 里）
#
#   make install-backend  把当前代码装成 `yhub` 命令（uv tool install，PyPI 同款 wheel）
#   make verify-versions  版本一致性（Python / 前端 / Tauri / Cargo 同一版本号）
#   make wheel            构建可发布的 wheel（前端 + 胶囊一起打进包）
#   make publish          只上传 wheel 到 PyPI（需要 UV_PUBLISH_TOKEN）
#   make verify-backend   起 Python 后端、断言核心工具 + cells 产地注册表 + 真实数据（rclone/rss/scheduler）+ /api/settings、/api/capsules、量启动耗时
#   make verify-settings  Rust 与 Python 两侧的设置契约（加配置键必跑；不需要 Rust 工具链）
#   make web              构建前端 → web/dist/
#   make app              完整装机包：前端 + 胶囊 + tauri build（**不再内嵌 Python 运行时**）
#   make install          一条命令装机：按需构建 → 退 App → 归档旧包 → 装 /Applications → 复核 → 重启
#                         （已是最新则秒过；--force / --no-build / --no-restart 见脚本头）
#   make install-hooks    装 git post-commit hook：main 上每次提交后台自动 make install（可 uninstall-hooks 卸）
#   make verify-app       装机版端到端验收：装到干净路径 → 起真 App → 见 docs/packaging.md
#   make smoke            真实 Chrome 端到端冒烟（需要先 make web）
#   make verify-cli       三面对账：MCP tools/list + CLI --json ≡ HTTP body（需后端在跑）
#   make verify-plugins   外置插件机制：示例插件装入 → 三面 + 格子桥自动出现、disabled 全消失（自起测试后端）
#   make verify-tiddlywiki 随包 TiddlyWiki 自动保存：真 Chrome 新建 tiddler → 自动 PUT → 用户层副本（自起测试后端）
#   make dashboard        一条命令起完整信息墙（构建前端 → uv run yhub gui）
#
# 目标平台目前只有 macOS（Tauri 壳）。Windows/Linux 见 docs/packaging.md。

.PHONY: open-app dev-plugin capsules verify-versions wheel publish install-backend verify-backend verify-cli verify-i18n verify-plugins verify-tiddlywiki verify-settings verify-edit-mode web app install install-hooks uninstall-hooks verify-app smoke dashboard plugin-list help

help:
	@sed -n '2,20p' Makefile | sed 's/^# \{0,1\}//'

capsules:
	./scripts/build-capsules.sh

verify-versions:
	./scripts/check-versions.sh

# 发布用的 wheel：三个产物必须先就位，否则 hatch 的 force-include 会直接报错。
wheel: verify-versions web capsules
	rm -rf dist
	uv build --wheel

# 只传 wheel：sdist 需要用户本机有 npm/node 先构建前端，不适合作为默认安装路径。
publish: wheel
	uv publish dist/*.whl

# 打开装机版 App，并摘掉当前 shell 里可能残留的隔离变量。
# 直接用 `open -a` 时，App 会继承不管哪来的 YHUB_CONFIG_DIR，于是后端读临时配置根——
# 症状是 /api/tools 只剩几个工具、设置页里的路径在 /var/folders。
open-app:
	@env -u YHUB_CONFIG_DIR -u YHUB_LANG -u YHUB_SETTINGS_FILE -u YHUB_PORT open -a /Applications/Y-Hub.app
	@echo "已拉起 /Applications/Y-Hub.app（不继承 YHUB_* 隔离变量）"

# 本地开发插件：把插件目录软链进 build/dev-config，起一个 --reload 后端（改 plugin.py / locales 自动重起）。
#   make dev-plugin PLUGIN=~/Projects/yhub-plugin-zdic [PORT=8790]
dev-plugin:
	./scripts/dev-plugin.sh "$(PLUGIN)" $(if $(PORT),--port $(PORT),)

# 本机把当前代码装成 `yhub` 命令（PyPI 同款路径）。
# 坑：`uv tool install . --force` 会静默复用缓存 wheel（版本号没变时），
# 所以先 uv cache clean yhub；装完用 `yhub --version` 与 web/dist 的哈希核对。
install-backend:
	uv cache clean yhub
	uv tool install . --force
	@echo "已安装 → $$(command -v yhub)"
	@yhub --version

verify-backend:
	./packaging/verify-backend.sh

# 三面验收（MCP stdio 握手 + CLI --json 与 HTTP 同 body；先起后端：uv run yhub gui --no-open）
verify-cli:
	cd web && node verify-cli.mjs

# 插件验收：自己拉测试后端（空闲口，不碰 8790），装入→断言→disabled→清理→仓库零改动
verify-i18n:
	cd web && node ../scripts/verify-i18n.mjs
	uv run python scripts/verify-i18n-display.py

verify-plugins:
	uv run python scripts/verify-plugin-install.py
	cd web && node verify-plugins.mjs

# 随包 TiddlyWiki 的自动保存（真 Chrome + 真 PUT）：自己拉临时配置的测试后端
verify-tiddlywiki:
	cd web && node verify-tiddlywiki-save.mjs

verify-settings:
	./tauri/scripts/verify-settings-parity.sh

# 桌面编辑态（需后端在跑）：进/出编辑态、组件库加回、移除、拖放到指定位置
verify-edit-mode:
	cd web && node verify-edit-mode.mjs

web:
	cd web && npm run build

# 一次把 .app 打出来：beforeBuildCommand 会自己再跑一遍前端 + 胶囊（幂等）。
# 后端**不在包里**：壳启动时用已安装的 yhub（见 tauri/src/backend.rs）。
app:
	cd tauri && tauri build --bundles app

# 装机到 /Applications（本机自用）。脚本自带输入指纹：没改构建输入就秒过，不会白构建。
# 额外参数：make install ARGS="--force" / "--no-build" / "--no-restart"
install:
	./packaging/install-app.sh $(ARGS)

# 可选：main 上的每次提交按需自动装机（分钟级，会退出并重启 App）。
# 卸掉：make uninstall-hooks
install-hooks:
	@mkdir -p .git/hooks
	@chmod +x packaging/git-hooks/post-commit
	@ln -sf "$(CURDIR)/packaging/git-hooks/post-commit" .git/hooks/post-commit
	@echo "已装 post-commit hook → .git/hooks/post-commit"
	@echo "  它按需自动装机（YHUB_AUTOINSTALL=0 可关）；插件在独立仓库，不随核心提交同步"

uninstall-hooks:
	@rm -f .git/hooks/post-commit
	@echo "已卸 hook（手动装机仍是：make install；插件请用 yhub plugin install）"

# 插件清单：核心（随包分发）/ 第三方（可装卸）+ 各自启用状态
plugin-list:
	uv run yhub plugin list

# 装机版端到端验收（默认验 release 包；换包：make verify-app ARGS="<.app 路径>"）
verify-app:
	./tauri/scripts/verify-packed-app.sh $(ARGS)

smoke:
	cd web && npm run smoke

# 一条命令起「完整信息墙」：先确保 web/dist 在（force-include 的硬要求），再起服务。
# 已经构建过前端的话，这一步是幂等的秒过。
dashboard: web
	uv run yhub gui
