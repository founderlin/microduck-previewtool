# @local/dsh-microduck-preview

Microduck 双足机器人**步态运动预览**的 DSH 插件：在 DSH Web 里说一句中文（例如「倒退走8字，步子小一点」），模型调用插件工具，后台用 Microduck 自带的 MuJoCo 管线生成动作（实测约 20–30 s），然后在 Web 面板的**交互式 MuJoCo 场景 viewer** 里实时播放/拖动视角与时间轴（同时产出 mp4 供下载、对话卡片与右侧 Sidebar 预览）。

> 任务书：`/Users/founderlin/Desktop/RL研发/microduck-preview/docs/plan-v0.md`（plan-v0）。
> 本仓库是该任务书的实现。只做**预览**，不做球类交互、不做训练/PPO、无云端/账号/数据库。

---

## 1. 已验证的运行环境（升级需回归）

| 项 | 值 |
|---|---|
| DSH | **0.2.1-rc.3**（DeepSeek Harness.app / desktop profile，`dsh-desktop-runtime`） |
| 插件协议 | Host：named exports `apply` / `inject` / `name`；Client：`window.__ModuleLoader__.load({ id, factory })`，`dsh.client.platform: web`，`dsh.client.inject: []` |
| Node | v26.5.0（要求 ≥ 22.19） |
| Python | `/Users/founderlin/agent_zoo/microduck_rl-develop/.venv/bin/python`（mujoco 3.10.0 / numpy 2.4.1 / scipy 1.18.0 / imageio 2.37.2 / Pillow 12.2.0） |
| 外部资产 | `/Users/founderlin/Desktop/RL研发/microduck-marseille`（只读调用，不复制、不修改） |

DSH 处于 developer preview：**本插件只针对 0.2.1-rc.3 验证过**。升级 DSH 后按第 8 节回归清单复测。

---

## 2. 注册面（Host + Browser）

### Host half（`index.js` + `lib/`）

| 注册点 | 内容 |
|---|---|
| `ctx.tools.register` | `duck_templates`、`duck_preview`、`duck_status` |
| `ctx.webServer.register` | `prefix` 路由 `/api/microduck`（`lib/http.js`），自带 Range 流式 mp4 |
| 任务运行器 | `lib/tasks.js`：单槽队列、子进程调用管线、任务目录持久化、重启恢复 |

`/api/microduck/*` 比 Connection 的 `/api` 前缀更长，会命中本插件路由，因此**路由内部自己重放** `ctx.connection.requestRejection({headers})`（DSH 的 Host/Origin + 签名 cookie 校验）——未认证请求返回 401，不会绕过 DSH 的浏览器认证栅栏。

| 路由 | 说明 |
|---|---|
| `GET /api/microduck/tasks` | 任务列表 + 引擎状态（`engine` / `pipeline_ready` / `engine_reason`） |
| `GET /api/microduck/tasks/<id>` | 任务详情（含 raw metrics，失败时附 `run.log` 尾部） |
| `GET|HEAD /api/microduck/tasks/<id>/video` | mp4 流，支持 `Range`（206 + `Content-Range`、`bytes=-N` 后缀范围、416） |
| `GET /api/microduck/tasks/<id>/metrics` | 原始 `metrics.json` |
| `GET /api/microduck/presets` | 模板 + 参数 schema（与 `duck_templates` 同源） |
| `GET /api/microduck/health` | 引擎/管线就绪状态 |

### Browser half（`client.js`）

| Slot | key/id | 作用 |
|---|---|---|
| `conversation.view` | `microduck-preview`（order 20） | **会话视图（本插件的主界面）**：在 Session header 的 View tab 里，位于 Chat / Trajectory 之后；顶部是**动作卡片 Tab 条**（每个预览动作一个 tab），下方是选中动作的交互式 MuJoCo 场景 + 参数卡 + 指标/几何检查 |
| `tool.call.toolview` | `duck_preview` | 对话流内嵌视频卡片（按 `callId` 关联任务，运行中自动刷新） |
| `sidebar.right.tab.document` | `microduck-video` | 右侧 Sidebar 文档预览的 **mp4 渲染器**（`ctx.documentPreviews.register`，`loading: 'renderer'`，通过同源 Range 路由播放） |

