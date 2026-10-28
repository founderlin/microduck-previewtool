---
name: microduck-motion-compose
description: 将 Microduck 自然语言动作编成可串联的时间轴，微调步长、转角、悬停与站立，并输出逐帧速度指令和支撑脚。
---

# 串联动作

先用相邻父 skill 的 CLI `templates --session ID` 读取实时参数范围和当前对话历史。自然语言按顺序映射为 `preview --session ID --params JSON`，使用 `status` 等待，再打开 viewer。

```json
{"pattern":"composite","segments":[{"kind":"turn","turn_deg":90,"radius_m":0.12},{"kind":"straight","length_m":0.2},{"kind":"hover","hover_foot":"right","lift_height_m":0.04,"hold_s":2},{"kind":"stand","hold_s":1}]}
```

最多六段。turn 正值左转、负值右转；hover_foot 指抬起的脚，默认抬脚 0.04m。sidestep 接受 side/length_m，但没有真正横移步态，会明确替代为相应方向转 90°再直行，须报告朝向变化。

微调只继承当前 pattern 相关字段；更换动作不要意外携入前一动作 segments。用 `--base-task ID` 指定本对话的历史基准。越界返回错误，不静默截断。工作台提供增删/排序和逐帧 vx/wz 曲线，点击曲线定位。

结果是单条 50Hz / 14 关节 `motion.json` 和同帧 `command.json`，包含阶段与支撑脚。段间是运动学过渡；检查指标和警告，不能描述成学到的策略。
