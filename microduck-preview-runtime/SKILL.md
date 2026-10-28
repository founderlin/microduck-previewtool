---
name: microduck-preview-runtime
description: 诊断和启动 Microduck 本地预览运行时，打开真实 MuJoCo viewer，处理端口、资产、DEMO/降级和 MP4 导出。
---

# 预览运行时

CLI 位于相邻 `codex-microduck-preview/scripts/microduck.mjs`。首次使用或依赖失败运行 `doctor`，查看每项检查；`ok` 是预览可用性，`workbench_ok` 包含奖励目录。缺依赖不能用 DEMO 冒充真实结果。

`start` 自动复用经 projectRoot/instance 验证的服务；首选端口占用时分配空闲端口。使用返回 origin，不硬编码端口。`viewer --session ID [--task ID]` 返回工作台 URL。Codex 使用 `open_in_codex` 在右侧打开该 URL；Cursor 使用内置浏览器；宿主不支持时提供本地链接。

`preview` 立即返回任务，`status --session ID --task ID` 轮询同一个任务；不要重复提交。`history` 查看同对话历史。默认从 Python venv 推断资产仓库；解释器路径保留 venv，不解析成基础 Python。配置见 [usage](../codex-microduck-preview/references/usage.md)。

如实展示 REAL/DEMO、几何失败、轨迹降级、参数调整和实际动作。几何检查不证明动态平衡、策略质量或实机安全。`stop` 仅停止本项目验证过的服务，普通任务结束无需关闭用户正在查看的面板。