会话视图的**动作卡片 Tab**：每条预览任务渲染成一个 tab（状态点 + 中文动作名，如 `前进8字 R0.10`、`复合 · 直行→左转→右转`、`单脚悬停 · 右脚4cm`；DEMO/运行中分别带标记与耗时）。横向滚动、自动把当前 tab 滚入视野；点 tab 切换下方 viewer 与参数卡，hover 有完整参数与任务 id 的 tooltip。

会话视图从 standard props 拿 `sessionId`，任务列表走 `GET /api/microduck/tasks?session_id=<id>`（Host 按 `task.session_id` 过滤）；视图头部的 **All sessions** 可放开到全部会话。ownerProps 的 `viewRequest` / `completeViewRequest` 支持「从别处跳到本视图并聚焦任务」的一次性请求（按 task id 或 `call_id` 匹配）。

UI chrome 为英文、主题用 `--dsw-alias-*` token；`localStorage` 持久化选中任务（刷新后保持）。

### 交互式 viewer（Live MuJoCo scene，不是播放 mp4）

会话视图默认 tab 是**真实 MuJoCo 场景**：画面不是预编码视频，而是 Host 侧常驻的 MuJoCo 进程按 viewer 传来的**时间 + 自由相机六参**实时渲染、逐帧回传的 JPEG。

- 交互：拖拽 = 绕体轨道相机（az/el），滚轮 = 缩放（dist 0.12–2.4 m），`Play/Pause`、`±1 帧`、时间轴 scrub、`Follow/Front/Side/Top` 视角预设、阴影开关。
- 地面是**棋盘格**（builtin checker 纹理 + box 地板；plane 的 UV 退化，且颜色纹理必须落在 `mjTEXROLE_RGB`=1 槽位），mp4 与实时帧共用同一套 `add_checker_floor()`。
- 数据流：`GET /api/microduck/tasks/<id>/scene`（时长/可交互性/默认相机）→ 循环 `GET .../frame?t&az&el&dist&follow&lx&ly&w&h&shadows&q`（`image/jpeg`，回 `x-mujoco-ms` 渲染耗时）。
- Host 侧：`lib/frames.js` 的 `FramePool` **单 worker**（每任务一个常驻 `pipeline/frame_server.py`，~800 MB/进程），空闲 **45 s** 回收；viewer 关闭/切任务时主动 `POST /api/microduck/viewer/release` 立即释放。
- **性能/交互优化**（防止拖垮整个页面的主线程）：默认 **720×480、无阴影、24 fps 上限**；帧直接写 `<img>.src`（**不经 React setState**，HUD/时间轴 4 Hz 节流）；播放**单遍**到结尾即停；页面隐藏或视图不可见（IntersectionObserver）时停止取帧。
- 实测（900×600、开阴影、含进程内渲染 + 写读文件 + HTTP 往返）：**p50 ≈ 21 ms、p95 ≈ 28 ms、JPEG ≈ 26 KB**；720×480 无阴影更快，交互帧率默认锁在 24 fps 以免抢占主线程。
- 降级：`engine: demo` 或缺少 `motion.json` 的任务 `scene.interactive=false`，视图自动切到 `Recorded mp4` 并说明原因；真实任务两者都有，可自由切换。

---

## 3. 工具契约

### `duck_templates()`
返回 JSON 字符串：3 个模板（line / arc / figure8）、每个参数的 `type/范围/默认值/中文同义词`、`tuning_rule`、`output_contract`、**`recent_tasks`（最近 5 个任务的完整 params + video_url）**、`last_params`。
→ 参数微调（「圈再大一点」）就靠它：以 `last_params` 为基准只改一个字段再调 `duck_preview`。

