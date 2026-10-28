# Microduck PreviewTool

[中文](#中文) · [English](#english)

同一套 Microduck 预览管线的两个入口：DSH 插件，以及 Codex skill 加独立本地交互 viewer。

Two entry points for the same Microduck preview pipeline: a DSH plugin, and a Codex skill with a standalone local interactive viewer.

```text
microduck-previewtool/
├── dsh-microduck-preview/       # DSH plugin copy: tools and UI
├── codex-microduck-preview/     # Codex skill, CLI, local server, and web viewer
└── .runtime/codex/              # tasks, logs, and server state; created at runtime
```

---

<a id="中文"></a>

## 中文

在 Codex 里用自然语言生成和微调动作，并在右侧内置浏览器中旋转视角、播放、拖动时间轴、编辑参数、导出 MP4。

原有 DSH 插件安装保持原样。本项目使用相邻 DSH 副本中的核心模块和 Python 管线；Codex 运行不需要 DSH 登录或 DSH 服务。

### 安装和启动

需要 Node.js >= 22.19、带 MuJoCo 等渲染依赖的 Python，以及 Microduck 机器人模型资产。默认配置沿用本机已有解释器和资产目录；换机器时用环境变量或配置文件调整。

```sh
cd codex-microduck-preview
node scripts/microduck.mjs doctor
node scripts/install.mjs
```

在 Codex 新对话中输入：

> 使用 $codex-microduck-preview，让 Microduck 倒退走 8 字，步子小一点，并打开交互预览。

随后可以继续说「圈再大一点」。技能会保留当前对话的上次参数，只调整半径。新安装后如果还没发现技能，重新加载 Codex。

也可以直接使用 CLI：

```sh
node scripts/microduck.mjs preview --session my-chat --params '{"pattern":"figure8","direction":"backward","step_length_m":0.025,"radius_m":0.10}'
node scripts/microduck.mjs status --session my-chat --task TASK_ID
node scripts/microduck.mjs viewer --session my-chat
```

`viewer` 返回本地 URL。CLI 按需启动独立服务，只监听本机 `127.0.0.1:47832`。`preview` 默认立即返回任务，再用 `status` 查询，不需要重复提交。完整配置、命令和卸载说明见 [usage](codex-microduck-preview/references/usage.md)。

### 预览能力

- 直线、弧线、八字、组合轨迹和单脚悬停。
- 同一对话的历史与参数继承，也可以指定历史任务再微调。
- 真实 MuJoCo 按需渲染：拖拽环视、滚轮缩放、跟随相机、时间轴和单次播放。
- 手工调参后生成新任务，查看几何指标、警告和错误，并导出支持 Range 的 MP4。
- 对话里展示摘要和结果；完整交互在 Codex 内置浏览器的侧边面板完成。原生自定义聊天卡片不是已实现能力。

本项目提供运动学和几何预览。几何检查通过，并不代表动力学平衡验证、策略训练通过或实机可执行。DEMO 和轨迹降级都会显式标记；缺少依赖时不会伪装成真实结果。

### 开发和验证

在 Codex 子目录运行其 `package.json` 里的检查命令。DSH 副本保留原 `test/` 用例；插件安装与 DSH 接入见 [dsh-microduck-preview/README.md](dsh-microduck-preview/README.md)。安装脚本只创建技能链接，拒绝覆盖其他内容，也不修改全局 MCP 配置。

```sh
node scripts/install.mjs --check
node scripts/microduck.mjs stop
node scripts/install.mjs --uninstall
```

停止和卸载不会删除项目或任务产物。

---

<a id="english"></a>

## English

Generate and tune motions in Codex with natural language, then orbit the camera, play, scrub the timeline, edit parameters, and export an MP4 in the built-in browser on the right.

The existing DSH plugin installation is left unchanged. This project uses the core modules and Python pipeline from the adjacent DSH copy. The Codex path does not require a DSH login or a running DSH service.

### Install and start

Requires Node.js >= 22.19, a Python environment with MuJoCo and the other render dependencies, and the Microduck robot model assets. Defaults follow the interpreter and asset directory already present on this machine. On another machine, override them with environment variables or a config file.

```sh
cd codex-microduck-preview
node scripts/microduck.mjs doctor
node scripts/install.mjs
```

In a new Codex chat:

> Use $codex-microduck-preview. Have Microduck walk a figure-eight backward with shorter steps, and open the interactive preview.

You can then say “make the loop a bit larger.” The skill keeps the last parameters from the current conversation and changes only the radius. If a freshly installed skill is not discovered, reload Codex.

The CLI works on its own:

```sh
node scripts/microduck.mjs preview --session my-chat --params '{"pattern":"figure8","direction":"backward","step_length_m":0.025,"radius_m":0.10}'
node scripts/microduck.mjs status --session my-chat --task TASK_ID
node scripts/microduck.mjs viewer --session my-chat
```

`viewer` returns a local URL. The CLI starts a standalone server on demand and binds only to `127.0.0.1:47832`. `preview` returns the task immediately by default; poll it with `status` instead of submitting it again. Configuration, commands, and uninstall steps are in [usage](codex-microduck-preview/references/usage.md).

### Preview

- Straight lines, arcs, figure-eights, composite paths, and single-foot hover.
- History and parameter inheritance inside one conversation, including retuning a chosen past task.
- On-demand MuJoCo rendering: drag to orbit, scroll to zoom, follow camera, timeline scrub, and single play-through.
- Manual parameter edits create a new task, with geometry metrics, warnings, errors, and a Range-capable MP4 export.
- The conversation shows a summary and the result. Full interaction stays in the Codex built-in browser side panel. Native custom chat cards are not an implemented feature.

This project is a kinematic and geometric preview. A passing geometry check is not dynamic-balance validation, a trained policy, or proof that the motion can run on the real robot. DEMO clips and trajectory degradation are labeled explicitly. Missing dependencies are never presented as a real render.

### Develop and verify

Run the check scripts in `codex-microduck-preview/package.json` from that directory. The DSH copy keeps its original `test/` cases. Plugin install and DSH integration are documented in [dsh-microduck-preview/README.md](dsh-microduck-preview/README.md). The installer only creates the skill link, refuses to overwrite anything else, and does not change global MCP configuration.

```sh
node scripts/install.mjs --check
node scripts/microduck.mjs stop
node scripts/install.mjs --uninstall
```

Stopping or uninstalling does not delete the project or task artifacts.
