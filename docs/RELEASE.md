# dsh 插件安装与发布验收

版本：0.2.0-rc.1，MIT。[GitHub 预发布包](https://github.com/cuguanren/Agent-Benchmark/releases/tag/v0.2.0-rc.1)与[社区目录](https://dsh.pub/en/plugins/dsh-agent-benchmark/)已公开，npm 等待发布者登录。Windows/Ubuntu CI 的类型、37 项测试、包安装与远程 Git 安装通过；Linux 真实 profile 的两种策略及 JSONL 恢复通过。CI 使用 Node.js 24.21.0；[实时发布状态](PUBLICATION_STATUS.md)记录目录生产收录与 npm 状态。

## 安装

已验证宿主组合为 dsh 0.1.0-rc.8、Cordis 4.0.4、HMR 1.0.16、pnpm 11.19.0。rc.8 启动器调用 HMR registerConfig；实测当前默认解析的 HMR 1.0.19 缺少该接口，不能只锁 dsh 版本。以下将宿主安装在独立目录：

```sh
npm install --prefix ./dsh-host --save-exact @deepseek-ai/dsh@0.1.0-rc.8 @deepseek-ai/cordis-plugin-hmr@1.0.16
node ./dsh-host/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile headless add /absolute/path/dsh-agent-benchmark-0.2.0-rc.1.tgz
node ./dsh-host/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless --dump-config
node ./dsh-host/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless "your task"
```

需要 pnpm 在 PATH 中；安装 tarball 无需构建许可。模型与凭据由宿主配置，插件不添加模型服务。dump-config 应显示 agent-benchmark、agent-benchmark-persistence 启用，以及 session-persistence-jsonl、compaction-basic、tool-result-pruner 禁用，且没有 skipped patch 警告。

bundle 替换默认压缩服务、关闭结果裁剪，并以支持 benchmark 扩展 envelope 的 JSONL 子类替换默认存储；默认仍使用 `$DSH_HOME/sessions`。如果原 JSONL 行配置了其他 root、压缩或写入选项，将其完整复制到 `agent-benchmark-persistence.config`。上游 patch 的 name 是身份校验，config 是整块替换；不能通过改 name 重命名插件。其他存储 backend 不在支持范围内。

## 配置

向 profile 的 cordis.patch.yml 添加下列覆盖，或以 `--patch` 传入覆盖文件：

```yaml
- id: agent-benchmark
  config:
    strategy: window-reset
    capacityTokens: 32768
    triggerTokens: 24576
    outputReserveTokens: 1024
    totalTokenBudget: 200000
```

省略字段由 Schema 补齐。默认 strategy 为 local-summary；scope 为 body-after-prefix；userRetentionTokens 为 20000；summaryOutputTokens 为 1024；summaryRetries 为 1；timeoutMs 为 60000；reminderTokens 为 1024；hintBytes 为 4000；maxCalls 为 128；globalTokenBudget 为 5000000。容量是 bytes/4 的估算压力，实际消耗优先使用 provider usage。Agent 输出受 outputReserveTokens 限制；摘要另用 summaryOutputTokens。

创建、恢复和现存空闲 Agent 自动挂载，无需运行器 attach。window-reset 注册显式 notes/history/new_context 工具；local-summary 不注册恢复工具。摘要与主循环、失败请求都计预算；缺失 usage 按预留估算。globalTokenBudget 限定本次插件实例的合计消耗，并计入该实例加载的 session 已有 ledger；不提供跨进程共享预算账本。

只支持整个 active surface 的换窗。手动 /compact 使用空闲维护锁，失败返回宿主 ManualCompactionError；一次事务最多尝试一次 compaction/end。flush 失败报告 persistence，用 benchmark/compaction-failure 标明内存已提交，不能假装回滚。请求取消保留其 abort reason。

仅在全部 Agent 空闲时调整或重载配置。checkpoint 的策略/窗口配置不匹配时拒绝恢复；请恢复原配置或建立新 session。fork 从已观察 seed 继承 notes，重新开始窗口 ID 和计量。卸载清理恢复工具与监听，保留持久数据。

```sh
node ./dsh-host/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile headless remove dsh-agent-benchmark
node ./dsh-host/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless --dump-config
```

移除后 bundle 覆盖消失，base 服务恢复；session 数据仍在原目录。

## 本地发布检查

```sh
npm ci
npm run check
npm test
npm run verify:package
npm install --prefix runs/release-tools --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.1.0-rc.8 @deepseek-ai/cordis-plugin-hmr@1.0.16
npm run verify:profile
```

verify:package 生成 runs/release/dsh-agent-benchmark-0.2.0-rc.1.tgz 和 package-report.json，验证白名单、公开入口、无需构建脚本的 tarball 安装、包外 CLI、原 grader/Python、资源快照及无 dist 的干净源码 prepare 构建。包内 provenance 记录源码和构建锁；实验轨迹和用户文件不进入发布包。

verify:profile 使用隔离 DSH_HOME，通过真实 CLI add、dump-config、启动两种策略、原生 JSONL 恢复与 remove，写入 profile-report.json，保留配置/日志。fixture 不请求外部模型、不继承 API key；该验收证明安装与机制，不证明模型质量。报告 SHA-256 必须与待发布 tarball 一致。

Git 安装依靠 prepare；pnpm 10+ 的构建许可遵循宿主安装提示。npm run verify:git 从远程仓库安装固定 commit，验证 provenance、包外 CLI 与公开入口；CI 保存 git-report.json。远程安装和公开发布的最新执行状态见 PUBLICATION_STATUS.md。

CI 对 Windows/Ubuntu 检查类型、测试和包安装，另以 Ubuntu 验真实 profile 和远程 Git 安装。npm 名称为 dsh-agent-benchmark（原名称已被他人占用，用户确认改名），预发布使用 next tag。运行入口 dist/src 随源码提交，以满足社区目录要求的 committed runtime entry；prepare 仍负责重建。npm 发布、源码公开和目录提交的实际状态见 PUBLICATION_STATUS.md。

上游契约：[发布文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)、[配置文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)、[社区目录提交](https://dsh.pub/en/submit/)。以已安装 rc.8 的 patch 和 SDK 为实际兼容证据，不将 master 的变化自动纳入支持。