### `duck_preview(params)`
参数（全部可选，缺省用默认值，因此微调可只传一个字段）：

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `pattern` | `line` \| `arc` \| `figure8` \| `composite` \| `hover` | `line` | 轨迹；接受中文同义词（直线/绕圈/8字…）；`composite` = 多段序列；`hover` = 原地单脚悬停 |
| `direction` | `forward` \| `backward` | `forward` | 前进/倒退 |
| `step_length_m` | 0.02–0.06 | 0.04 | 步长；“步子小一点” → 0.02–0.03 |
| `radius_m` | 0.05–0.15 | 0.09 | arc/figure8 半径；“圈再大一点” → +0.01–0.02 |
| `laps` | 0.5–3 | 1 | arc=圈数、figure8=8字个数、line=趟数（1 趟≈0.6 m） |
| `speed` | `slow` \| `normal` \| `fast` | `normal` | 节奏 |
| `segments` | 数组（≤6 段） | 见下 | **仅 `composite`**：`{kind:"straight",length_m}` 或 `{kind:"turn",turn_deg,radius_m}`（也接受 `kind:"left"/"right"`，`turn_deg` 正=左、负=右） |
| `hover_foot` | `left` \| `right` | `right` | **仅 `hover`**：**抬起**的那只脚（另一只支撑） |
| `lift_height_m` | 0.02–0.08 | 0.04 | **仅 `hover`**：鞋底离地高度；0.04 余量最稳（9°），0.05+ 会更像“抬腿”但余量变小 |
| `hold_s` | 0.5–5 | 2.5 | **仅 `hover`**：抬起后保持时长 |

`composite` 省略 `segments` 时的默认序列正好对应「往前走，然后向左转弯，再向右转」：
`[{straight 0.35 m}, {turn +90°, R0.12}, {turn -90°, R0.12}]`。
范围：straight 0.05–1.5 m、`|turn_deg|` 0.1–180°、转弯半径 0.06–0.30 m（该机器人实测可转下限 ≈0.10 m，更小的半径会被上调并在 `warnings` 说明）。

越界/未知参数**不会静默 clamp**，而是抛出一句带范围、带修改建议的中文错误（模型直接转述给用户）。
返回：`ok / status / task_id / engine / video_path / video_url / frames / duration_s / geometry_ok / degraded / degrade_reason / warnings / elapsed_s / error / summary`。
运行超过 `waitMs`（默认 90 s）仍未完成时返回 `status: running` 并提示改用 `duck_status`，**不重复提交任务**。

### `duck_status(task_id)`
立即返回同一形状；`status=done` 时给 mp4 路径与指标，`status=error` 时给原因（含管线 stderr 尾部）。

---

## 4. 配置（`cordis.patch.yml` 的 row config，全部可选）

```yaml
- id: microduck-preview
  name: "@local/dsh-microduck-preview"
  config:
    engine: auto                      # auto | real | demo
    assetsRoot: "/Users/founderlin/Desktop/RL研发/microduck-marseille"
    python: "/Users/founderlin/agent_zoo/microduck_rl-develop/.venv/bin/python"
    dataDir: "~/.dsh/microduck-preview"
    waitMs: 90000
    # demoVideo: "/abs/path/to/clip.mp4"   # 覆盖 demo 片段
```

**引擎选择**（`auto`）：`pipeline/run_preview.py` 存在 **且** `pipeline/ready.json` 存在 **且** 解释器可执行 → `real`；否则 `demo`。
`demo` 会把预置片段复制成 `preview.mp4`，并在 `metrics.engine`、工具返回、面板标签（DEMO）三处**明确标注“不是本次参数渲染的动作”**，绝不冒充真实结果。

---

## 5. 任务产物（持久化）

