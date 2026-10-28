# Microduck Preview · Python 管线（author_walk + run_preview）

把 `duck_preview` 的参数（轨迹形状 / 方向 / 步长 / 半径 / 圈数 / 速度）变成一段**真实 MuJoCo 渲染的 Microduck 行走视频**：参数化 author → 关节约束 IK → 几何检查（关节越界/穿地/自碰）→ 离屏渲染 → H.264 mp4 + metrics.json。

不做训练、不做视频输入、不做 retarget；纯运动学参考动作（preview only）。整个管线只用
`mujoco` / `numpy` / `scipy` / `Pillow` / `imageio` / `imageio-ffmpeg`，不安装任何新依赖、不联网。

---

## 1. 环境（已在本机验证）

| 项 | 值 |
|---|---|
| 解释器 | `/Users/founderlin/agent_zoo/microduck_rl-develop/.venv/bin/python` (Python 3.12.13) |
| Python 依赖 | mujoco 3.10.0 · numpy 2.4.1 · scipy 1.18.0 · imageio 2.37.2 · Pillow 12.2.0 · imageio-ffmpeg 0.6.0（自带 ffmpeg，用于 +faststart 重封装） |
| 机器人资产 | `microduck-marseille` 仓库（只读）：`src/mjlab_microduck/robot/microduck/robot_groundcontact.xml` |
| 默认资产根 | `/Users/founderlin/agent_zoo/microduck_rl-develop` |
| 资产根覆盖 | 环境变量 `MICRODUCK_ASSET_ROOT` |
| 平台 | macOS arm64（MuJoCo 经典 offscreen 渲染器；训练/训练依赖**不需要**，不 import mjlab/torch） |

> `MICRODUCK_PYTHON` 环境变量会被接受但不需要：本管线在当前进程内跑完，不再 fork 子进程。
> 不 import matplotlib，因此无需设置 `MPLCONFIGDIR`。

---

## 2. 一条命令

```bash
PYTHONPATH= \
/Users/founderlin/agent_zoo/microduck_rl-develop/.venv/bin/python \
  pipeline/run_preview.py --params-json <params.json> --out-dir <out-dir>
```

* 成功：**exit 0**，`<out-dir>/` 下生成 `preview.mp4` + `metrics.json`（另有 `motion.json`、`authoring_report.json` 供排查）。
* 失败：**非 0**，stderr **最后一行**是一句人话：`ERROR: ...`，并写 `<out-dir>/error.log`（完整 traceback）。失败时不会留下伪造/空 mp4（先写临时文件，成功后才重封装为 `preview.mp4`）。

也可以只跑 author + 几何检查（秒级，不渲染）：

```bash
python author_walk.py --params-json <params.json> --out-dir <dir>
# 或
python author_walk.py --pattern figure8 --direction backward --step-length 0.025 --radius 0.10 --laps 1 --speed normal
# → <dir>/motion.json + <dir>/authoring_report.json，stdout 打印一行 JSON 摘要
```

### 参数（`--params-json` 内容）

| 字段 | 类型/范围 | 说明 |
|---|---|---|
| `pattern` | `line` / `arc` / `figure8` | 轨迹形状 |
| `direction` | `forward` / `backward` | 前进 / 倒退（倒退 = 机身朝向行进反方向，脚向身体后方摆） |
| `step_length_m` | 0.02 – 0.06 | 每步落地间距（地面距离，m）；“步子小一点” → 0.02–0.03 |
| `radius_m` | 0.05 – 0.15 | `arc` 圆弧半径 / `figure8` 单叶半径，m（`line` 忽略） |
| `laps` | 0.5 – 3 | 圈数：line = 0.55 m/圈；arc = 一圈周长；figure8 = 一个完整 8 字（两个相切圆） |
| `speed` | `slow` / `normal` / `fast` | 步频（`step_duration` 缩放），不改变轨迹 |

Host 已经做过范围校验；管线这里仍会**防御性再校验一次**：未知字段 / 越界 / 非数字都会返回人话错误。

### 语义补充

