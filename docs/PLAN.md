# PLAN：实现设计与阶段安排

日期：2026-10-02；规范：[SPEC](SPEC.md)。

## 1. 技术方案

使用 Node.js 24、TypeScript、Node 内置测试器与 JSON 配置。优先使用内置文件/哈希接口；不引入数据库、Web 框架或独立服务。dsh/cordis 实际依赖以 package-lock 锁定；发布包与研究快照不同，开发时读取已安装类型验证，不依赖猜测的 API。

目录：`src/types.ts` 定义数据和错误；`src/session.ts` 管理活跃状态及追加轨迹；`src/strategies.ts` 实现两种转移；`src/tools.ts` 提供范围受限的恢复工具；`src/model.ts` 提供计量/预算/重试边界；`src/dsh.ts` 桥接 ctx.llm；`src/conformance.ts` 和 `src/cli.ts` 运行离线验证；`tests/` 与 `examples/` 提供证据。

策略核心接受模型接口与 session，不依赖 Codex 私有实现。dsh 插件的 `contextBenchmark` 服务通过 `inject: ['llm']` 获得模型接口，为摘要调用和未来 Agent 请求提供共用计量入口。P0 的上下文由本项目 session 持有，不能把服务桥接测试等同为原生 dsh Agent 集成。

## 2. 转移与持久化

单会话内串行执行。消息与 notes 修改先写追加事件再更新内存。转移先记录 start，读取快照，运行摘要或重建候选，验证容量与工具配对，再写包含完整 replacement 的 checkpoint，然后更新活跃状态，最后记录 end。start 无 checkpoint 表示未提交；有 checkpoint 无 end 表示已提交但生命周期未闭合，恢复须保留事实并报告。

启动恢复时重放事件，按最后合法 checkpoint 更新状态，再应用后续消息/notes/计量。尾部不完整记录不计入状态，打开写入前截断到最后合法记录边界，避免后续追加把坏尾部变成内部损坏。内部 seq/schema/结构损坏拒绝恢复。使用独占 lock 文件防止两个写入者交错；关闭释放本进程创建的 lock。

P0 对进程强制终止产生的残留 lock 采用保守拒绝；操作者需先确认原进程已退出再清理锁，当前不自动抢占。`recoveryStatus` 区分无 checkpoint 的未提交转移、有 checkpoint 无 end 的已提交转移，以及仍在 pending 的模型请求预留。

模型请求在发送前写轨迹和预留计量，失败也持久记录；返回 usage 后结算。无 usage 时估算消耗必须保留 `estimated` 标识。取消与重试不清空已耗预算。hook 在同一串行转移里运行；post hook 失败发生在提交之后，需要事件标明已提交，不能假装 rollback。

## 3. 验证方案

功能测试覆盖：摘要成功与空摘要拒绝；近期用户预算/Unicode 截断；摘要 overflow 按工具单元剪裁；reset 无摘要请求且旧消息仅通过工具恢复；notes hint 截断；工具ID配对；预算含辅助请求；取消、重试、失败不换策略；写入失败不提交；关闭/重启恢复；截断尾行修复；dsh 真依赖与模拟 LLM 服务组合。

离线场景：早期关键 ID 在噪声后仍可交接、用户约束保留、主动 note 保存及历史精确回查。脚本模型只实现稳定可观测协议，不用来证明某策略对真实模型更好。每条验证标明对照预期，允许设计中的失败作为通过的功能断言。

执行 `npm run check`、`npm test`、`npm run demo`，再检查报告/轨迹与 package 构建。通过后不重复扩大测试，除非新增改动或失败。

## 4. dsh 原生接入与在线运行（已实施）

P1 锁定 Cordis 4.0.4 和 dsh 0.1.0-rc.8。src/native.ts 实现原生 CompactionEngine，读取 deriveMessages/surface，按完整多工具单元切换，使用原生 surface replace。notes/history 工具仅挂在 reset 组；不加载 basic compaction、结果裁剪或隐式重试插件。真实 AgentLoop 测试验证跨窗口任务、主循环/摘要计量、自动压力、预算、取消与原生持久恢复。