```
~/.dsh/microduck-preview/tasks/<task_id>/
├─ task.json     # 状态机记录（重启后据此恢复历史；running→error 标记中断）
├─ params.json   # 本次参数
├─ preview.mp4   # 预览视频
├─ metrics.json  # 帧数/时长/几何检查/降级/参数回显
└─ run.log       # 真实管线的 stdout/stderr（失败时取尾部落错误）
```

---

## 6. Python 管线契约（`pipeline/`）

```
<python> pipeline/run_preview.py --params-json <dir>/params.json --out-dir <dir>
```

- 退出码 0 → 必须产出 `<dir>/preview.mp4` + `<dir>/metrics.json`（h264/yuv420p、`+faststart`、8–20 s、25 fps）。
- 非 0 → stderr 最后一行是人话原因，Host 原样回给模型/用户，绝不生成假视频。
- `metrics.json` 关键字段：`engine:"real"`、`params`、`frames`、`fps`、`duration_s`、`motion_duration_s`、
  `geometry{ok, degraded, effective_pattern, degrade_reason, hard_error_count, checks{...}}`、`warnings`、`created_at`。
- 需要新写的两个文件：`author_walk.py`（通用步态 author：前/后、直线/弧线/8字、步长/半径/圈数/速度 → IK → motion.json）
  与 `run_preview.py`（author → 几何检查 → MuJoCo 渲染 → 两件产物）。
- **几何检查失败时降级并如实上报**（`geometry.degraded` / `degrade_reason` / `warnings`），不静默给错动作。

---

## 7. 安装 / 更新 / 卸载

```text
plugin_manager install_bundle  target=/abs/path/to/dsh-microduck-preview
plugin_manager set_bundle      target=@local/dsh-microduck-preview enabled=true   # 改完 JS 后重新激活
plugin_manager remove_bundle   target=@local/dsh-microduck-preview
```

安装是「本地目录 link」：包被 link 进 profile 的 `node_modules`，**JS 改动后需要 `set_bundle` 重新激活**（Host 侧），
Client 侧随页面刷新加载。`pipeline/*.py` 是运行时子进程，改完即生效（无需重装）。

---

## 8. 回归清单（DSH / 资产升级后）

1. `node test/host.test.mjs`（参数校验、任务状态机、Range/401/404 路由）与 `node test/client.test.mjs`（Client 渲染 smoke）全绿。
2. `cordis_inspect_query` → `Tool.listTools` 含 `duck_templates` / `duck_preview` / `duck_status`。
3. Client Slots 占位：`conversation.view:microduck-preview`（会话 View tab，order 20）、`tool.call.toolview:duck_preview`、`sidebar.right.tab.document:microduck-video` 均 `active: true`；且 `main` / `sidebar.panellist` **不再**被本插件占用（已迁移为会话视图）。
4. 未带 cookie 请求 `/api/microduck/tasks` 返回本插件的 401 JSON（证明路由命中且认证栅栏生效）。
5. 真实管线：`duck_preview` 返回 `engine: "real"`、`geometry_ok`、`video_path` 文件 >100 KB，面板可播放/拖动进度（Range 生效）。

### 单脚悬停（`pattern: "hover"`）

原地姿态动作：一只脚支撑、另一只脚抬起并保持 `hold_s` 秒再放下。实现要点（`author_walk.py`）：
- 抬起/放下用**同一条轨迹的镜像回放**，避免 IK 在下降段跳到另一分支（那会自穿模膝盖）；
- 抬脚时把脚**略微内收+前收**（tuck），既更像真实悬停，也让 IK 保持在稳定分支；
- 对请求的 `lift_height_m` 自动试 2–3 个邻近距离，取关节余量最好的解（`HOVER_ACCEPT_MARGIN_DEG=6°`）；
- 支撑脚离地间隙抬到 2.5 mm、根高度略降，避免支撑脚 mesh 沉入地面。
> 这是**运动学姿态预览**（不是动力学平衡控制器）：几何检查保证不越限位/不穿地/不自碰，但不证明真实机器人能靠控制稳住单脚站立。

