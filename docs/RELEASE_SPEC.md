# 生态插件发布候选规范

日期：2026-10-02；输入：上一轮发布差距审查及用户“继续后续任务”。许可证经用户选择为 MIT。目标是可安装、可配置、可卸载的 dsh 发布候选；本轮先生成本地包和验收证据，实际 npm/目录发布另行处理。

| ID | 契约 | 验收 |
| --- | --- | --- |
| P-001 | 根包声明 dsh.bundle 和 patch，公开插件/原生策略/核心库入口 | 真实 dsh plugin add、dump-config、启动与 remove |
| P-002 | 创建、恢复及现存空闲 Agent 自动挂载；销毁及插件卸载清理工具/监听 | 不依赖运行器 attach；同 ID 恢复、空闲重载、双会话隔离 |
| P-003 | Schema 验证默认值、整数、跨字段关系与策略；共享宿主服务使用 peers | 无效配置加载失败；同一宿主服务实例 |
| P-004 | 已安装 CLI 不依赖项目工作目录，资源和源码快照可定位 | 从包外目录执行离线 CLI、资源读取及外部 grader |
| P-005 | 白名单打包、MIT/LICENSE、third_party 声明、Git 构建和预发布检查 | tarball 无测试/实验轨迹/无关文件；干净安装后公开入口可加载 |
| P-006 | 锁定 Cordis 4.0.4 / dsh 0.1.0-rc.8，真实 profile 执行跨窗与恢复 | 原生日志和模型确定性 fixture；不重跑已冻结质量评测 |
| P-007 | 发布文档、CI 和版本化记录区分候选/实际发布及支持范围 | README、CHANGELOG、TASK、发布报告；不声称更广版本已验证 |

插件沿用两种策略，不接管用户的模型凭据或创建新模型服务。默认 local-summary；用户可通过 profile patch 改为 window-reset。安装层显式替换 basic compaction，并关闭会干扰机制对照的结果裁剪；固定 rc.8 的 base 不包含 image-offload，有效组合由 dump-config 验证。

原生扩展事件依赖支持其 envelope 的 JSONL backend。发布 bundle 禁用 base JSONL 行，并插入本项目的 JSONL 子类，默认使用同一 dshHomePath('sessions')；沿用原生 coordinator，不直接修改上游事件集合或 persistence 方法。已有自定义 JSONL 配置须完整复制到 agent-benchmark-persistence 行（patch 的 config 是整块替换）；其他存储后端不支持。恢复仍不承诺 P0 的先落盘发布顺序。

配置重载只在现存 Agent 空闲时验证；策略或容量配置变化不能静默解释已有不匹配 checkpoint。已有 checkpoint 不兼容时明确拒绝，操作者恢复原配置或新建 session。卸载移除本插件工具及监听，保留持久数据；不替用户删除 session。

本次发布验证不要求外部模型任务成功、完整基准、容器或多模型支持。MIT 不覆盖第三方代码的独立许可；全部声明保持原样。

## 公开发布阶段追加

用户随后明确授权执行 Linux CI、远程 Git 安装、npm/社区目录公开发布；原名称 agent-benchmark 已被其他 npm 发布者占用，用户确认改为 dsh-agent-benchmark。内部插件名与 CLI 保持 agent-benchmark，兼容既有 checkpoint。版本 0.2.0-rc.1，MIT，npm next tag。公开源码与 committed dist/src 满足目录的静态运行入口检查；Git prepare 仍重建。实际发布完成须分别验证 CI、registry integrity 和生产目录，不能以 PR 已合并替代上线。证据见 [PUBLICATION_STATUS](PUBLICATION_STATUS.md)。
