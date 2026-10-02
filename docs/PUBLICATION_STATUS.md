# 公开发布执行记录

2026-10-02：用户明确授权 Linux CI 实际执行、远程 Git 安装验证和 npm/社区目录公开发布。原 npm 名称 agent-benchmark 已归其他维护者所有；用户确认改用 dsh-agent-benchmark。版本保持 0.2.0-rc.1，npm tag 为 next，源码 MIT。

| 项目 | 当前状态 | 验收证据 |
| --- | --- | --- |
| 本地候选 | 37 项测试与 tarball/profile 验收通过 | runs/release/package-report.json、profile-report.json |
| Linux CI | 准备执行 | .github/workflows/ci.yml，包含包安装/真实 profile/Git 安装及报告上传 |
| 远程 Git 安装 | 准备执行 | scripts/verify-git.mjs，以完整 commit 固定来源 |
| GitHub 源码公开 | 准备推送并公开 | https://github.com/cuguanren/Agent-Benchmark |
| npm | 等待用户本机 npm login | dsh-agent-benchmark@0.2.0-rc.1，next tag |
| 社区目录 | 待公开源码与 Linux 验收后提交 | 根 bundle、已提交 dist/src、README 和 MIT |

记录中的“准备/待”不表示已完成。后续仅依据远程实际结果更新，不据 CI 配置或模拟安装推断成功。
