# 官方模型实验协议：controlled-v1

冻结日期：2026-10-02；本文件与 examples/online.json 在首次付费调用前确定。用户授权使用 DeepSeek V4.1-Flash 官方服务完成后续开发与验证。

模型路由固定为 `https://api.deepseek.com` 的 `deepseek-flash`。官方文档说明该名称对应 V4.1-Flash；使用官方 dsh DeepSeekAdapter，不自行实现 wire 协议。thinking disabled、temperature 0，控制条件在两组一致。发布依赖统一为 dsh 0.1.0-rc.8、Cordis 4.0.4，package-lock 保存所有传递依赖。无内置 basic compaction、结果裁剪或 retry 插件混入。

36 个纯文本任务：recall、multihop、correction、constraints、sequence、delayed-query 各 6 个 seed。每类 seed 0–1 为开发集，2–5 为评测集；后者在协议冻结后不能用于调整模型提示、阈值或工具。开发集 1 次重复，评测集 2 次重复；24 个开发 trial 与 96 个评测 trial。随机事实由稳定 SHA-256 派生，噪声是无关状态行。任务与参考答案仅在运行器中可用，模型唯一证据入口是 observe 工具；参考答案、验证器和 case 文件不作为工具输入。

统一两阶段机会：原生 Agent 先 observe 并自行决定如何保存状态，完成 turn 后由原生 runMaintenance 统一切换一次，再收到此前未见的具体问题。两组保留规则、恢复工具属于策略定义；不是独立摘要/检索因果消融。压缩期间不自动代 Agent 写/读 note。自动 pressure/new_context 路径另有功能测试；统一切换实验不证明各策略自选时机的收益。

人工窗口容量 16,000、body-after-prefix 触发 12,000，按 UTF-8 bytes/4 估算，不能声称这是 provider 的实际 tokenizer 或官方 1M 窗口耗尽。Agent/摘要输出上限 1,024，用户保留额度 1,024；单 trial 最多 16 次请求、40,000 累计 token，整次两组共享 2,000,000 token 上限。单 turn 180 秒，摘要 60 秒。调用前保守预留，实际 usage 高于预留时完整计入并阻止后续超预算调用；失败缺失 usage 保留估算/unknown。

按任务与 repetition 配对，交替两组执行顺序。保留所有计划 trial，错误、输出上限、取消与预算耗尽均有独立原因。逐 trial 保存原生日志、折叠后的计量状态与答案；每次结果后更新 JSON/Markdown。source、package-lock、运行时版本和配置/数据/实现哈希保存在运行目录，可核对实验使用的版本。

评分：普通任务严格匹配所要求的文本；constraints 必须是 JSON、仅有 answer 字段且值正确。报告正确率、运行失败、调用/工具/窗口数量、provider usage、时间和保守费用估计。费用按官方高峰未命中输入 2 元/百万、输出 8 元/百万计算上界，不冒充扣款账单。重复样本按任务聚类，提供固定随机种子的 bootstrap 区间，不把重复次数当作独立任务数。

结论限于这组受控任务、模型和协议，不声称通用策略优劣或统计显著性。外部基准单独保存任务身份、原 grader、许可、来源 commit、工作区产物及环境差异；不得用输出格式兼容替代运行原任务和验证器。

官方依据：[接口与模型名称](https://api-docs.deepseek.com/zh-cn/)、[模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

原生持久化边界：状态更新和请求计量作为非 surface 扩展事件，在 JSONL 存储边界标记 ignorable；replacement 的完整状态同时放在原生 user/message 的 source 元数据中，与 surface replace 同一事件提交。模型只看到正文，不看到 source 中的 notes/计量。原生 session 的内存接受先于 persistence flush；flush 失败须报告已提交状态，不能宣称 P0 的“落盘后才发布”顺序也适用于上游原生 Session。