* `laps` 语义：`line` 一圈 0.55 m；`arc` 一圈 = `2πR`；`figure8` 一圈 = 一个完整 8 字（`4πR` 弧长，左右两叶各一整圆）。
* 时长为"预览友好"做了保护：动作目标 6–16.8 s（见 §6），过长会**截短轨迹**并在 `warnings` 里说明（`authoring.trimmed_for_time_budget=true`、`laps_effective` 给出实际完成圈数）。
* 速度只影响步频；小步长会按 `√(step/0.035)` 放慢步频，避免小碎步看起来像抖腿。

---

## 3. 产物

```
<out-dir>/
├─ preview.mp4          # h264 (High) / yuv420p / 1120x640 / 25 fps / +faststart
├─ metrics.json         # Host 解析的指标（schema_version=1, engine="real"）
├─ motion.json          # 50 Hz 参考动作（joint_names/times/joint_pos/root_pos/root_quat_wxyz/feet_pos/contact/phases/control_hz/…）
└─ authoring_report.json# author 侧证据：effective_pattern/degraded/degrade_reason/warnings/geometry(含 worst_frames、ik)/timings_s/plan
```

### `metrics.json`（关键字段，Host 依赖）

```json
{
  "schema_version": 1,
  "engine": "real",
  "params": {...},                       // 请求参数（归一化后）
  "effective_params": {...},             // 实际执行参数（降级后可能不同）
  "frames": 371, "fps": 25, "duration_s": 14.84,   // 渲染帧数 / 渲染时长
  "motion_duration_s": 14.82,            // author 出来的动作时长
  "geometry": {
    "ok": true, "degraded": false,
    "effective_pattern": "figure8", "degrade_reason": null,
    "hard_error_count": 0,
    "checks": { "min_joint_margin_deg": 14.331, "max_joint_speed_rad_s": 10.335,
                "min_sole_z_mm": 0.411, "min_nonfoot_z_mm": 19.597,
                "self_penetrating_contacts": 0 }
  },
  "warnings": [...],                     // 降级/截短/构造说明，供模型向用户转述
  "created_at": "...",
  "render": {...}, "pipeline": {...}, "authoring": {...}   // 附加诊断，可忽略
}
```

---

## 4. 动作是怎么 author 出来的

1. **世界轨迹**：按 pattern 生成 root 的弧长参数化路径（含前后 0.12 m 采样余量，供起步/落脚点外推）：
   * `line`：沿 +x 直线；
   * `arc`：半径 R 的圆（从原点、朝 +x 出发，向左弯）；
   * `figure8`：**两个外相切圆**（左右两叶）。切点处朝向连续、只有曲率反号，因此每步机身转角 `≈ step/R`，与已验证的 arc 同量级——这解决了此前 Gerono 双纽线在腰部曲率过大导致的关节速度/自碰失败。
2. **步态（travel frame）**：沿路径方向每步交替摆一只脚，摆动窗口为一步的 15%–85%（其余是双脚支撑）；支撑脚落在 `0.65·step` 的对称前后范围内，起步就是稳态站姿（避免首步拉大步幅）。`forward` 与 `backward` 共用同一个 travel-frame 步态：倒退只是机身 yaw += π 且左右脚横向互换，所以倒退时脚确实往身体后方摆、髋关节后摆，并被真实几何检查覆盖。
3. **逐帧约束 IK**：对 14 个非被动铰链中的 10 个腿关节做 `scipy.optimize.least_squares` 有界最小二乘，约束两只脚 site 的世界位置（目标 3 维）+ 鞋底朝向（pitch/roll 强约束、foot yaw 弱约束），带帧间平滑项、HOME 姿态先验和**逐帧 trust region（关节帧间位移 ≤0.22 rad）**——后者把偶发的 IK 分支跳变（单帧 13+ rad/s）压掉，使最大关节速度自动 <12 rad/s。
4. 关节 margin 2°、IK 位置尺度 1.5 cm 等参数沿用 `microduck-marseille/experiments/project-config.json` 的已验证 authoring 设置。

