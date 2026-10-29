# Microduck PreviewTool

[中文](#中文) · [English](#english)

用一句话生成 Microduck 动作，在真实 MuJoCo 场景中查看，再用自然语言继续修改。

Describe a Microduck motion, inspect it in a real MuJoCo scene, and refine it in conversation.

<a id="中文"></a>

## 中文

### 先用起来

日常预览只需要三步：**描述动作 → 查看结果 → 继续修改或导出 MP4**。奖励配置、物理预检和审核包是可选的进阶功能。

1. 首次安装并检查环境（只需做一次）。在项目根目录运行：

   ```sh
   node codex-microduck-preview/scripts/microduck.mjs doctor
   node codex-microduck-preview/scripts/install.mjs
   ```

   Cursor 使用 `node codex-microduck-preview/scripts/install.mjs --cursor`。安装器会链接入口、父 skill 和四个子 skill。Codex 中使用 `$duck_go` 显式调用；支持透传的宿主也可使用 `/duck_go`。移动项目时应保留完整目录并重建链接。

2. 在对话里描述动作：

   > $duck_go 让 Microduck 先向前走，再抬起右脚保持两秒，并打开预览。

3. 用 `$duck_go 步子小一点` 继续调整。场地中可拖拽旋转、滚轮缩放，并执行、中止或复位动作；视频在点击导出时才编码。

`/duck_go` 是否能作为原生斜杠命令取决于宿主；如果输入框提示找不到命令，请使用 `$duck_go` skill 入口。

需要 Node.js ≥22.19、带 MuJoCo / NumPy / SciPy / Pillow / imageio / imageio-ffmpeg 的 Python，以及 Microduck 机器人资产仓库。换机器时配置 `MICRODUCK_PYTHON` 和 `MICRODUCK_ASSET_ROOT`，详见[运行与配置](codex-microduck-preview/references/usage.md)。新安装的 skill 若未出现，可重新加载宿主或新建对话。

### 两个使用入口

| 入口 | 使用方式 |
| --- | --- |
| Codex / Cursor skill | 对话里调用父 skill，打开返回的本地 `viewer_url`；无需运行或登录 DSH |
| DSH 插件 | 对话中调用 `duck_*` 工具，在该会话的 Microduck 视图中使用工作台；[安装与接入](dsh-microduck-preview/README.md) |

两者共用参数校验、Python 管线、奖励目录、审核包逻辑和界面资源。安装 skill 不会自动替换 DSH 中已安装的插件。

本地服务只监听 `127.0.0.1`，优先使用端口 `47832`，占用时改用空闲端口；请使用返回的 URL。每个对话展示独立的当前动作；新动作成功后替换本版本生成的旧动作，失败时保留上一个成功动作。升级前已有历史不会自动删除。运行时自动检查环境、提交和查询任务；普通用户无需手工管理 task id 或 session id。

### 工作台操作

自然语言可串联直行、转弯、单脚悬停和站立。侧移目前会明确替代为转弯后直行，并报告朝向变化；抬脚默认高度为 **0.04 m**。

右侧使用滑块或数值输入调整奖励、惩罚权重。可计算的项目提供“看演示”，在同一场地依次展示正常动作和受控扰动，并调用训练仓库中的同一个奖励函数；需要训练环境状态的项目不能演示。权重改变只影响训练配方，不改变当前参考动作，也不预测训练后的策略。

训练审核包仍可通过 CLI 或 DSH 工具生成，包含物理预检；工作台不启动训练。

### 结果如何理解

- `REAL` 表示按本次动作生成的真实模型渲染；`DEMO` 是明确标注的示例片段。
- 几何检查、动力学基线和训练验收分别报告。发生降级时展示实际替代动作和原因。
- 审核包直接复用训练仓库现有 CPU 环境和 BAM 执行器做参考目标回放；基线未完成会保留风险，不能据此宣布动作可上实机。
- 本项目不执行 PPO、不记录训练批准、不部署机器人，也不依赖其他动作模仿 skill。训练流程必须显式导入审核包并进行后续确认与验收。

### 命令行与配置

以下命令从项目根目录运行；将 `TASK_ID` 换成 `preview` 返回的任务标识：

```sh
node codex-microduck-preview/scripts/microduck.mjs preview --session my-chat --params '{"pattern":"hover","hover_foot":"right","lift_height_m":0.04,"hold_s":2}'
node codex-microduck-preview/scripts/microduck.mjs status --session my-chat --task TASK_ID
node codex-microduck-preview/scripts/microduck.mjs viewer --session my-chat --task TASK_ID
```

`preview` 默认立即返回任务，使用 `status` 查询同一任务，避免重复提交。手工调用 CLI 时，同一对话始终使用同一个稳定、唯一的 `--session`；省略时依次读取 `CODEX_THREAD_ID`、`CURSOR_CHAT_ID`。

完整命令、奖励编辑、审核包导出、环境变量和 JSON 配置见[运行与配置](codex-microduck-preview/references/usage.md)。DSH 的八个工具及 HTTP 接口见[插件 README](dsh-microduck-preview/README.md)。

### 开发与目录

```text
microduck-previewtool/
├── duck_go/                       # 显式调用入口
├── codex-microduck-preview/       # 父 skill、CLI、本地服务
├── microduck-preview-runtime/     # 运行时诊断与预览
├── microduck-motion-compose/      # 动作编排
├── microduck-reward-studio/       # 奖励配方与释义
├── microduck-train-pack/          # 审核包导出
├── dsh-microduck-preview/         # DSH 接入与共享核心、界面、Python 管线
└── .runtime/                     # 本地任务、日志和审核包，不纳入版本控制
```

从项目根目录运行回归：

```sh
node --test codex-microduck-preview/test/*.test.mjs dsh-microduck-preview/test/*.test.mjs
/path/to/robot/.venv/bin/python -B dsh-microduck-preview/test/pipeline_test.py
```

真实帧服务集成测试需要本机渲染环境和已有的真实动作任务，默认跳过；在 DSH 子目录通过 `npm run test:frames` 单独启用。管线接口见[管线 README](dsh-microduck-preview/pipeline/README.md)。

```sh
node codex-microduck-preview/scripts/install.mjs --check
node codex-microduck-preview/scripts/microduck.mjs stop
node codex-microduck-preview/scripts/install.mjs --uninstall
```

检查或卸载 Cursor 链接时追加 `--cursor`。安装器只管理本项目的六个技能链接，拒绝覆盖其他来源的内容；停止和卸载均保留项目与任务产物。

<a id="english"></a>

## English

### Start with a motion

The everyday workflow is **describe → preview → refine or export MP4**. Reward editing and review packages are optional advanced features.

Run from the project root:

```sh
node codex-microduck-preview/scripts/microduck.mjs doctor
node codex-microduck-preview/scripts/install.mjs
```

For Cursor, add `--cursor` to the installer. It links the `duck_go` entry, parent and four supporting skills; invoke `$duck_go` in Codex. A native `/duck_go` slash command depends on host support. Keep the complete project directory together.

> $duck_go Walk forward, lift the right foot for two seconds, and open the preview.

Then ask for smaller steps, a lower lift, or a longer hold. The playground supports camera orbit, zoom, execute, stop, reset and on-demand MP4 export. Requires Node.js ≥22.19, a rendering Python environment and the Microduck model checkout; see [runtime and configuration](codex-microduck-preview/references/usage.md).

### Shared workbench

The skill runs independently of DSH. The [DSH plugin](dsh-microduck-preview/README.md) exposes the same workbench inside the conversation's Microduck view. Both hosts share the pipeline, UI assets, reward catalogue and package logic. Installing the skill does not activate or update the DSH plugin.

The backend supports up to six motion segments, frame-aligned commands, task-bound reward recipes, real-function explanations in the playground, and review packages with BAM preflight and hashes. Hover defaults to 0.04 m. Sidestep requests explicitly substitute a 90° turn followed by straight travel.

Changing reward weights does not change the current reference animation. Explanation clips measure controlled perturbations; they do not predict a learned policy. Geometric validity, BAM baseline completion and training acceptance are separate outcomes. This project does not execute PPO, approve training or deploy a robot, and has no dependency on another motion-imitation skill.

### CLI and development

The service binds only to loopback, preferring port `47832` and falling back to a free port. Use the returned URL. Manual CLI calls need a stable unique `--session`, or the current `CODEX_THREAD_ID` / `CURSOR_CHAT_ID`. Submit once with `preview` and poll the returned task with `status`.

See [runtime and commands](codex-microduck-preview/references/usage.md), [DSH integration](dsh-microduck-preview/README.md) and [pipeline details](dsh-microduck-preview/pipeline/README.md). Regression commands and repository layout appear above. The installer supports `--check` and `--uninstall`; add `--cursor` for Cursor links. Source files and generated tasks remain after uninstall.