src/native-persistence.ts 在 appendBatch 边界将非 surface 扩展事件标记 ignorable，不修改上游 readonly 事件注册集合；replacement source 以同一原生事件保存完整 benchmarkState。原生内存接受先于 flush，和第 2 节的 P0 顺序不同；不得把原生 flush 失败当未提交 rollback。

src/deepseek.ts 使用官方 DeepSeekAdapter，固定官方 baseURL、deepseek-flash、thinking disabled，凭据只存在内存。src/taskset.ts 生成六类受控任务，原答案与验证器仅由运行器持有。src/online.ts 驱动原生两阶段 matched-cut 实验，交错执行两组，保存源码/锁文件/配置/任务哈希、完整原生 JSONL、所有答案和 API usage，逐 trial 更新报告。普通答案失败不重跑；初始化失败停止并披露待运行数量。

在线预算在首次付费调用前写入 ONLINE_PROTOCOL 与示例，24 开发 trial 和 96 评测 trial 均已完成。配对统计保留失败，重复按任务聚类；范围为固定生成家族与统一切换机会，不推导独立摘要/检索因果效应。

src/external.ts 适配 PawBench 一个许可明确的纯文本编码任务；原 Prompt、decoder、target、grader 保留，gold/grader 不注册为 Agent 工具。Windows 独立目录与 src/python_workspace.py 限制工具能力，并明确不是 OS 容器。原 grader 用于真实工作区产物，另以独立正负产物测试验证评分边界；两组实际预算终止原样保留。

已审查的 dsh-eval 可参考批量隔离与报告设计，但当前任务是精确功能验证；不直接采用仅配对 completed trial 的分析。没有复制其代码。P1 不绕过 dsh 原生状态直接伪造“集成已通过”。

## 5. 约束与保守默认

用户已指定 DeepSeek V4.1-Flash 官方服务并授权完成后续内容。采用有限、可追溯的工程预算，具体控制见 SPEC/ONLINE_PROTOCOL。P0 无付费调用；P1/P2 官方 API 结果与费用估计单列。串行执行、独立 session/工作区、JSON/Markdown 导出；不引入 UI、Docker、自动续跑或完整排行榜协议。保留用户原有 lock-screen-test.md。

验证终点：31 项测试、严格类型检查、离线报告、全部 API 轨迹及外部原 grader 复核。scripts/audit-runs.mjs 验证本次报告与底层日志一致，RESULTS 记录结论边界。源码快照标识运行版本；运行后加固不改写已有结果或选择性重试。

## 6. 生态发布候选（追加范围）

按 RELEASE_SPEC P-001–P-007 扩展，不重跑付费实验。根包同时提供 dsh bundle 与研究 CLI；新增插件 Schema/自动生命周期，原生策略实例由 bundle fiber 直接拥有，共享 SDK 置于 peers。禁用 base 存储/压缩/结果裁剪，插入扩展 JSONL 子类与策略；自定义 JSONL 配置迁移到新存储行。

资源以 import.meta.url 定位安装包，源码 prepare 构建 dist/src 与 provenance；白名单仅包含发布和复现必需内容。独立 tarball 安装验证包外 CLI、原 grader/Python、公开入口和快照；从无 dist 的源码检验 prepare。

隔离 DSH_HOME，以真实 dsh CLI 管理 profile，确定性 fixture 验证两种策略、跨窗、恢复、add/remove。实际发现 rc.8 与默认 HMR 1.0.19 不兼容，验收固定 HMR 1.0.16，不修改宿主源码。37 项本地测试覆盖生命周期、fork/恢复计量及手动维护/落盘错误。Windows 已执行，Ubuntu 仅配置 CI。

MIT 由用户确认。产出本地 tarball 和与其 SHA-256 对应的 package/profile 报告；npm/社区目录提交、远程 Git 安装及更广兼容不冒充已完成。
