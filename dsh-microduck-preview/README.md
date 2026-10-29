# Microduck 动作工作台 · DSH 插件

在 DSH 对话里描述动作，再打开同一对话的 **Microduck** 视图查看结果。可以继续说“步子小一点”“先左转，再抬右脚站一会儿”，动作与参数通过对话修改。

DSH 插件和 [Codex / Cursor skill](../README.md) 共用动作管线、参数校验、奖励目录和工作台界面。插件本身不启动 PPO，也不需要外部动作模仿 skill。

## 先完成一次预览

插件安装并启用后，在 DSH 对话中输入 `/duck_go 让 Microduck 倒退走 8 字，步子小一点`。如果宿主拦截未知斜杠命令，需使用该宿主支持的 skill 或普通文本入口；插件本身不能为宿主注册斜杠命令。

打开同一对话的 **Microduck** 视图，拖拽旋转、滚轮缩放，用“执行动作”“中止”和“复位”控制场地；需要视频时点击“导出视频”。右侧调整奖励与惩罚权重，支持的项目可点击“看演示”。新动作生成成功后替换当前动作，失败时保留当前动作。旧版本生成的历史文件不会自动删除。

## 按需使用进阶功能

### 串联动作

当前支持五种动作模式：直线 `line`、弧线 `arc`、8 字 `figure8`、多段组合 `composite` 和单脚悬停 `hover`。

多段组合最多六段，通过对话或工具编排直行、转弯、悬停和站立；段间生成运动学过渡。

```json
{
  "pattern": "composite",
  "segments": [
    { "kind": "straight", "length_m": 0.2 },
    { "kind": "turn", "turn_deg": 90, "radius_m": 0.12 },
    { "kind": "hover", "hover_foot": "right", "lift_height_m": 0.04, "hold_s": 2 },
    { "kind": "stand", "hold_s": 1 }
  ]
}
```

`turn_deg` 正值左转、负值右转；`hover_foot` 指抬起的脚，默认抬右脚 0.04 m。`sidestep` 接受 `side` 和 `length_m`，目前会明确替代为相应方向转 90°再直行，实际朝向也会改变。

微调只继承本对话上次未失败任务中与当前模式相关的参数。越界参数返回范围错误；几何不可行后采取的动作替代或参数调整会在警告中说明。

### 奖励与惩罚卡片

工作台只展示权重滑块、数值输入和可用的演示按钮。走路与单脚悬停采用不同的初始预设。配方绑定动作任务和对话，保存时生成不可变版本；未启用项不进入审核包。

- 目录只登记配置训练环境中已有的真实 Python 函数。函数或参数签名不匹配时，卡片标红且不能启用。
- 奖励权重 ≥ 0，惩罚权重 ≤ 0。修改权重会更新配方，不会改变当前运动学参考动画。
- 场地演示比较“正常参考”和“受控扰动”，调用同一个训练函数评分并缓存轨迹和逐帧得分。
- 运动学输入缺少真实传感器、力矩或控制器历史的项显示“仅训练后可见”，不生成替代得分或假动画。

场地演示不能预测调整权重后策略会学成什么样。

### 导出训练审核包

通过 `duck_pack` 工具或 CLI 对已完成的真实任务导出审核包。导出过程检查 motion / command 帧对齐、写入启用的奖励和验收标准，并直接调用训练仓库现有 CPU 环境与 BAM 执行器做参考控制器基线预检。DEMO 和未完成任务不能打包。

工具返回包目录、`review_id`、阻塞原因和风险；`duck_verify` 检查产物、机器人源码、奖励函数及工具源码哈希。

`handoff_ready` 表示审核输入齐备，仍需人审具体动作、风险和训练预算。训练流程必须显式导入 command / rewards / criteria。动作或物理配置改变后重新打包；奖励变化应使用新配方、新试训阶段。本插件没有批准、训练或部署命令。

## 安装与配置

需要 Node.js ≥ 22.19、Microduck 模型和训练仓库，以及带 MuJoCo、NumPy、SciPy、Pillow、imageio / imageio-ffmpeg 的 Python 环境。真实奖励释义和 BAM 预检还使用训练仓库的运行时；当前 CPU/BAM 入口为该仓库的 `scripts/train_microduck_cpu.py`。

以下是 DSH 插件管理工具的调用示意，不是终端 shell 命令：

```text
plugin_manager install_bundle target=/absolute/path/to/dsh-microduck-preview
plugin_manager set_bundle target=@local/dsh-microduck-preview enabled=true
plugin_manager remove_bundle target=@local/dsh-microduck-preview
```

