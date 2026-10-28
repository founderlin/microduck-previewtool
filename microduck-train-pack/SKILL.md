---
name: microduck-train-pack
description: 将 Microduck 当前动作、逐帧指令、启用奖励和验收标准导出为带真实 BAM 物理预检与哈希的审核包；不启动 PPO。
---

# 训练审核包

先展示并确定当前动作任务，用相邻父 skill CLI `pack --session ID --task TASK` 导出新目录。DEMO、未完成任务、缺失 motion/command 或帧不匹配都拒绝打包。

包含 motion.json（50Hz/14关节）、command.json、rewards.json（仅启用项，函数和参数来源）、task_criteria.json、physics.json、机器人源码摘要和 review.json 文件哈希。读取用户项目的 taskCriteria，未配置的验收阈值保持 null，不自行宣布验收成功。

物理预检直接复用配置训练仓库的 CPU 环境、正式任务与 BAM 执行器，使用同一 groundcontact 机器人模型；参考关节目标经原 action scale/offset 执行。只在初始时设置参考姿态，不固定 root、不加外力、不预填电机历史。遇首次终止停止采集，不展示自动 reset 为成功。报告预检是否执行、原始基线是否完成、几何硬错误、风险和失败原因。

展示包目录、review_id、阻塞与风险。`handoff_ready` 仅代表审核输入齐备；用户仍需确认具体版本和训练预算，训练方必须显式导入 command/rewards/criteria。动作或物理变化重新打包；奖励变化保存新配方并新开试训阶段。当前项目没有 approve/train/PPO 命令，也不依赖其他动作模仿 skill。