## 5. 几何检查（秒级，真实执行）

对 `motion.json` 的每一帧 `mj_forward` 后检查（直接检查真实 MuJoCo 模型）：

| 检查 | 失败阈值 | metrics 字段 |
|---|---|---|
| 关节越界 | 任意帧关节余量 < 0° | `min_joint_margin_deg` |
| 关节速度 | > 12 rad/s | `max_joint_speed_rad_s` |
| 穿地（鞋底） | 鞋底最低点 < -1 mm | `min_sole_z_mm` |
| 穿地（非脚） | 非脚碰撞体最低点 < -1 mm | `min_nonfoot_z_mm` |
| 自碰 | 自接触穿透 > 1 mm 的接触数 | `self_penetrating_contacts` |
| IK 不可达 | 脚 site 误差 > 5 mm | `authoring_report.geometry.ik` |

**降级策略（如实报告，不静默给错动作）**：请求形状几何不可行时，按顺序尝试最接近的 arc 组合，成功后将 `geometry.degraded=true`、`geometry.effective_pattern` 写成实际执行的形状，并在 `degrade_reason` 里给出**第几帧、哪个关节、超限多少**的精确原因（同时进 `warnings`）。若全部候选都不可行，脚本以非 0 退出并打印人话错误。

实测：当前构建下 **line forward/backward、arc、figure8 forward/backward 均直接通过**（`degraded=false`，见 §7 样例）；降级路径保留给未来的参数组合（例如步长/半径被推到边界时）。

## 6. 性能（本机实测，含 author + 几何 + 渲染）

| 用例 | 参数 | 帧数/时长 | author | 总耗时 | 结果 |
|---|---|---|---|---|---|
| line forward normal | step 40 mm, laps 1.5 | 210 帧 / 8.40 s | 5.3 s | **12.8 s** | line, ok, 无降级 |
| line backward normal | step 40 mm, laps 1.5 | 210 帧 / 8.40 s | 5.2 s | **12.3 s** | line, ok, 无降级 |
| figure8 backward small | step 25 mm, R 0.10, laps 1 | 371 帧 / 14.84 s | 8.6 s | **20.5 s** | figure8, ok, 无降级 |
| （最坏情况预算） | 任意合法参数 | ≤ 420 渲染帧 / ≤16.8 s | ≤10 s | ≤ ~35 s | 远低于 180 s 目标；Host waitMs=90 s 也有余量 |

渲染是 50 Hz 动作每 2 帧取 1 帧 → 25 fps；单帧渲染约 25–35 ms（1120×640，含阴影 + PIL 叠加）。所有用例 exit code 0。

## 7. 已验证样例（`samples/`）

| 目录 | 参数 | 产物 | 几何结论 |
|---|---|---|---|
| `samples/line_forward_normal/` | line/forward/0.04/1.5/normal | 210 帧, 8.4 s, 514 KB | margin 15.20°, speed 10.06 rad/s, sole +0.41 mm, 自碰 0 |
| `samples/line_backward_normal/` | line/backward/0.04/1.5/normal | 210 帧, 8.4 s, 493 KB | margin 15.19°, speed 10.04 rad/s, sole +0.41 mm, 自碰 0 |
| `samples/figure8_backward_small/` | figure8/backward/0.025/0.10/1/normal | 371 帧, 14.84 s, 1.17 MB | margin 14.33°, speed 10.34 rad/s, sole +0.41 mm, 自碰 0；俯视窗可见双切圆 8 字 |

每例都含 `params.json` + `preview.mp4` + `metrics.json`（+ `motion.json`、`authoring_report.json`、`run.stdout/run.stderr` 证据）。三例均 exit 0，mp4 均为 h264/yuv420p/1120×640/25 fps/+faststart。

`ready.json` 是"真实管线可用"的就绪标记（Host 以此从 demo 切到真实引擎），由本管线在样例全绿后写出。

## 8. 已知限制（如实说明）

