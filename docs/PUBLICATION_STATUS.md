# 公开发布执行记录

2026-10-02：用户明确授权 Linux CI、远程 Git 安装及 npm/社区目录公开发布，并确认 npm 名称 dsh-agent-benchmark。版本 0.2.0-rc.1，next tag，MIT。源码已推送并公开；用户原有文件和实验运行目录未提交。

| 项目 | 实际状态 | 证据 |
| --- | --- | --- |
| Windows / Ubuntu CI | 全部通过：两平台类型/37 项测试/包安装，Linux 原生 profile 两策略/JSONL resume/remove | [CI](https://github.com/cuguanren/Agent-Benchmark/actions/runs/37009765551)，源 commit af63bd4d2117b7be0cbb77890c9829a2b02e300a |
| 远程 Git 安装 | Ubuntu CI 通过；Windows 真实 dsh CLI add、两种策略、JSONL resume/remove 通过 | 同一 commit；runs/release/ci-af63/git-linux/git-report.json、native-git-report.json |
| GitHub 预发布 | 已公开 CI 验证的原始安装包及 SHA256SUMS、包/profile/Git 报告 | [v0.2.0-rc.1](https://github.com/cuguanren/Agent-Benchmark/releases/tag/v0.2.0-rc.1) |
| npm | 尚未发布，等待本机 npm login | dsh-agent-benchmark@0.2.0-rc.1，next tag |
| 社区目录 | 已完成：检查通过、PR 合并、目录集成和 Cloudflare 生产部署通过；详情页 HTTP 200、badge listed | [生产详情页](https://dsh.pub/en/plugins/dsh-agent-benchmark/)、[PR #119](https://github.com/dsh-pub/dsh-pub/pull/119) |

Windows/Ubuntu 包 SHA-256 一致：7cd8130cb6c34b47eed676629308d479c349bd2219501767cfba5d7b7bffa068。Linux profile 报告与实际 tarball 使用同一哈希；GitHub 上传后的资产 digest 也已核对。宿主组合固定为 dsh rc.8 / Cordis 4.0.4 / HMR 1.0.16。初次 Windows CI 因 Git 转换原 fixtures 换行而失败；新增 .gitattributes 后 37 项检查通过，原任务和评分器内容未改。

社区提交检查要求 main/exports 指向已提交文件，因此 dist/src 随源码提交；prepare 仍重建。pnpm Git 安装须将安装器打印的 package@codeload-commit 精确键写入测试/用户 profile 的 allowBuilds；只写包名不能授权该 Git 构建。测试未修改真实用户 profile。

实际合并、生产收录和 npm 发布分别核实；PR 提交或 CI 配置不能代替发布完成。

生产确认：2026-10-02 13:24 UTC，目录 commit c8d54a6cddab065328020cb99bdaa31337109a79 的 Cloudflare Workers build 成功。固定来源仍为 af63bd4；13:24 UTC 后实测详情页 200 且包含正确仓库，`https://dsh.pub/api/badges/cuguanren/Agent-Benchmark.svg` 显示 listed。npm 最后检查仍为 ENEEDAUTH，未宣称 registry 已发布。