本地目录安装会链接到 DSH profile。修改 Host JavaScript 后重新激活插件；刷新页面加载 Client。Python 脚本由新任务的子进程读取。DSH 的实际管理工具和参数应以所用版本为准。

配置写在 [cordis.patch.yml](cordis.patch.yml) 的插件 row 中。例如：

```yaml
- insert:
    - id: microduck-preview
      name: "@local/dsh-microduck-preview"
      config:
        engine: real
        python: "/absolute/path/to/microduck_rl-develop/.venv/bin/python"
        # 通常可省略，默认从 Python venv 推断资产仓库。
        # assetsRoot: "/absolute/path/to/microduck_rl-develop"
        dataDir: "~/.dsh/microduck-preview"
        waitMs: 90000
        preflightTask: "Mjlab-Velocity-Flat-MicroDuck"
        preflightSeeds: [123, 2026]
```

| 配置 | 默认 / 行为 |
| --- | --- |
| `engine` | `auto`；也可选 `real` 或 `demo` |
| `python` | `~/agent_zoo/microduck_rl-develop/.venv/bin/python`；保留 venv 路径 |
| `assetsRoot` | 从选定 Python venv 推断，模型应包含 `src/mjlab_microduck/robot/microduck/robot_groundcontact.xml` |
| `dataDir` | `~/.dsh/microduck-preview` |
| `waitMs` | `90000`；工具等待超出此值后返回任务状态，继续查询同一任务 |
| `demoVideo` | 可选的显式演示片段路径 |
| `preflightTask` | `Mjlab-Velocity-Flat-MicroDuck` |
| `preflightSeeds` | `[123, 2026]`；预检接受 1–4 个整数种子 |
| `taskCriteria` | 可选验收阈值；未指定的任务误差阈值保持 null，不自动判成功 |

`auto` 在管线脚本、`pipeline/ready.json` 和可执行 Python 都存在时选 `real`，否则选 `demo`。这只是引擎选择检查；实际依赖或渲染失败仍会返回错误。DEMO 使用预置片段，并明确标注“不是按本次参数渲染的动作”。

## Agent 工具参考

普通使用可直接描述动作，不需要记住工具名。

| 工具 | 用途 |
| --- | --- |
| `duck_templates` | 五种动作模板、当前参数范围和同调用方最近任务；通常先调用 |
| `duck_preview` | 提交动作；可传部分参数微调，返回任务 ID、状态和结果摘要 |
| `duck_status` | 查询同一任务，返回完成结果或错误；不重复提交 |
| `duck_doctor` | 检查配置路径、模型、奖励函数签名、BAM 入口存在性和引擎选择 |
| `duck_rewards` | 按任务 list / add / remove / set 奖励项，可设置权重、参数和生效阶段 |
| `duck_explain` | 为指定任务和奖励项生成或读取缓存释义短片 |
| `duck_pack` | 导出含物理预检的审核包；不启动 PPO |
| `duck_verify` | 按 `pack_id` 校验本调用方审核包的版本完整性 |

参数的实时合同由 `duck_templates` 给出。工具定义见 [index.js](index.js)，共享校验见 [lib/spec.js](lib/spec.js)。`duck_rewards` 的生效阶段接受 `all`、`walk`、`turn`、`hover`、`stand`、`transition`。

## 产物与检查边界

默认数据目录结构如下：

```text
~/.dsh/microduck-preview/
├── tasks/<task_id>/
│   ├── task.json
│   ├── params.json
│   ├── motion.json          # 真实动作，50 Hz / 14 关节
│   ├── command.json         # 同帧指令、阶段和支撑脚
│   ├── preview.mp4
│   ├── metrics.json
│   └── run.log
├── sessions/<session_id>/rewards/
│   ├── <task_id>.json
│   └── versions/            # 不可变配方版本
├── explain/<task_id>/<term_id>-<cache_key>/
│   ├── scores.json
│   └── explain.mp4          # 只有支持真实函数评分与渲染的项才生成
└── packs/<pack_id>/
    ├── motion.json
    ├── command.json
    ├── rewards.json
    ├── task_criteria.json
    ├── physics.json
    ├── robot_sources.json
    ├── tool_sources.json
    ├── review.json
    └── state.json
```

审核包还保留预览、预检日志和成功采集的 BAM 回放 / 模型文件。当前动作可在重启后恢复；服务重启时正在运行的任务会标成中断错误。

三个结果需要分别理解：

