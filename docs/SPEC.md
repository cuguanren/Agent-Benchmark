# SPEC：Codex 风格上下文策略功能验证

版本：0.2；日期：2026-10-02。依据：[策略比较](CODEX_CONTEXT_STRATEGIES.md)、D-010–D-012。用户已授权两种策略的功能验证、DeepSeek 官方 API 与后续开发。历史四组/五组选择不阻塞本轮。

## 1. 目标与验收边界

首期验证 `local-summary` 与 `window-reset` 的状态传递行为，形成可复现、可审计的实验基础。比较的是组合策略，不宣称摘要或检索的独立因果贡献。Codex 源码是行为参考，不复制其私有 backend，不要求逐字复现所有历史版本。

P0 交付机制核心、追加式轨迹与 checkpoint、notes/history 工具、离线 CLI、dsh 模型桥接和测试。离线脚本模型只验证协议。P1 接入固定 dsh 原生 Agent 生命周期；P2 按冻结协议运行官方在线配对实验和一个原任务/原验证器可运行的外部子集。三阶段工程已完成，质量结果及限制见 RESULTS。

首期不要求 Web UI、远程 compaction、语义向量检索、跨任务长期记忆、外部完整基准、统计显著性或 30–50 个性能任务。两层评测长期方向保留。这些范围调整只适用于初期功能验证。

## 2. 需求与行为契约

| 编号 | 需求 | 验收条件 |
| --- | --- | --- |
| R-001 | 将活跃上下文、持久历史、窗口身份分开管理 | 换窗后旧消息不在活跃上下文，仍能通过稳定 item/window ID 查询；摘要同样不删除原始记录。 |
| R-002 | 本地摘要 | 向模型传活跃历史、固定交接指令；成功后只携带固定初始上下文、预算内最近用户文本和摘要，不直接保留旧 assistant/tool 原文。 |
| R-003 | 换窗策略 | 切换不调用摘要模型；重建初始上下文及窗口元信息，不复制普通旧对话，不自动代 Agent 写或读 note。 |
| R-004 | 外部恢复状态 | 提供 notes 写/读/列/字面搜索，history 窗口/条目列举、字面搜索及范围读取；仅作用于单次 session。hint 有 4,000 UTF-8 bytes 上限，不自动注入 note 全文。 |
| R-005 | 窗口与任务预算分离 | 单请求容量含工具定义与输出预留；支持 total/body-after-prefix 触发口径；累计模型 token 预算覆盖辅助摘要。缺失 usage 保留 unknown，容量估算不得冒充实际计费 token。 |
| R-006 | 生命周期与失败 | 记录 start/end 与触发原因；pre hook 可取消；空摘要、过大摘要、超时、中断、总预算耗尽、持久化失败均可辨识。失败不静默换策略。提交前失败不替换活跃状态。 |
| R-007 | 本地摘要请求兜底 | provider 明确报告 context overflow 时，从候选摘要输入移除最旧完整调用单元再尝试；普通可重试错误次数固定。记录各次请求与资源，不剪断 tool call/result 配对。 |
| R-008 | 持久化和恢复 | 每个成功 replacement 写含窗口、活跃内容、notes 与计量状态的 checkpoint；从同一追加式日志恢复。截断尾行忽略并报告，内部损坏拒绝恢复。一次会话文件仅允许一个写入者。 |
| R-009 | 功能验证 CLI | 用版本化场景对两策略各运行一次，保存 JSON/Markdown 报告与每组 JSONL。报告含模式、配置/场景哈希、策略事件、请求次数、实际/估算计量和验证结果。 |
| R-010 | dsh 边界 | P0 提供显式依赖 `ctx.llm` 的桥接服务，验证请求和 usage 映射；不宣称已替换原生 Agent 的 compaction。P1 单独验收 native lifecycle、工具挂载与插件冲突。 |
| R-011 | 工具与输入正确性 | 活跃消息不可含孤立工具结果；切换在完整调用单元之间发生；恢复工具按额度返回并标注截断。原始答案与验证器不作为模型输入。 |
| R-012 | 可用示例与验证证据 | 无 API key 的功能验证可直接运行；类型检查、失败路径、重启恢复、Unicode 边界和 dsh 桥接检查通过，结果和限制写进 TASK。 |

### 2.1 策略细节

`local-summary` 的用户文本保留额度默认 20,000 个估算 token，可为小窗口测试显式降低；旧摘要不作为原始用户文本再保留。摘要为模型文本，必须非空，结构来自提示而非 JSON schema。为稳定功能验证，本项目显式配置摘要输出上限，并记录这是与参考客户端不同的工程约束。摘要后若固定上下文加保留文本和摘要仍超过容量，分类为 `context_exhausted`，不提交超大 replacement。

`window-reset` 保留固定初始上下文及 first/previous/current window ID。notes 由工具调用显式写入；hint 在本地实现为大小受限的文件路径/大小目录，属于本项目明确契约，不声称与 Codex backend 的 hint 内容相同。触发提醒和 `new_context` 请求提供独立入口；提醒不保证 Agent 已保存状态。

P0 存储完全本地、同步一致；原生 Session 的发布/flush 顺序见 4 节。notes 虚拟路径不映射为任意操作系统路径。history 仅开放当前 session 已观察的持久消息。恢复数据重新进入请求时占用窗口；工具往返单独计数，不能把换窗解释为免费执行。

### 2.2 预算与失败