### 已完成的验收证据（2026-10-27，本机）

| 验收项 | 结果 |
|---|---|
| 真实管线 `line/forward` | step 0.04 laps 1.5 → 12.8 s，210 帧 / 8.40 s，`effective_pattern: line`，`degraded: false`，margin 15.20°（`pipeline/samples/line_forward_normal/`） |
| 真实管线 `line/backward` | step 0.04 laps 1.5 → 12.3 s，210 帧 / 8.40 s，`effective_pattern: line`，`degraded: false`，margin 15.19°（`pipeline/samples/line_backward_normal/`） |
| 真实管线 `figure8/backward` | step 0.025 r 0.10 → 20.5 s，371 帧 / 14.84 s，`effective_pattern: figure8`，`degraded: false`，margin 14.33°、自碰 0，俯视窗为双切圆 8 字（`pipeline/samples/figure8_backward_small/`） |
| 真实管线经插件 `duck_preview` | `engine: real`，`effective_pattern: figure8`，`degraded: false`，`geometry.ok: true`，**371 帧 / 14.84 s / 1120×640 / 1.17 MB**，插件端到端 **21.7 s**（task `20261027-234950-jbl5`）；`line/backward` 亦 real（245 帧 / 9.8 s，task `20261027-235112-ue4e`） |
| 一句话填参（全新上下文 agent） | 仅给「倒退走8字，步子小一点」→ 自动 `duck_templates` → `duck_preview(pattern=figure8, direction=backward, step_length_m=0.025, radius_m=0.11)`，并如实转述结果 |
| 参数微调「圈再大一点」 | 只传 `radius_m: 0.13` → 继承上次 `figure8/backward/0.025`，仅半径变化；不会退回 `line` |
| 越界参数 | `step_length_m=0.2` → 人话错误（含 0.02–0.06 范围与改法建议），不静默 clamp |
| 降级诚实性 | demo 片段 / 几何降级 / 失败三种情况各自在工具返回、面板、metrics 三处标注，并显式要求模型不要说成原轨迹 |
| 单脚悬停 `hover` | 插件真跑 task `20261028-003215-glrn`：`engine: real`、`effective_pattern: hover`、`degraded: false`，**119 帧 / 4.76 s**，端到端 **5.7 s**；几何：margin 9.05°、峰值关节速度 2.19 rad/s、支撑脚 +0.57 mm、自碰 0；数值核对右鞋底 0.0425 m vs 左鞋底 0.0025 m、contact=[1,0] |
| 认证 | 无 cookie 访问 `/api/microduck/*` → 本插件 401 JSON（路由命中 + Connection 栅栏重放生效） |
| 交互式 viewer 帧服务 | `test/frames.test.mjs`：真实 python 常驻进程，37+ 帧轨道/时间扫描 → `p50 21.2 ms / p95 31.2 ms`（900×600 开阴影，≈47 fps 上限）；HTTP `GET .../frame` 返回 `image/jpeg` + `x-mujoco-ms`（12.1 ms / 640×440）；`/scene` 正确标记真实任务 `interactive=true`、demo 任务 `false` 且 `/frame` 返回 409 |

---

## 9. 与 plan-v0 的差异（实现时按当前 DSH 实际能力调整）