- **几何检查**检查关节范围、穿地和自碰撞等参考轨迹问题，不证明动态平衡。
- **BAM 预检**通过原 action scale / offset 和 BAM 执行器回放参考关节目标。参考姿态只在初始化时设置；预览代码不固定根部、不加辅助外力、不预填电机历史。首次终止即停止记录，排除自动 reset 后的数据。环境自身的随机化保持启用。
- **策略训练和实机验收**不在本插件内执行。BAM 原始参考控制器未完成全程会作为风险记录，不能直接推断该动作可学或不可学。

## 开发接入

Host 导出 `name` / `inject` / `apply`，依赖 `tools`、`webServer`。Client 通过 DSH ModuleLoader 注册 Web 插件。

| 入口 | 当前实现 |
| --- | --- |
| `conversation.view:microduck-preview` | 对话的 Microduck 视图，order 20；加载 `/api/microduck/workbench/?session_id=...` 同源 iframe |
| `tool.call.toolview:duck_preview` | 按 `callId` 关联任务的内嵌预览卡片 |
| `sidebar.right.tab.document:microduck-video` | 宿主提供 `documentPreviews` 时注册的可选视频预览 |

工作台为中文界面，只展示当前动作与权重设置。代码资源统一位于 [assets/](assets/)，与 skill viewer 使用同一份文件；HTML 中脚本和样式 URL 带内容哈希，以更新资源版本。

工作台从宿主 Session props 读取 `session_id`；Agent 工具当前使用 `exec.agent.id` 记录任务归属。接入具体 DSH 版本时，需核对这两个标识对应同一对话。新的共享工作台已做源码与模拟宿主测试；这些检查不等于已在当前真实 DSH 版本完成全部接入验收。

所有 HTTP 路由注册在 `/api/microduck`。处理器会先调用 DSH Connection 的 `requestRejection({ headers })`；宿主返回认证拒绝时，在提供数据或资源前返回相应 401 / 403。应从已认证的 DSH 页面访问工作台。工具和奖励 / 打包接口也检查任务归属，不接受其他调用方的任务作为调参或导出目标。

主要路由：

| 路由 | 内容 |
| --- | --- |
| `GET /api/microduck/workbench/` | 共享工作台 HTML、脚本与样式 |
| `GET /api/microduck/tasks?session_id=...` | 当前对话任务列表 |
| `POST /api/microduck/preview` | 工作台提交新任务 |
| `GET /api/microduck/tasks/<id>` | 详情、指标和错误 |
| `GET /api/microduck/tasks/<id>/scene` | 交互场景元数据 |
| `GET /api/microduck/tasks/<id>/frame` | 真实 MuJoCo JPEG 帧 |
| `GET|HEAD /api/microduck/tasks/<id>/video` | 支持 Range 的 MP4 |
| `GET /api/microduck/tasks/<id>/command` | 逐帧指令 |
| `GET|POST /api/microduck/rewards` | 奖励目录和任务配方 |
| `POST /api/microduck/tasks/<id>/explain` | 生成释义短片 |
| `POST /api/microduck/tasks/<id>/pack` | 导出审核包 |
| `GET /api/microduck/packs/<id>/verify` | 校验审核包 |
| `POST /api/microduck/viewer/release` | 释放当前帧 worker |

`FramePool` 在 DSH 中最多保留一个 worker，默认空闲 45 s 回收。工作台隐藏或不可见时停止取帧，切换任务时释放 worker。帧率和渲染耗时依赖硬件与模型，不作固定性能承诺。

## 开发验证

从此目录运行：

```sh
npm test
/path/to/project/.venv/bin/python -B test/pipeline_test.py
```

`npm test` 覆盖 Host / Client smoke、任务状态与参数、会话隔离、共享资源一致性、奖励配方和哈希校验。真实帧集成检查默认跳过，需要本机模型、Python、可用图形环境，以及默认 DSH 数据目录中一个已完成且保留 motion.json 的真实任务：

```sh
npm run test:frames
# 或显式指定本机已有的真实任务：
node test/frames.test.mjs TASK_ID
```

这些测试与手工真实 DSH 接入检查分开进行。更新 DSH 后还应确认八个工具注册、Microduck 对话视图加载、调用方标识匹配、未认证请求被宿主拒绝、真实任务可播放和导出。

更详细的 Python 管线说明见 [pipeline/README.md](pipeline/README.md)。现有 [样例文件](pipeline/samples/) 和 `pipeline/ready.json` 是历史机器上的运行证据，不能替代当前环境的检查，也不代表共享工作台已经在所有 DSH 版本上验证。