估算器明确标记为 UTF-8 bytes/4 加消息开销，仅用于功能验证容量控制，不能替代 provider tokenizer。模型调用须有有限输出上限。调用前保守预留输入估算与输出上限；已报告 usage 计实际值，否则用估算扣除并标记来源。已知 provider usage 超出预留时记录全部消耗并立即停止后续调用。缓存 token 不重复加到 input+output 总量中。

失败分类：`context_exhausted`、`summary_failed`、`budget_exhausted`、`cancelled`、`storage_failed`、`invalid_input`、`provider_failed`、`output_limit`。验证失败单独记录；基础设施失败与未运行样本必须披露。策略提交前失败可耗费模型预算，但保持旧活跃窗口；提交后失败记录已提交状态。

### 2.3 数据契约

消息：稳定 `id`、`windowId`、`role`、文本、可选 `toolCallId`、`kind`（普通、摘要、初始、提醒）。事件：schemaVersion、递增 seq、type、data。checkpoint 含策略、配置、窗口链、活跃消息、notes、累计计量；原始 message 事件继续存在。模型 request 记录目的、输入、输出上限及 usage，不记录凭据或认证 header。

CLI 配置仅含非敏感标识和参数。conformance 不读取凭据、不访问在线模型；online/external 从 DEEPSEEK_API_KEY 或不回显的 stdin 读取用户授权凭据，保留在内存。报告与请求审计不保存凭据或认证 header；unknown 不显示为 0。

## 3. 阶段验收

P0：两种策略和所有 R-001–R-009、R-011–R-012 的核心契约有自动验证；R-010 的桥接部分通过真实依赖的组合测试。示例仅作为 conformance 证据。

P1：在固定 dsh 版本的原生 Agent 中执行跨窗口任务；确认默认压缩插件未串入对照、工具与请求轨迹可审计、预算包含主循环；需要可用模型和费用配置。未完成 P1 不得宣称完成 dsh 原生端到端评测。

P2：冻结任务家族、开发/评测划分、重复次数、模型版本及外部可运行子集，才进行策略质量/成本结论。

实施状态（2026-10-02）：P0/P1/P2 本轮范围完成，31 项测试、4 个离线 trial、24 个开发和 96 个评测 trial，以及 2 个外部 trial 已验收。PawBench 两次模型解题均预算终止，适配器/原评分器验收与模型成功分开。见 TASK、RESULTS。P0 强制退出残留锁仍需确认旧进程退出后清理。

## 4. 原生生命周期契约与在线验收

Cordis 4.0.4、dsh 0.1.0-rc.8，以真实 AgentLoop 驱动工具调用。NativeContextStrategy 替换 CompactionEngine；按 agent/pre-step、request-error 处理压力、new_context 与一次 overflow 恢复。多工具 assistant block 和全部结果组成不可拆单元；手动切换通过 runMaintenance 串行进入。仅支持整个 active surface 的换窗，不支持任意局部区域压缩。

原生 replacement 使用 compaction/start、summary、user/message surface replace、end。benchmark 非 surface 扩展事件在存储边界标记 ignorable；同一 replacement 的 source 元数据保存完整 notes、窗口链与 ledger。恢复通过 ctx.agents.resume，原始工具事件仍存在。metadata 不属于 provider wire 输入，已有真实 Adapter 序列化测试。

原生 Session 在内存接受事件后异步 flush；flush 失败需记录 committed，不承诺 R-008 的 P0 先落盘顺序、P0 单写锁/坏尾修复机制会自动套用到上游原生存储。提交前空摘要或取消不得替换 surface，辅助调用消耗仍保留。llm/stream 统一拦截主循环和摘要；未知 usage 使用保守预留，缓存归一化后不重复加总。

在线控制以 ONLINE_PROTOCOL、examples/online.json 为准：官方 deepseek-flash，thinking disabled、temperature 0，六个家族共 36 任务；开发/评测按 seed 划分，评测 24 任务 × 2 重复 × 2 策略。窗口 16000/触发 12000、Agent/摘要输出 1024、用户保留 1024；每 trial 16 次请求和 40000 token，两组全局共享 2000000 token；turn 180 秒。摘要信号覆盖 60 秒期限，provider idle 60 秒。上述是实现默认，不冒充用户逐项选择，也不代表真实 1M 窗口压力。

全部尝试保留，初始化故障以 stopped 进度记录未运行样本，不自动补跑。质量与资源单独报告，重复按任务聚类；开发/评测共享生成家族，不宣称未见家族泛化。

外部验收选 PawBench T037_claweval_T100_reverse_decoder，保持原 Prompt、fixtures 与原 grader，来源及 Apache-2.0/MIT 许可保留。受限 Windows workspace 工具替代 Docker/shell，原 900 秒期限保留，容量 32000/触发 24000、输出 4096、每组 24 请求和 100000 token。无需强制压缩或要求模型必然成功；必须执行原任务和原评分器、验证正确/错误产物、保留失败与环境差异。完整外部协议、长期记忆、UI、多模型及独立组件归因未纳入本轮。

生态发布候选的追加契约见 [RELEASE_SPEC](RELEASE_SPEC.md)，与上述冻结质量协议分别验收。用户确认 MIT；0.2.0-rc.1 增加 bundle、自动生命周期、Schema/peers、安装资源、prepare、白名单及真实 profile 验证。支持范围、默认配置与发布状态见 [RELEASE](RELEASE.md)。
