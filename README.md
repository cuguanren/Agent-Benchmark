# Agent-Benchmark

面向 DeepSeek Harness（dsh）生态的 Agent 机制实验与评测项目，目标是在受控条件下比较不同机制对任务表现、成本和执行过程的影响。

当前处于需求确认阶段，尚无实现代码。已确认与待确认事项见 [决策记录](docs/DECISIONS.md)。后续按 SDD 顺序完成细节确认、SPEC、PLAN 和 TASK 文档。

评测方向采用两层结构：自建受控任务集作为主评测，PawBench/Harness-Bench 作为外部适配与对照。具体机制、集成接口和执行协议仍待确认。

## 设计来源与致谢

项目计划吸收以下项目与研究的设计：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：可组合的 Agent 运行能力与插件架构。
- [PawBench](https://github.com/agentscope-ai/PawBench)：Model × Harness 评测、任务切片与诊断轨迹。
- [Harness-Bench](https://arxiv.org/abs/2605.27922)：共享环境、预算和评测协议下的 harness 配置比较。

当前只完成初步调研，未引入上述项目的代码或数据。后续复用会记录具体来源、版本和许可证，并保留相应声明；本项目与上述项目没有已确认的官方关联。
