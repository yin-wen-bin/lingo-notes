# 发布协作边界

当前实施公共接口 cloud/5，见 docs/cloud-v1-contract.md。此仓库不包含旧产品任务队列或旧代理工作区。

|职责|范围|
|---|---|
|发布负责人|白名单、文档、许可、源码审查、验证、GitHub 与商店状态|
|打包与CI|构建版本、ZIP 检查、来源配置、Windows 检查流程|
|隐私与支持|公开政策页面、邀请/BYOK说明、应用访问入口|
|商店材料|合成截图、中文介绍、权限声明、审核步骤及验收表|

2026-11-20语言功能：后端子任务负责supabase与后端/恢复测试；扩展子任务负责extension、shared/cloud-types与扩展测试；PWA子任务负责pwa及其测试；主代理负责契约、限额真实验证、审查、部署及哈希核对整合。初轮模型验证最多六次；发现日语同语复制并完成修复后，用户另行授权一次定向补测。不自动重试；子任务不访问生产、不提交或部署。

所有真实云端、手机、商店或模型验证须记录实际证据；模拟通过不等同真实平台通过。不要在测试或 CI 中读个人数据、调用付费模型或改变生产。

2026-11-21字体扩展：在codex/lingo-font-refined隔离目录，以当前发布目录所有未提交源码的逐文件哈希快照实施。字体子任务只改shared/typography，前端子任务只改extension/pwa和其回归，后端子任务只改supabase与后端/备份测试；主代理维护契约、构建/打包、发布目录哈希核对整合和授权部署。保留旧三套方案与已有账号偏好，新增雅致清晰为默认。整合前复查原始baseline文件与发布目录快照，不覆盖并发变化。没有GitHub推送或商店上传。

2026-11-21扩展导航：在codex/lingo-navigation隔离目录，基于当前发布目录逐文件哈希快照实施。UI子任务负责panel.html/panel.css/panel-i18n.ts，控制器子任务负责panel.ts/history.ts/navigation.ts及纯状态测试，测试子任务负责导航、历史、语言和登录浏览器回归；主代理维护互操作测试、文档、全套验证、哈希核对整合和原路径扩展构建。浏览器测试串行分配窗口，全部使用合成记录。保留四字体和cloud/4，不部署PWA或后端，不提交或推送GitHub，不上传商店。

2026-11-22新建与设置精简：codex/lingo-settings-ui，UI子任务只修改panel.html/panel.css/panel-i18n.ts，控制器子任务只修改panel.ts，测试子任务维护相关test文件。主代理维护计划、设计核对、完整验证与哈希整合。基线与运行文件快照在主目录.cache/settings-ui-20261121；不复制真实记录、凭据或.env。仍为cloud/4。

2026-11-22复习控制：codex/lingo-review-controls；基线在主目录.cache/review-controls-20261122。review_backend只改supabase/**、cloud-backup/restore脚本及后端/备份测试；review_pwa只改pwa/**与pwa测试；review_extension只改extension/**与panel-cloud测试。主代理维护契约、共享类型、执行文档、发布/集成脚本、真实合成验证及最终交付。新接口cloud/5，前端动作固定review.cards、review.complete、review.mastery；每日数量review_daily_limit。所有子任务只用合成数据，不执行生产/模型/部署/提交。共享源码在隔离目录以不重叠文件职责并行，实际发布前复查release与原cloud-v1基线哈希。

本轮状态：子任务审查与整合完成；156/156回归、5组已部署合成验证通过。007/函数/PWA已上线，原开发扩展目录已更新；没有GitHub推送或商店提交。临时验收账号全部清理，付费模型和用户测试推送均0次。证据见docs/review-controls-validation.md。
