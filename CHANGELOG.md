# Changelog

## 0.2.0-rc.1 — 2026-10-02

npm 包名为 dsh-agent-benchmark，用户确认以此避开已占用的 agent-benchmark；CLI 命令和内部插件标识仍为 agent-benchmark。预发布使用 next tag。

- 可安装 dsh bundle、Schema、公共 exports、共享 peer 依赖和 MIT 许可证。
- Agent 自动挂载与清理、空闲重载、同 ID 恢复计量、fork 独立窗口与预算。
- 修复手动压缩锁、宿主错误类型、命令关联及 flush 失败重复关闭事务。
- 安装后的 CLI、外部 grader/Python 与源码快照不再依赖项目工作目录。
- 白名单包、源码 prepare、依赖 provenance、真实 profile 验收及 Windows/Ubuntu CI。
- 支持固定 dsh rc.8 / Cordis 4.0.4 / HMR 1.0.16；候选尚未公开发布。

既有官方在线和 PawBench 实验及其源码快照保持冻结，不因发布工程改写结果。
