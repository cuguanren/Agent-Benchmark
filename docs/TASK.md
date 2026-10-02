# TASK：开发任务与验收追踪

日期：2026-10-02；输入：[SPEC](SPEC.md)、[PLAN](PLAN.md)、[策略比较](CODEX_CONTEXT_STRATEGIES.md)、[在线冻结协议](ONLINE_PROTOCOL.md)。T-001–T-011 本轮工程范围完成；模型质量与工程验收分开，详见 [RESULTS](RESULTS.md)。

| ID | 需求 | 依赖 | 产物与完成判据 | 状态 |
| --- | --- | --- | --- | --- |
| T-001 | R-012 | 无 | Node/TS 项目、锁文件、类型/构建/测试命令 | 完成 |
| T-002 | R-001、R-008、R-011 | T-001 | P0 session、追加日志、checkpoint；重启、尾行、单写锁测试 | 完成 |
| T-003 | R-005、R-006 | T-002 | 预算与计量；辅助/失败调用不免费、unknown 不作 0 | 完成 |
| T-004 | R-002、R-006、R-007 | T-003 | 摘要正常/空/过大/overflow/取消；提交前失败保持旧 active | 完成 |
| T-005 | R-003、R-004、R-011 | T-002 | reset、notes/history；零摘要、显式恢复、限额与路径验证 | 完成 |
| T-006 | R-010 P0 | T-003–T-005 | 真实 Cordis + ctx.llm 桥接，usage 与工具 ID 映射 | 完成 |
| T-007 | R-009、R-012 | T-004–T-005 | 离线 CLI、JSON/Markdown、独立 JSONL、全部失败保留 | 完成 |
| T-008 | P0 全部 | T-006–T-007 | check/test/demo/build 与可复现 README | 完成 |
| T-009 | R-010 P1 | T-008 | 原生 CompactionEngine/AgentLoop/Session/工具；跨窗、主循环计量、取消、自动压力、原生 JSONL resume | 完成 |
| T-010 | P1/P2 | T-009 | 冻结 36 任务/模型/预算；24 开发 + 96 评测 trial、源码快照、配对报告/日志审计 | 完成 |
| T-011 | D-005 | T-009 | PawBench 一个原任务/原 grader 子集；许可/环境差异、正负产物、2 个官方 API trial 及失败轨迹 | 完成（可运行适配；模型两组未解题成功） |

## 自动与离线验证

Windows、Node.js v24.14.0、Python 3.14.3；Cordis 4.0.4，dsh 直接依赖统一 0.1.0-rc.8，传递版本见 package-lock。最初 P0 的 dsh-llm 0.0.1-rc.1 已被替换，桥接回归仍通过。

| 验证 | 结果 | 覆盖 |
| --- | --- | --- |
| npm run check / build | 通过 | 严格类型、真实发布包 API |
| npm test | 37/37 通过 | core 17、dsh 3、native 6、online 2、external 3、plugin 6 |
| 离线 demo | 4/4 trial、36/36 断言 | 两场景 × 两策略；conformance，不支持质量结论 |
| scripts/audit-runs.mjs | 通过 | 120 个在线 trial + 2 个外部 trial，哈希、usage、窗口/请求/工具、原 grader 与 fixtures |
| git diff --check | 通过 | 文档与代码空白检查；新文件另经构建/测试 |
| 凭据文件检查 | 通过 | 源码、文档、测试、配置、third_party、全部本次运行产物无 API key |

P0 核心覆盖：用户额度与 Unicode、旧摘要排除、完整工具配对、空/过大摘要、overflow 单元剪裁、固定重试、取消/超时、hook 提交状态、失败预留与缓存规范化、落盘失败不发布、重放/尾行/内部损坏/坏 checkpoint/锁/未闭合生命周期，离线失败样本保留。

原生覆盖：真实 AgentLoop 工具调用；native surface replace 与稳定窗口；reset 显式 notes 恢复、零辅助摘要；全部主循环/摘要调用计量；真实 JSONL flush 后新 Context 的 ctx.agents.resume；自动压力与预算失败；多工具单元不可拆、孤立/重复/缺失/交错结果拒绝；空摘要和取消保持旧 active、已耗预算保留；官方 Adapter wire 不带 notes 元数据且保留输出上限/温度/thinking。

外部覆盖：原 grader Python 与原文逐字一致；缺失产物全 0、正确大小受限产物六指标全 1；fixtures 写保护、路径越界及受限 Python 主机能力拒绝。独立测试 oracle 未注入 Agent。

## 官方模型与实验验收

用户提供并授权 DeepSeek V4.1-Flash 官方服务；实际名称 deepseek-flash，官方 /models 验证可用。凭据仅供认证，未写入文件，子进程不继承 key。

