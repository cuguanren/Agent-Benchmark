# 验收结果：上下文策略与官方模型

日期：2026-10-02。T-001–T-011 工程交付完成；31/31 测试通过，原生 dsh 工具循环及恢复已验证。本页区分工程验收、模型解题质量与结论范围，协议见 [ONLINE_PROTOCOL](ONLINE_PROTOCOL.md)。

## 主评测

官方 deepseek-flash（V4.1-Flash），thinking disabled、temperature 0。先 observe，完成第一 turn 后统一原生切换一次，再给此前未见的问题。36 个任务来自六个家族；开发 12、评测 24，按 seed 分离。评测每任务两次、两策略，共 96 trial/48 对。评测参数未根据评测答案调优。

| 指标 | local-summary | window-reset |
| --- | --- | --- |
| 开发集正确 | 10/12 | 11/12 |
| 评测集正确 | 40/48（83.3%） | 39/48（81.3%） |
| 运行失败 / usage 未知 | 0 / 0 | 0 / 0 |
| 评测请求 / 摘要 / 工具 | 195 / 48 / 51 | 247 / 0 / 201 |
| 评测实际 input / output | 339555 / 29170 | 590525 / 22720 |
| 评测累计 token | 368725 | 613245 |

Summary 独胜 5 对，Reset 独胜 4 对，平局 39 对。按任务聚类的成功率差为 +2.1 个百分点，bootstrap 95% 区间 [-10.4, 16.7]。不能据此判断成功率优势。该受控协议下本地摘要组 token 约少 39.9%，包含辅助摘要；token 数不等于实际费用差，缓存与时段会影响计费。

评测共 981970 token。按高峰价、输入全部视为未命中的保守估计不超过 2.2753 元，不是账户账单；价格依据与原始引用见冻结协议。开发另有 241482 token。所有错误答案保留，成功由独立确定性验证器判定。

本次人工窗口 16000、触发 12000，容量以 bytes/4 估算。结果限定于六个小任务家族、同一模型及统一切换机会，未测试未见家族、长时间多次换窗、多模型或原生自选时机的质量收益。重复按任务聚类；该区间不代表跨家族泛化的不确定性。

本地证据：`runs/online-evaluation/report.json`、`report.md`、`tasks.json`、`source/`、96 份独立原生 JSONL。实现哈希 `a0daa68c9651cd830382b2134162893d00f94382c0152b43355a0100864c02d8`；配置和任务集哈希见原报告。

## PawBench 可运行子集

使用 T037_claweval_T100_reverse_decoder（原 ID T100_reverse_decoder），PawBench commit `0f794a8bb6c27aa9ee4091b2691fa30e4ed9cc8f`。原 Prompt、decoder、target 与逐字提取的 grader 均保留。模型只看 Prompt 和工作区 fixtures；grader、Expected Behavior、评分规则与测试 oracle 不注入。

| 策略 | 原硬指标全部通过 | 原生结束原因 | 请求 / 摘要 / 窗口 | 实际 token |
| --- | --- | --- | --- | --- |
| local-summary | 否 | budget_exhausted（24 次请求上限） | 24 / 0 / 1 | 77939 |
| window-reset | 否 | budget_exhausted（下次请求预留超预算） | 20 / 0 / 1 | 90505 |

本地摘要组没有 encoded.dat；换窗组产生 encoded.dat，但不满足大小和准确性，均没有所需 writeup。两组有多次将 inline code 当脚本路径的错误调用，换窗组编码查表也有类型错误；完整记录保留在工作区及原生日志。原报告 failure 字段为原生 `error`；验收审计依据 turn/end 的 `BENCHMARK_BUDGET_EXHAUSTED` 细化分类，未改写原报告或重跑挑选成功样本。

两个任务没有触发压缩，不能说明策略对外部质量的影响。Windows 文件工具和受限 Python 替代 shell/Docker，使用有限模型 token/请求预算，保留原 900 秒任务期限；不是完整 PawBench 排行榜复现。

外部适配验收是“原任务可运行、原评分器可验证产物、保留结果与差异”，不是要求模型必然解题成功。独立测试 encoder 生成正确且 ≤60% 大小的产物，原 grader 六个指标均为 1；缺失产物六个指标均为 0。测试 oracle 没有复制到 Agent 工作区。

证据：`runs/pawbench-official/report.json`、`report.md`、`protocol.json`、`source/`、两份 JSONL 与工作区。实现哈希 `4871d76a1729c061529aede8eb9e435716ad019daed26daf95a58fc8001fc295`；许可与来源见 [third_party 说明](../third_party/pawbench/README.md)。

## 证据核对与后续边界

`node scripts/audit-runs.mjs` 已核对 120 个受控 trial 的源码/配置/任务哈希、全部 usage、请求数、工具数和两窗口状态；对外部两个工作区重新执行原 grader，结果与原报告相同，fixtures 未被改写。输出 `runs/completion-audit.json`。

运行后的工程加固增加了原生 summary 异常分类及统一摘要期限、恢复工具输入校验、脚本路径的明确说明与外部预算错误分类；没有修改主评测任务、控制参数或重跑评测。新增的原生 deadline 路径由测试覆盖；既有实验以各自源码快照为准。最终 31 项测试全部通过。

原生 Session 的内存发布先于 persistence flush；P0 的先落盘保证不适用于原生适配。容量仍是估算；Python 环境并非 OS 容器；初始化故障停止运行并保留进度，不支持自动续跑。四组/五组独立归因实验、完整外部基准、Docker、UI、发布和多模型评测仍属新范围。
