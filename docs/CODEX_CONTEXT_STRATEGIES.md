# Codex CLI：TokenBudget 与本地摘要压缩

核对日期：2026-10-02。

依据：用户提供的材料，以及公开 `openai/codex` 源码快照 [`14a477ea89712071944244022e8a10142845456e`](https://github.com/openai/codex/tree/14a477ea89712071944244022e8a10142845456e)。用户材料未标注 commit，本次核对不代表所有已发布 CLI 版本或用户所指源码分支均具有相同行为。没有执行模型调用或实测质量、成本与延迟。

## 1. 结论

这里的 TokenBudget 是“按窗口预算换窗，并通过外部状态按需恢复”的策略，不是累计 API token 或费用上限。它的换窗操作跳过模型摘要；Agent 在普通任务循环中维护 notes，并用 history/notes 工具恢复上下文。

本地压缩是“客户端请求模型生成交接摘要，然后重建活跃历史”的策略。“本地”描述客户端编排，不表示模型在本机运行。该路径使用当前 turn 的模型配置发起摘要请求，不能未经适配就假设使用另一款廉价摘要模型。

两者最关键的区别是：任务状态直接成为下一窗口的摘要内容，还是留在外部状态中、由 Agent 决定何时读取。TokenBudget 换窗没有摘要模型请求，不代表整个策略没有摘要文本、模型消耗或网络操作。

来源：[TokenBudget 换窗入口](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/compact_token_budget.rs#L19)、[本地摘要请求与重建](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/compact.rs#L251)。

## 2. 对比

| 维度 | TokenBudget | 本地摘要压缩 |
| --- | --- | --- |
| 主要操作 | 创建新窗口并安装重建的初始上下文 | 调用模型生成摘要，再替换活跃历史 |
| 谁负责提炼任务状态 | 主 Agent 在普通循环中写 notes；客户端提醒但不代写 | 客户端发起专门摘要请求，由模型提炼 |
| 下一窗口自动可见内容 | 初始上下文、窗口标识/指导，以及配置启用时的有限 notes hint；不自动带入旧窗口普通对话 | 阶段相关的初始上下文、保留的用户文本、交接摘要 |
| 旧用户指令 | 普通旧用户消息不自动复制，恢复依赖外部状态或后续新输入 | 最近优先保留用户文本，估算预算约 20,000 token；边界消息可能截断 |
| 旧助手/工具轨迹 | 不自动复制；可通过恢复工具查询已保存的历史条目 | 不原样放入 replacement history，由摘要提炼；持久记录不是因此被删除 |
| 恢复控制 | Agent 决定查询、读取哪些条目；读取结果重新占用活跃窗口 | 摘要被直接放入活跃窗口，后续模型自动看到 |
| 切换时模型调用 | 换窗实现不调用摘要模型；hooks、hint 与后续恢复仍可有开销 | 摘要请求等待流完成，有可重试或裁剪后重试路径，不保证只有一次尝试 |
| 主要成本 | notes 写入、恢复决策、工具往返、读回内容和恢复后的模型步骤 | 摘要输入/输出，以及后续重复发送摘要和保留用户消息 |
| 主要失效点（推断） | 未保存关键状态、note 陈旧、找不到相关条目、恢复调用失败或反复读取 | 摘要遗漏/错误、反复摘要损失细节、用户文本截断、摘要请求失败或摘要过大 |
| 状态持久化 | 新窗口及 replacement history 使用 compaction checkpoint 生命周期，摘要字段为空 | 同样使用 replacement history 与 checkpoint，包含摘要内容 |

其中质量、成本与失效表现是基于机制的推断，不是实测结论。

来源：[窗口重建](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/session/mod.rs#L4507)、[共同 checkpoint 写入](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/session/mod.rs#L3990)、[用户消息保留逻辑](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/compact.rs#L669)、[notes/history 接口](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/ext/history-notes/src/tools.rs)。

## 3. 触发策略与状态传递策略应分开

该快照的自动压缩路由优先检查 `Feature::TokenBudget`，启用后走新窗口路径；否则根据 provider 的远程压缩能力选择远程 V2 或本地摘要。手动压缩同样先检查该 feature。

窗口触发依据是活跃上下文量：`total` 计算整个活跃上下文，`body_after_prefix` 计算窗口前缀之后的增长量；同时检查有效完整上下文上限。fallback buffer 只在有对应 fallback prompt 时参与窗口阈值。它们不是“把历次 API usage 相加后终止任务”的总资源预算。

因此实验需要分别定义：何时换窗、换窗后保留什么、怎样恢复信息，以及整个任务累计可以消费多少资源。不能用同一个 `token budget` 字段含混表示这些不同限制。

来源：[自动路由](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/session/turn.rs#L1499)、[手动路由](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/tasks/compact.rs#L43)、[窗口计量](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/session/context_window.rs#L53)、[官方配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 4. 用户材料中需要细化的地方

1. **“TokenBudget 不生成摘要”应限定为换窗操作。** 主 Agent 写的 checkpoint note 可以包含任务摘要，只是没有客户端额外调用摘要模型。提醒与 fallback 受配置、剩余量和执行状态控制，不保证每次切换前一定成功保存 notes。
2. **本地摘要不一定只调用模型一次。** 正常成功路径是一轮摘要请求；重试与超限裁掉旧输入后再请求可能增加尝试。摘要格式来自提示，没有独立结构化 schema 校验，也未看到在该请求构造处设置专用摘要输出 token 上限；服务端/模型的一般输出限制仍可能适用。
3. **20,000 token 是用户文本的估算保留额度。** 不是 replacement history 总大小，也不是逐条消息全留或全删：不足以容纳某条边界消息时会截断其文本，且会排除旧摘要，媒体内容另有处理。
4. **“空摘要自动变成 `(no summary available)`”不是所有路径的保证。** 构造辅助函数对空输入有该分支，但正常调用先拼接非空 `SUMMARY_PREFIX`；当前 post-turn 路径还会把空 assistant 摘要视为错误。因此不能依赖这个占位文本判定实际摘要是否成功。
5. **notes hint 是有上限的内容，不保证只是文件索引。** 客户端为后端 hint 设置 4,000 bytes 边界，公开客户端没有把其正文 schema 固定为“路径和大小列表”；不能据此认定其必然不包含任何状态内容。
6. **旧记录可持久化不等于新模型自动看到。** 活跃请求与存储记录是两层；history 工具提供规范化历史回查，读取可受范围/输出截断控制，还声明了最终一致性，不应理解为任意原始流均可无损即时恢复。
7. **当前恢复接口有实际集成条件。** history-notes 扩展要求启用相应配置、OpenAI provider 及 Codex backend 认证，调用后端 API；notes 路径是虚拟路径。不能假设任意 OpenAI-compatible 服务或本地模型配置都自带该恢复层。窗口重建在 feature 启用时还可保留部分 client-authored developer 消息，所以“只有初始上下文”是简化描述。

来源：[提醒/fallback](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/session/token_budget.rs#L161)、[本地摘要处理](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/core/src/compact.rs#L306)、[history-notes 配置及 hint](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/ext/history-notes/src/extension.rs#L31)、[后端请求](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/ext/history-notes/src/backend.rs#L41)、[工具契约](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/ext/history-notes/src/tools.rs#L27)。

## 5. 成本与信息保留的解释

TokenBudget 把更多选择交给 Agent：提前保存什么、换窗后读什么、什么时候回查。它可能避免一次遍历大量旧 history 的摘要请求，但也可能因保存与恢复反复消耗步骤。实际哪一种更便宜，取决于模型调用、工具延迟、上下文重复发送及缓存情况，不能仅统计 compaction 请求次数。

本地摘要把恢复状态直接放入下一窗口，可以减少寻找状态的步骤，但摘要是有损投影。一次遗漏可能被后续摘要继承；这并不意味着磁盘上的原始记录丢失，而是活跃模型输入缺少原始细节。恢复工具是否另行提供决定它能否主动回查，不能把持久化能力自动等同为模型工具能力。

举例：工具曾返回一个关键 ID。TokenBudget 若 note 记录 ID 或可定位的历史索引，换窗后可以恢复；若两者都未保存，需要搜索且未必成功。本地摘要若写入 ID，下一窗口直接可用；若摘要遗漏，且该组没有历史回查能力，模型输入就缺少这项事实。这个例子说明潜在失效方式，不预测两者的实测胜负。

## 6. 对 Agent-Benchmark 的影响：初期功能验证依据

TokenBudget 不等于本项目此前的 Budgeted Truncation 或 Retrieval Only。它同时包含换窗、Agent 主动维护 notes、恢复工具、提示/提醒与查询决策。本地压缩也不是抽象的纯摘要开关，还包含用户消息保留、特殊初始上下文处理和超限裁剪兜底。

若首版比较实际策略，可将候选清楚命名为 `Window Reset + Agent Notes/History` 与 `Client-managed Summary Compaction`，并报告这是组合策略差异。复用 dsh 时应实现公开、可审计的等价行为契约，不把 Codex 后端工具接口视为已可直接移植。

若首版研究组件贡献，应另定义一致的基础保留、工具、预算、提醒和触发规则，再消融 notes、历史回查或摘要注入。不能把完整 TokenBudget 与本地摘要的差异全部归因给“检索”。

公平比较至少需要固定模型与任务环境、声明策略特有工具、控制窗口触发口径和恢复配额，并把摘要调用、notes 生成、读回内容、后续模型步骤都计入总资源。允许各策略按原生规则主动切窗时，结论限于原生策略对比；要隔离状态传递方法，则需统一切换机会并记录任务实际发生的窗口数及恢复成功情况。

用户随后要求以本文件为初期功能验证目标，完成 spec/plan/task 后开发（D-011），并指定 DeepSeek 官方服务完成后续内容（D-012）。现已实现 P0 核心、dsh 原生 Agent 生命周期与在线实验；PawBench 一个原任务/原 grader 可运行子集已验收，真实模型两组预算终止。结果见 RESULTS。不复制 Codex 私有后端；摘要输出上限、本地虚拟恢复工具、目录 hint、原生异步 flush 与参考客户端差异在 SPEC 披露。四组/五组独立归因和完整基准复现未纳入本轮。