| plan-v0 | 实现 | 原因 |
|---|---|---|
| §2/§4「V1：`ctx.documentPreviews` + `sidebar.right.tab.document`」 | **已实现**（`microduck-video` 渲染器 + Range 路由） | 该服务在 0.2.1-rc.3 确实存在（由 `dsh-client-ui-sidebar-documentpreview` 提供），故保留 |
| §2「V1：视频出现在对话流」 | **`tool.call.toolview` key `duck_preview`** | 当前 DSH 的视频/文件呈现走 tool view + document preview，而非旧式 sidebar 文档 tab |
| §2「V2+V3：左侧常驻大 viewer，对话落右侧」 | **`conversation.view` 会话视图**（Session header 的 View tab，Chat/Trajectory 之后），默认展示**实时 MuJoCo 场景** | DSH 布局固定为「左 sidebar / 中央 main / 右 rightbar」，插件改成会话视图后：viewer 与 Chat 同属该会话的并列 View tab，切换成本最低；同时天然拿到 `sessionId` 做「只看本会话的预览」 |
| 旧版实现（本插件早期迭代） | 曾用根 `main` 面板 + `sidebar.panellist` 图标；**已移除** | 按需求改为「DSH 会话视图插件」：不再占据全局主面板/侧栏图标，改为会话内 View tab |
| §2/§4「viewer 播放 mp4」 | 主面板改为**按需实时渲染**（Host 常驻 `frame_server.py` + 逐帧 JPEG 路由），mp4 保留为第二 tab 与下载 | 用户明确要求「不要视频，要真实 MuJoCo 场景下的 viewer」：每帧都由真实 MuJoCo 模型按当前相机/时间渲染 |
| §4「Range 用 `ctx.fs.readByteRange` 1 MiB 分块」 | 直接 `node:fs` 流 + 标准 Range 语义（206/416/后缀范围） | 插件 Host 代码即 Node 进程；`Response`/流式更简单，且已由单测覆盖 |
| §3「先用假管线」 | `engine: demo`（预置片段）**显式标注**，`ready.json` 出现后自动切真实管线 | 保证「假管线」阶段也不会把 demo 当成用户要的动作 |

---

## 10. 已知限制

- **渲染耗时（实测）**：本机 CPU 逐帧 MuJoCo 渲染，单次 **约 20–30 s**（authoring 5–10 s + 渲染 11–15 s，1120×640 / 25 fps；figure-8 一例为 371 帧 / 14.8 s 成片、总 21.7 s），远快于任务书假设的 1–3 分钟；`duck_preview` 默认最多阻塞 90 s，足够一次跑完，超时才返回 `running` 交由 `duck_status` 轮询。
- **并发**：单槽队列（一次只跑一个渲染），第二个请求排队（`queued`）；工具调用被取消/超时会终止子进程。
- **figure8 在 Microduck 上的可行性**：`figure8` 需要两步之间的转向反向（腰部切点处曲率反号），而本机器人无踝 yaw、髋 yaw 仅 ±25°；若 `author_walk.py` 的几何检查判定某段不可行，会**降级为弧线组合**，并在 `metrics.geometry.degraded/degrade_reason`、工具返回与面板 DEGRADED 标记三处如实上报——**绝不把降级结果说成原轨迹**。
- **演示片段 ≠ 参数渲染**：`engine: demo` 时返回的是预置片段（`reviews/marseille-v17-drag360/fullview.mp4`，那是球类 pivot 动作），与用户描述无关，插件会在工具结果、面板标签、metrics 里同时标注 DEMO；只有 `pipeline/ready.json` 存在时才进入 `real`。
- **交互 viewer 的边界**：帧由 Host 侧 MuJoCo 逐帧渲染后回传（p50 ≈ 21 ms），所以拖拽/播放的流畅度取决于本机 CPU；单 worker 同时只处理一个请求（viewer 侧已做「上一帧到才发下一帧」的背压），最多 2 个任务各一个 worker，空闲 120 s 回收。默认渲染 900×600（上限 1280×800）、JPEG q85（≈26 KB/帧）；要更高清可改 URL 参数 `w/h`，代价是帧率下降。这不是 WebGL 客户端仿真，而是**真实 MuJoCo 离屏渲染**——好处是画面与 `mj_forward` 完全一致，坏处是每帧要走一次 HTTP。
- **浏览器侧视觉**（面板排版、拖拽手感、自动切换）无法由 Host 侧断言；已验证 slot 注册为 active、帧路由 JPEG/`x-mujoco-ms`、`/scene` 可交互标记与 Client 渲染 smoke，真实观感需在页面里人工确认。
