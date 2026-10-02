# Agent-Benchmark

基于 DeepSeek Harness（dsh）的上下文策略插件与实验运行器。npm 名称 `dsh-agent-benchmark`，0.2.0-rc.1 / MIT；安装、配置、卸载和支持版本见 [发布指南](docs/RELEASE.md)，公开发布状态见 [执行记录](docs/PUBLICATION_STATUS.md)。已公开的安装包见 [GitHub 预发布](https://github.com/cuguanren/Agent-Benchmark/releases/tag/v0.2.0-rc.1)，插件已收录于 [dsh.pub](https://dsh.pub/en/plugins/dsh-agent-benchmark/)，并已发布到 [npm](https://www.npmjs.com/package/dsh-agent-benchmark/v/0.2.0-rc.1)。使用 `dsh-agent-benchmark@next` 或锁定 `@0.2.0-rc.1`。

37 项测试与 4 个离线策略试验通过。官方 `deepseek-flash`（V4.1-Flash）完成 24 个开发 trial、96 个评测 trial，全部有 API usage。评测集本地摘要正确 40/48，换窗恢复正确 39/48；成功率差区间包含 0，不支持策略优劣结论。资源和失败分析见 [RESULTS](docs/RESULTS.md)。发布工程不改写冻结实验或其源码快照。

PawBench 原任务、fixtures 和原评分器可运行；本次两组均预算终止，未解题成功，也未触发换窗。正负产物测试证明原评分器接受正确结果、拒绝缺失结果。该子集采用受限 Windows 工具环境，不代表完整外部协议或官方排行榜。

## 运行

需要 Node.js 24；离线验证无需 key。外部子集另需 Python 3。依赖版本由 package-lock 锁定。

```sh
npm ci
npm run check
npm test
npm run demo
```

示例在 `runs/demo/` 生成 JSON/Markdown 和各组 JSONL。输出目录必须为空；再次运行指定新目录：

```sh
node dist/src/cli.js run examples/conformance.json --out runs/demo-new
```

离线模式为 conformance，脚本模型仅证明机制契约。失败试验保留，CLI 返回非零；usage 缺失显示 null/unknown，估算独立标识。

## 官方在线实验

协议见 [ONLINE_PROTOCOL](docs/ONLINE_PROTOCOL.md)。使用环境变量 `DEEPSEEK_API_KEY`，或添加 `--key-stdin` 从不回显的终端输入凭据；key 不写入配置、日志或产物。

```sh
node dist/src/cli.js online examples/online-development.json --out runs/dev-new --key-stdin
node dist/src/cli.js online examples/online.json --out runs/eval-new --key-stdin
node dist/src/cli.js external pawbench --out runs/paw-new --key-stdin
```

六个家族共 36 任务；每类按 seed 分成开发集 12 任务、评测集 24 任务。评测重复两次，形成 48 对。固定任务、模型、采样、切换机会与预算，工具和保留内容依策略声明区别。该划分不测试未见家族的泛化。

每次运行保存源码快照、锁文件、配置/任务哈希、答案及原生日志。错误答案与运行失败保留；初始化故障以 stopped 状态披露未运行样本，不自动续跑或选择性重试。

本次证据位于 `runs/online-development`、`runs/online-evaluation`、`runs/pawbench-official`，由 .gitignore 排除。已有这些目录时执行 `node scripts/audit-runs.mjs`，核对哈希、usage、窗口、请求数、fixtures 和原评分器；输出 `runs/completion-audit.json`。

## 开发接口与边界

根入口导出插件 name/inject/Config/apply 及 P0 的 Session、transition、ensureWindow、callModel、RecoveryTools。公开子入口包含 dsh、native、runtime、persistence、resources、external。原生策略替换 CompactionEngine；运行器组合 AgentLoop、Session、ToolRuntime 与 JSONL persistence。共享 Cordis 4.0.4 / dsh 0.1.0-rc.8 使用 peerDependencies，完整宿主另固定 HMR 1.0.16。实验运行器不加载 basic compaction、结果裁剪或隐式 provider 重试；插件 bundle 关闭 basic 与结果裁剪，其余宿主插件由 profile 管理。

窗口以 UTF-8 bytes/4 加开销估算，用于制造受控压力，不能称为官方 1M 窗口耗尽。主循环、摘要、失败预留均计预算；usage 中缓存不重复计入。摘要输出上限、虚拟恢复存储、路径/大小目录 hint 是本项目明确契约，具体区别见 [策略比较](docs/CODEX_CONTEXT_STRATEGIES.md)。

P0 使用 Session.resume(path)，支持尾行修复、内部损坏拒绝及单写锁；不自动抢占残留锁。原生路径使用 ctx.agents.resume，checkpoint source 元数据保存 notes、窗口和计量，provider 只发送正文。原生 Session 内存接受先于 persistence flush，不能沿用 P0 的“落盘后才发布”保证。受限 Python 工具用于闭合工作区任务，不是任意代码的 OS 隔离后端。

## 文档

| 文档 | 用途 |
| --- | --- |
| [SPEC](docs/SPEC.md) | 需求、契约和验收范围 |
| [PLAN](docs/PLAN.md) | 架构、生命周期和阶段设计 |
| [TASK](docs/TASK.md) | 任务追踪及实际验证 |
| [ONLINE_PROTOCOL](docs/ONLINE_PROTOCOL.md) | 冻结任务、模型与资源 |
| [RESULTS](docs/RESULTS.md) | 成功率、成本及外部失败 |
| [DECISIONS](docs/DECISIONS.md) | 用户决策、工程默认与长期候选 |
| [RELEASE_SPEC](docs/RELEASE_SPEC.md) / [RELEASE](docs/RELEASE.md) | 发布契约、安装配置与支持边界 |

## 设计来源与致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：可组合的 Agent 与插件架构。
- [PawBench](https://github.com/agentscope-ai/PawBench)：Model × Harness 评测、任务切片与诊断轨迹。
- [Harness-Bench](https://arxiv.org/abs/2605.27922)：共享环境、预算和协议下的配置比较。

本项目采用 [MIT](LICENSE)。[PawBench 子集](third_party/pawbench/README.md) 保留来源 commit、Apache-2.0 LICENSE/NOTICE 和任务上游 Claw-Eval MIT LICENSE；原 grader 从原任务逐字提取。未复制 Harness-Bench 或 dsh-eval 代码/数据。第三方许可独立适用；本项目与上述项目没有已确认的官方关联。
