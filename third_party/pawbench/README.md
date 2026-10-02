# PawBench 解码任务子集

来源：agentscope-ai/PawBench，commit `0f794a8bb6c27aa9ee4091b2691fa30e4ed9cc8f`。原始任务 ID `T100_reverse_decoder`，PawBench 身份 `T037_claweval_T100_reverse_decoder`。

保留原始 task.md、decoder.py、target.txt；grader.py 从 task.md 的 Automated Checks Python 代码块逐字提取，无评分行为修改。PawBench LICENSE 与 NOTICE 完整保留；任务上游 Claw-Eval 的 MIT LICENSE 单独保留，来源与核对 commit 在 manifest.json 中记录。

适配代码位于 src/external.ts，不放入原始文件。模型只收到 Prompt 小节及 fixtures，不收到 Expected Behavior、Grading Criteria、评分器或测试 oracle。工具环境、Python 限制、timeout 与原协议差异写在运行报告中。没有使用完整 PawBench 分数或声称官方认证。
