---
name: microduck-reward-studio
description: 编辑 Microduck 任务绑定的奖励惩罚卡片，校验训练仓库函数和参数，保存配方版本并生成真实函数评分的释义短片。
---

# 奖励工作室

使用相邻父 skill CLI，先 `rewards list --session ID --task TASK` 查看目录、验证状态和配方。`rewards add|remove|set` 指定 `--id`；set 可用 `--weight NUMBER --params JSON --phases walk,turn`。所有操作绑定当前任务，保存不可变版本。走路和悬停有不同初始预设。未启用项不导出。

目录 `dsh-microduck-preview/rewards/catalog.json` 只登记真实训练 callable。doctor 从配置 Python 环境解析源码与参数签名；解析失败卡片标红且不可启用。奖励 ≥0、惩罚 ≤0，仅调幅度；不能随用户文字生成新的奖励 Python。

`rewards explain --session ID --task TASK --id upright` 生成正常/受控扰动的短 MP4 与逐帧得分。调用训练仓库同一个函数，输入明确标注为运动学观测；不是策略回放。按动作、指令、项、实际参数、函数源码和渲染实现哈希缓存。力矩、真实接触时序或控制器历史等缺失项显示“仅训练后可见”，不计算代理得分、不生成假动画。

卡片状态为“仅释义/未试训”。此工作台不执行试训，不能自行将卡片改为“已试训”。改权重只改配方，不声称当前参考动画随权重改变；换配方后由训练流程新建阶段。
