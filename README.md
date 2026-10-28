# Microduck PreviewTool

[中文](#中文) · [English](#english)

同一套 Microduck 动作工作台的两个入口：DSH 插件，以及 Codex / Cursor 使用的父 skill。父 skill 把运行时诊断、串联动作、奖励卡片和训练审核包分发给四个子 skill。两边共用工作台页面、参数校验、MuJoCo 管线和奖励目录。

Two entry points for the same Microduck motion workbench: a DSH plugin, and a parent skill for Codex and Cursor. The parent skill routes runtime checks, motion timelines, reward cards, and training review packs to four child skills. Both sides share the workbench page, parameter checks, MuJoCo pipeline, and reward catalog.

```text
microduck-previewtool/
├── dsh-microduck-preview/         # DSH plugin: tools, workbench page, Python pipeline
├── codex-microduck-preview/       # parent skill: CLI and local server; page assets link here
├── microduck-preview-runtime/     # runtime checks, viewer, MP4
├── microduck-motion-compose/      # timeline composition and per-frame commands
├── microduck-reward-studio/       # reward and penalty cards, explanation clips
├── microduck-train-pack/          # review-pack export and BAM preflight
└── .runtime/codex/                # tasks, logs, and server state; created at runtime
```

---

<a id="中文"></a>

## 中文

在 Codex 或 Cursor 里用自然语言编排动作：最多六段时间轴，逐帧速度与支撑脚，按动作版本绑定的奖励卡片，以及带 BAM 预检和哈希校验的审核包。交互在右侧内置浏览器里完成：旋转视角、播放、拖动时间轴、编辑参数、导出 MP4。

`codex-microduck-preview` 是入口。安装器一次管理五个技能链接。Codex 写入 `${CODEX_HOME:-~/.codex}/skills`；Cursor 加 `--cursor`，写入 `~/.cursor/skills`。其他具备技能目录、本地命令和浏览器预览的应用，把这五个目录放进自己的技能目录后，继续使用同一套 CLI。宿主没有内置浏览器时，打开 `viewer` 返回的本地地址。

原有 DSH 插件安装保持原样。Skill 与插件读取相邻的 `dsh-microduck-preview`。在 Codex 或 Cursor 里运行 skill 不需要 DSH 登录或 DSH 服务。DSH 页面从 `/api/microduck/workbench/` 加载同一份资源，并保留浏览器认证。

### 安装和启动

需要 Node.js >= 22.19、带 MuJoCo 等渲染依赖的 Python，以及 Microduck 机器人模型资产。模型路径可以省略，默认从配置的 Python venv 推断。换机器时用环境变量或配置文件调整。

```sh
cd codex-microduck-preview
node scripts/microduck.mjs doctor
node scripts/install.mjs
node scripts/install.mjs --cursor
```

`doctor` 里 `ok` 表示预览可以跑，`workbench_ok` 还包含奖励目录是否已从训练仓库解析。缺依赖时结果会标明不可用。

在新对话中输入：

> 使用 $codex-microduck-preview，让 Microduck 先直行，再右脚抬起站 2 秒，并打开交互预览。

随后可以继续说「抬脚保持再短一点」，或「把 upright 权重调到 2.5，并出一条释义短片」。技能保留当前对话的上次参数。新安装后如果还没发现技能，重新加载 Codex 或 Cursor。

也可以直接使用 CLI：

```sh
node scripts/microduck.mjs preview --session my-chat --params '{"pattern":"composite","segments":[{"kind":"straight","length_m":0.2},{"kind":"hover","hover_foot":"right","lift_height_m":0.04,"hold_s":2},{"kind":"stand","hold_s":1}]}'
node scripts/microduck.mjs status --session my-chat --task TASK_ID
node scripts/microduck.mjs viewer --session my-chat
node scripts/microduck.mjs rewards set --session my-chat --task TASK_ID --id upright --weight 2.5 --params '{"std":0.25}' --phases hover,stand
node scripts/microduck.mjs rewards explain --session my-chat --task TASK_ID --id upright
node scripts/microduck.mjs pack --session my-chat --task TASK_ID
node scripts/microduck.mjs verify --pack /absolute/pack-directory
```

`viewer` 返回本地 URL。服务只监听 `127.0.0.1`，优先端口 `47832`，占用时改用空闲端口，以返回的地址为准。`preview` 默认立即返回任务，再用 `status` 查询。同一对话使用稳定的 `--session`。完整配置、命令和卸载说明见 [usage](codex-microduck-preview/references/usage.md)。

### 动作时间轴

- 直线、弧线、八字，以及最多六段的组合：直行、转弯、单脚悬停、站立。时间轴可以增删和排序。
- 抬脚默认 0.04 m。侧移请求会改写成朝该方向转 90° 再直行，并在结果里写明朝向变化。
- 同一对话可以继承历史参数，或用 `--base-task` 指定本对话里的某次任务再微调。换动作时，上一段的 `segments` 留在原来的任务里。越界参数返回带范围的错误。
- 每条动作写出 50 Hz、14 关节的 `motion.json`，以及逐帧对齐的 `command.json`（vx、wz、阶段、支撑脚）。曲线描述的是编写出的参考指令。

### 奖励卡片

- 卡片按任务和会话保存。每次修改生成一个不可变配方版本。走路和悬停使用不同的初始预设。未启用的卡片留在审核包外。
- 目录 `dsh-microduck-preview/rewards/catalog.json` 只登记训练仓库里的真实函数。`doctor` 用配置的 Python 环境核对函数名和参数签名。对不上的卡片标红，并且不能启用。奖励权重保持 ≥ 0，惩罚权重保持 ≤ 0。
- `rewards explain` 用同一个训练函数，给标注过的运动学输入打分，并缓存正常与受控扰动的短 MP4。缓存键包含动作、指令、参数、函数源码和渲染实现。力矩、真实接触时序、控制器历史等缺失项标成 `training_only`。
- 卡片状态保持「仅释义 / 未试训」。改权重只更新配方。

### 训练审核包

`pack` 为当前完成的真实任务新建一个审核目录，内容包括：

- `motion.json`、`command.json`
- 仅启用项的 `rewards.json`，并记录函数和参数来源
- `task_criteria.json`：未配置的阈值保持 null
- `physics.json`：预检是否执行、几何是否有硬错误、原始基线是否跑完、风险和失败原因
- 机器人源码摘要，以及 `review.json` 里的文件哈希

物理预检调用训练仓库现有的 CPU 运行时、已注册速度环境和原始 BAM 执行器。参考姿态只在初始时刻写入；之后使用自由根、正常动作、正常 BAM 延迟和摩擦。首次终止即停止采集。

`verify` 对照产物、机器人源码、奖励函数和工作台工具的哈希。`handoff_ready` 表示审核输入已经齐备。训练流程需要显式导入 command、rewards 和 criteria。可选配置 `preflightTask`（默认 `Mjlab-Velocity-Flat-MicroDuck`）、`preflightSeeds`（默认 `[123, 2026]`，最多四个）和 `taskCriteria`。

DEMO、未完成任务、缺少 motion/command，或帧对不齐时，`pack` 会拒绝导出。

### 预览交互

- 真实 MuJoCo 按需渲染：拖拽环视、滚轮缩放、跟随相机、时间轴和单次播放。
- 手工调参后生成新任务，可查看几何指标、警告和错误，并导出支持 Range 的 MP4。
- 对话里给出摘要和结果。完整交互在 Codex 或 Cursor 内置浏览器里完成。

DSH 保留 `duck_templates`、`duck_preview`、`duck_status`，并增加 `duck_doctor`、`duck_rewards`、`duck_explain`、`duck_pack`、`duck_verify`。插件细节见 [dsh-microduck-preview/README.md](dsh-microduck-preview/README.md)。

本项目交付运动学预览、奖励释义和审核材料。几何通过、预检跑完、审核包可交接，分别单独记录。DEMO 片段和轨迹降级都会显式标记。训练执行留在训练仓库。

### 开发和验证

```sh
cd codex-microduck-preview && npm test
cd dsh-microduck-preview && npm test
cd dsh-microduck-preview && python test/pipeline_test.py
```

安装脚本只创建五个技能链接，拒绝覆盖其他内容，也不修改全局 MCP 配置。

```sh
node scripts/install.mjs --check
node scripts/microduck.mjs stop
node scripts/install.mjs --uninstall
```

停止和卸载不会删除项目或任务产物。

---

<a id="english"></a>

## English

Compose motions in Codex or Cursor with natural language: a timeline of up to six segments, per-frame velocity and support foot, reward cards bound to that motion version, and a review pack with BAM preflight and file hashes. Interaction stays in the built-in browser on the right: orbit the camera, play, scrub the timeline, edit parameters, and export an MP4.

`codex-microduck-preview` is the entry skill. The installer manages five skill links together. Codex installs into `${CODEX_HOME:-~/.codex}/skills`. Cursor uses `--cursor` and installs into `~/.cursor/skills`. Another app with a skills directory, local commands, and a browser preview can place the same five directories in its own skills folder and keep using the CLI. If the host has no built-in browser, open the local URL returned by `viewer`.

The existing DSH plugin installation is left unchanged. The skill and the plugin both read the adjacent `dsh-microduck-preview` package. Running the skill from Codex or Cursor does not require a DSH login or a running DSH service. The DSH page loads the same assets from `/api/microduck/workbench/` and keeps DSH browser authentication.

### Install and start

Requires Node.js >= 22.19, a Python environment with MuJoCo and the other render dependencies, and the Microduck robot model assets. The model path can be omitted; it is inferred from the configured Python venv. On another machine, override the paths with environment variables or a config file.

```sh
cd codex-microduck-preview
node scripts/microduck.mjs doctor
node scripts/install.mjs
node scripts/install.mjs --cursor
```

In `doctor`, `ok` means preview can run. `workbench_ok` also covers whether the reward catalog resolved against the training checkout. Missing dependencies are reported as unavailable.

In a new chat:

> Use $codex-microduck-preview. Have Microduck walk straight, then hold a right-foot lift for 2 seconds, and open the interactive preview.

You can then say “shorten the hold” or “set the upright weight to 2.5 and render an explanation clip.” The skill keeps the last parameters from the current conversation. If a freshly installed skill is not discovered, reload Codex or Cursor.

The CLI works on its own:

```sh
node scripts/microduck.mjs preview --session my-chat --params '{"pattern":"composite","segments":[{"kind":"straight","length_m":0.2},{"kind":"hover","hover_foot":"right","lift_height_m":0.04,"hold_s":2},{"kind":"stand","hold_s":1}]}'
node scripts/microduck.mjs status --session my-chat --task TASK_ID
node scripts/microduck.mjs viewer --session my-chat
node scripts/microduck.mjs rewards set --session my-chat --task TASK_ID --id upright --weight 2.5 --params '{"std":0.25}' --phases hover,stand
node scripts/microduck.mjs rewards explain --session my-chat --task TASK_ID --id upright
node scripts/microduck.mjs pack --session my-chat --task TASK_ID
node scripts/microduck.mjs verify --pack /absolute/pack-directory
```

`viewer` returns a local URL. The service binds only to `127.0.0.1`, prefers port `47832`, and falls back to a free port. Use the URL the command returns. `preview` returns the task immediately by default; poll it with `status`. Keep one stable `--session` for the conversation. Configuration, commands, and uninstall steps are in [usage](codex-microduck-preview/references/usage.md).

### Motion timeline

- Straight lines, arcs, figure-eights, and composites of up to six segments: straight, turn, single-foot hover, and stand. Segments can be inserted, deleted, and reordered.
- The default foot lift is 0.04 m. A sidestep request is rewritten as a 90° turn toward that side followed by straight travel, and the heading change is reported.
- One conversation can inherit earlier parameters, or retune a chosen past task in that conversation with `--base-task`. When the motion changes, the previous task keeps its own `segments`. Out-of-range parameters return an error that includes the allowed range.
- Each motion writes a 50 Hz, 14-joint `motion.json` and a frame-aligned `command.json` (vx, wz, stage, support foot). The curves describe the authored reference command.

### Reward cards

- Cards are stored per task and per session. Each edit saves an immutable recipe version. Walk and hover start from different presets. Disabled cards stay out of the review pack.
- `dsh-microduck-preview/rewards/catalog.json` lists callables that exist in the training checkout. `doctor` checks function names and parameter signatures with the configured Python environment. A card that does not match is marked red and stays disabled. Reward weights stay ≥ 0 and penalty weights stay ≤ 0.
- `rewards explain` scores labeled kinematic inputs with that same training function and caches short normal and controlled-perturbation MP4s. The cache key covers the motion, command, parameters, function source, and renderer. Torque, real contact timing, and controller history are marked `training_only` when those signals are absent.
- Card status stays “explanation only / not trial-trained.” Changing a weight updates the recipe.

### Training review pack

`pack` writes a new review directory for a completed real task. It contains:

- `motion.json` and `command.json`
- `rewards.json` for enabled cards only, with function and parameter provenance
- `task_criteria.json`, with null left for any threshold that was not configured
- `physics.json`: whether preflight ran, whether geometry has hard errors, whether the original baseline finished, plus risks and the failure reason
- a robot-source summary and file hashes in `review.json`

Physical preflight calls the training checkout’s existing CPU runtime, its registered velocity environment, and the original BAM actuator. The reference pose is written once at the start. Later steps use a free root, normal actions, normal BAM delays, and friction. Recording stops at the first termination.

`verify` checks hashes for artifacts, robot sources, reward functions, and workbench tools. `handoff_ready` means the review inputs are complete. The training workflow imports command, rewards, and criteria explicitly. Optional settings are `preflightTask` (default `Mjlab-Velocity-Flat-MicroDuck`), `preflightSeeds` (default `[123, 2026]`, at most four), and `taskCriteria`.

`pack` refuses DEMO clips, unfinished tasks, missing motion or command files, and frame-count mismatches.

### Preview interaction

- On-demand MuJoCo rendering: drag to orbit, scroll to zoom, follow camera, timeline scrub, and a single play-through.
- Manual parameter edits create a new task, with geometry metrics, warnings, errors, and a Range-capable MP4 export.
- The conversation shows a summary and the result. Full interaction stays in the Codex or Cursor built-in browser.

DSH keeps `duck_templates`, `duck_preview`, and `duck_status`, and adds `duck_doctor`, `duck_rewards`, `duck_explain`, `duck_pack`, and `duck_verify`. Plugin details are in [dsh-microduck-preview/README.md](dsh-microduck-preview/README.md).

This project delivers kinematic preview, reward explanation, and review material. A geometry pass, a finished preflight, and a handoff-ready pack are recorded separately. DEMO clips and trajectory degradation are labeled explicitly. Training execution stays in the training repository.

### Develop and verify

```sh
cd codex-microduck-preview && npm test
cd dsh-microduck-preview && npm test
cd dsh-microduck-preview && python test/pipeline_test.py
```

The installer only creates the five skill links, refuses to overwrite anything else, and does not change global MCP configuration.

```sh
node scripts/install.mjs --check
node scripts/microduck.mjs stop
node scripts/install.mjs --uninstall
```

Stopping or uninstalling does not delete the project or task artifacts.