开发 24/24、评测 96/96 trial 完成，全部实际 usage、无运行失败，无选择性重试。评测本地摘要 40/48、换窗恢复 39/48；累计 368725 / 613245 token，辅助摘要 48 / 0，全部 2 窗口。成功率差 +2.1 个百分点，按任务聚类区间 [-10.4, 16.7]，不能判定成功率优势。模型有 8/9 个错误答案，原样保留。

PawBench 两个 trial 的原 grader 执行成功；模型均 budget_exhausted（原报告为原生 error，审计从原生日志细化），1 窗口、无摘要；一个未生成 encoded.dat，另一个产物错误且过大，均无 writeup。源码、protocol、原始分数、全部产物与失败消耗已保存。这不构成外部解题成功或压缩质量对比，但满足原任务和原验证器可运行的适配完成判据。

本地证据：runs/demo、runs/online-development、runs/online-evaluation、runs/pawbench-official、runs/completion-audit.json。运行目录被 gitignore 排除；保存报告与源码快照，重跑必须使用空目录。测试临时目录已清理，用户原有 lock-screen-test.md 保留。

## 已披露的边界

容量为 bytes/4 估算，实际消耗来自 API usage；并非官方 1M context 上限实验。两阶段固定切换比较组合策略，不识别摘要/检索独立贡献，不测试未见家族或长期多次换窗。

原生 Session 内存接受先于 flush；P0 的先落盘、锁与尾行恢复保证不自动适用于上游原生存储。原生 flush 失败记录 committed。有限 Python 工具不是任意代码隔离容器，外部协议与 Docker/shell 有差异。初始化故障保留 stopped 状态及缺失数量，当前没有自动续跑。

本轮不包含完整外部基准、UI、Docker、多模型、发布、四组/五组归因实验；这些是新范围，不将本轮失败质量结果隐藏为工程“未执行”。

## 发布候选追加任务

用户“继续后续任务”授权补齐本地发布工程；用户选择 MIT。原 T-001–T-011 实验仍冻结，新范围见 RELEASE_SPEC。

| ID | 契约 | 产物与完成判据 | 状态 |
| --- | --- | --- | --- |
| T-012 | P-001、P-003 | bundle、公开 exports、Schema、peers；真实 loader 激活 | 完成 |
| T-013 | P-002 | 自动挂载/卸载、同 ID 恢复、fork 独立计量、手动维护锁及落盘失败只关闭一次；6 项回归 | 完成 |
| T-014 | P-004、P-005 | 包外 CLI/资源/原 grader；白名单、MIT、prepare 与 provenance；独立 tarball/干净源码安装 | 完成 |
| T-015 | P-006 | 真实 CLI add/dump-config/启动两组/跨窗/JSONL resume/remove，隔离 home 与日志 | 完成（Windows 本地与 Linux CI，固定 HMR 1.0.16） |
| T-016 | P-007 | RELEASE、CHANGELOG、Windows/Ubuntu CI、报告与包哈希 | 完成（Windows/Ubuntu CI 实际通过，源 commit af63bd4） |

本地证据：runs/release/dsh-agent-benchmark-0.2.0-rc.1.tgz、package-report.json、profile-report.json；profile-home-* 保存配置与原生日志。最终报告 SHA-256 必须匹配 tarball。验收不继承 API key、不新增付费调用。

该阶段达到固定宿主组合的发布候选判据；远程 Git 与跨平台执行已交付。GitHub 预发布包已公开，npm/目录生产收录分别见下方追加任务。默认 HMR 1.0.19 缺失 registerConfig，属于已复现的宿主组合问题；1.0.16 验收通过，不声称任意当前 dsh 安装均可用。

## 公开发布追加任务

用户明确要求 Linux CI、远程 Git 安装及 npm/社区目录公开发布，并确认 npm 名称 dsh-agent-benchmark。原实验保持冻结。

| ID | 产物与完成判据 | 状态 |
| --- | --- | --- |
| T-017 | Windows/Ubuntu 37 项测试、独立包安装；Linux 真实 dsh profile 两策略/恢复/卸载；报告与包哈希匹配 | 完成，CI 37009765551 全部通过 |
| T-018 | 固定远程 commit 安装并验证公开入口与 CLI；真实 dsh CLI Git add/恢复/remove | 完成，Linux CI 与 Windows 原生 Git 安装通过 |
| T-019 | MIT 预发布包公开；npm next 发布后核对版本与 registry integrity | 完成：GitHub/npm 0.2.0-rc.1 已发布；next、registry integrity、公开冷安装和原生 dsh npm 安装通过 |
| T-020 | 社区源文件检查、提交 PR、合并及生产目录收录 | 完成，PR #119 合并、Cloudflare 部署通过；生产页 200、badge listed |

最新状态与公开证据见 [PUBLICATION_STATUS](PUBLICATION_STATUS.md)。冻结的源码 commit af63bd4d2117b7be0cbb77890c9829a2b02e300a 对应 CI 与 GitHub 安装包；状态文档更新不改写该包。