* **纯运动学预览**：没有物理/接触动力学、没有平衡控制器；脚底按规划贴地。预览证明"该参数下动作几何上合法、观感正确"，不证明实机可稳定执行（那需要 BAM 动力学 rollout/训练，本插件范围外）。
* **曲线上的支撑脚会随身体原地转动**：弧线/8 字行进时，两只脚按阶段落点"钉"在世界坐标，但鞋底朝向跟随身体 yaw，因此支撑脚会有预览级的原地 pivot（不是打滑动力学，视觉上可接受；已在 `warnings` 说明）。
* **figure8 的"8"是双切圆**：俯视为左右两叶、在切点处相切；不是自交的双纽线（自交会让腰部曲率过大而不可行）。用户看到的仍是一个标准 8 字。
* **时长/圈数会被预算截短**：目标动作时长 ≤16.8 s（840 帧 @50 Hz）；超长请求会截短并在 `warnings`/`laps_effective` 中说明。极短请求会被拉长步频到 ≥6 s。
* **HOME 姿态是硬编码常量**（复制自 `microduck_constants.HOME_FRAME`，STAND2 pose）；若外部资产仓库更新机器人模型/HOME，需要同步 `author_walk.py` 里的 `HOME_JOINT_POS`（构建时会校验关节名是否全部匹配，不匹配会明确报错）。
* **依赖外部只读资产仓库**：默认路径写死，换机器需设 `MICRODUCK_ASSET_ROOT`；找不到模型会给出人话错误。
* 不支持球交互、训练/PPO、视频输入/retarget（按任务书属于范围外）。

## 9. 文件

| 文件 | 作用 |
|---|---|
| `author_walk.py` | 参数校验 + 轨迹/步态 author + 约束 IK + 几何检查 + 降级逻辑；也可单独当 CLI 跑（秒级） |
| `run_preview.py` | 一条龙入口（Host 调用）：author → 几何 → 离屏渲染 → `preview.mp4`/`metrics.json`；自带 ffmpeg +faststart 重封装 |
| `samples/` | 已验收的三个样例 |
| `ready.json` | 真实引擎就绪标记 |
| `.work/` | 本地迭代脚本/帧草稿（git 忽略） |

---

## 10. Frame server (interactive viewer)

`frame_server.py` 是给插件 Web viewer 用的**常驻帧服务**：进程内复用 1 个 MjModel/MjData + 每尺寸缓存的 Renderer，Host 每需要一帧就发一行 JSON，服务回 `<task-dir>/.frames/<id>.jpg`（默认 JPEG q=85，~26 KB），浏览器可 30–60 fps 播放/拖拽镜头。它不重新 author、不重新 compile，也不做视频编码。

```bash
<python> pipeline/frame_server.py --task-dir <含 motion.json 的任务目录> \
                                  [--asset-root <microduck-marseille>]
```

`--asset-root` 默认 `$MICRODUCK_ASSET_ROOT` 或内置默认路径。**stdout 只输出协议 JSON 行**（一行一个 JSON，flush）；所有日志走 stderr。

### 启动握手（stdout 第一行）

```json
{"ready": true, "duration_s": 14.82, "fps": 50.0, "frames": 742,
 "joint_names": ["left_hip_yaw", "... 共 14 个"], "load_ms": 557}
```
启动失败：`{"ready": false, "error": "..."}` 并 exit 2。

> **`fps`/`frames` 的取值**：直接来自 `motion.json`（动作是 50 Hz，742 帧），因此协议里 `t*fps → motion 帧` 严格成立（`index = round(t/dt)`，越界取端点）。`duration_s` 是动作真实时长（14.82 s）。样例 preview.mp4 的 25 fps/371 帧是"预渲染编码"的节奏，与本服务无关；viewer 时间轴请用 `duration_s`。

### 请求 / 响应

请求（stdin 一行一个 JSON，除 `id` 外全部可省略）：

