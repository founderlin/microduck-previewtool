---
name: codex-microduck-preview
description: Microduck 动作工作台入口，按需求分发运行时诊断、串联动作时间轴、奖励惩罚卡片和训练审核包导出。支持 Codex、Cursor 与共享 DSH 插件。
---

# Microduck 动作工作台

只有用户消息以完整 `/duck_go` 开头（之后为空白或消息结束），或用户显式调用 `$duck_go` skill 时，才通过对话修改动作或权重；普通对话不执行修改。仅输入入口时说明用法。无法理解的指令先说明，不猜测执行。修改动作后展示更新后的当前动作，等待用户在场地中点击执行。此规则不拦截工作台自身的按钮和滑块。

宿主必须能够把 `/duck_go` 原文传给本 skill；不要假称已注册宿主原生斜杠命令。如果宿主拦截该输入，明确报告限制。

先按任务读取一个子 skill，再调用本目录 `scripts/microduck.mjs`。通过符号链接安装时，先解析本 skill 的真实目录；四个子 skill 与本目录相邻。

- doctor、启动服务、打开 viewer、导出 MP4、DEMO/降级/报错：读 [microduck-preview-runtime](../microduck-preview-runtime/SKILL.md)。
- 新动作、走路接单脚站、分段顺序、幅度/节奏微调、指令曲线：读 [microduck-motion-compose](../microduck-motion-compose/SKILL.md)。
- 奖励增删、权重、参数、生效时段、释义短片：读 [microduck-reward-studio](../microduck-reward-studio/SKILL.md)。
- “可以训练了”、审核包、物理预检：读 [microduck-train-pack](../microduck-train-pack/SKILL.md)。

同一对话始终使用稳定且唯一的 `--session`。优先当前 `CODEX_THREAD_ID`，Cursor 可用 `CURSOR_CHAT_ID` 或宿主提供的当前 chat id；都没有时新建本对话独有 ID 并在后续沿用。不得继承其他对话的任务。

DSH 的 `duck_*` 工具与 skill 共用参数校验、目录、配方版本、MuJoCo 管线及工作台资源。无 DSH 也可运行 CLI。只做运动学预览、奖励释义和审核材料；本项目没有 PPO 执行入口。机器人模型与训练函数以配置的训练仓库为准，不依赖其他动作模仿 skill。