```json
{"id": 7, "t": 1.23, "az": 130, "el": -18, "dist": 0.5,
 "follow": true, "lookat": [x, y], "w": 900, "h": 600,
 "shadows": true, "quality": 85}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | — | 原样回显；用于 JPEG 文件名（已做路径安全化） |
| `t` | 0 | 秒，clamp 到 `[0, duration_s]`，最近帧（50 Hz） |
| `az` / `el` / `dist` | 130 / -18 / 0.5 | MuJoCo free camera 方位角(°)/仰角(°)/距离(m)；分别 clamp |
| `follow` | true | true → lookat = 当前帧 root xy，z=0.075；false → `lookat` 或 `[0,0,0.05]` |
| `lookat` | — | `follow=false` 时的 `[x,y]` 或 `[x,y,z]`（仅前两项必填） |
| `w` / `h` | 900 / 600 | clamp 到 `[64,1280] × [64,800]`；尺寸变化时按尺寸缓存 Renderer |
| `shadows` | true | 关掉约 2× 帧率（11 ms vs 21 ms @900×600） |
| `quality` | 85 | JPEG 质量，clamp 到 `[30,95]` |

响应（每请求恰好一行）：

```json
{"id": 7, "ok": true, "file": "<task-dir>/.frames/7.jpg", "bytes": 25883, "ms": 20.7}
{"id": 7, "ok": false, "error": "..."}
```

`.frames/` 由服务自己创建；**JPEG 由 Host 读完自行 unlink**（服务不删）。非法 JSON → `{"id": null, "ok": false, ...}`；非法/越界字段 clamp，单帧异常只回 `ok:false`，进程不退出。stdin EOF / SIGTERM / SIGINT → 关闭 Renderer 后正常退出（exit 0）。

### 性能实测（本机，900×600，figure8 样例 742 帧动作）

| 指标 | 实测 |
|---|---|
| 冷启动：spawn→ready 握手 | **649 ms**（model compile 157 ms + renderer pre-warm 400 ms；`load_ms=557`） |
| ready 后首帧 | 67 ms（第二轮起 21 ms；pre-warm 就是为了不把 GL 初始化成本留给用户第一次拖拽） |
| 连续播放 200 帧 | p50 **20.8 ms**，p95 **23.6 ms** → ~45 fps；JPEG ~25.9 KB |
| 拖拽镜头（az 每帧 +2°） | p50 **20.5 ms**，p95 **23.0 ms** |
| 关阴影 640×420 | p50 **10.9 ms** |
| 切到 1280×800 | 首次 318 ms（新建 Renderer），之后 ~77 ms/帧 |
| SIGTERM 干净退出 | exit 0，~180 ms |
| 常驻内存 | **峰值 RSS ≈ 805 MB/进程**（model ≈486 MB + renderer/首帧缓冲 ≈250 MB） |

### 多进程 / 部署注意

* **一个 task 目录一个进程**，进程之间不共享模型/缓存；Host 侧进程池建议 ≤2–3（单进程峰值内存 ~0.8 GB，模型是 38 个高精度视觉 mesh 的固有成本），空闲进程及时回收。
* 每进程一个 `.frames/` 目录，Host 并发取帧时应保证同一 `id` 不重名（或每任务串行请求）；丢帧/重建不会互相影响。
* 首次请求某个 (w,h) 会新建 Renderer（~0.3–0.4 s），之后走缓存；viewer 固定尺寸即可一直热路径。offwidth/offheight 在启动时一次设为 1280×800，所以任意 `w/h ≤ 1280×800` 都不会失败。
* 若任务目录被清理，服务会重建 `.frames/`；`motion.json` 缺失/损坏则在启动握手返回 `ready:false`。
* 帧服务只读 `motion.json`，所以它和 `run_preview.py --out-dir <task-dir>` 的产物天然配套（Host 在真实管线完成后直接对同一 task 目录起帧服务即可，无需重新渲染视频）。

自测脚本：`.work/frame_server_selftest.py`（覆盖 200 帧性能、拖拽、关阴影、分辨率切换、9 类非法请求、SIGTERM 退出码），结果落 `.work/frame_server_selftest.json`；`.work/frame_server_selftest2.py` 另外验证 pre-warm 后的首帧延迟与内存。
