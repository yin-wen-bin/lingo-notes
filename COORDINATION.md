# 发布协作边界

1.0.1 使用当前 cloud/6 的发布工作区快照。自部署编排、实例构建与 Edge 打包并行实现，发布负责人核对目标隔离、完成回归并统一发布。原发布工作区、既有商店 ZIP 和开发构建留作基线。

当前实施公共接口 cloud/6，见 docs/cloud-v1-contract.md。Codex 在 `codex/lingo-mobile-repair` 基于当前发布工作区快照完成手机端、后端与侧栏修复。生产诊断只读投递和调度元数据，合成测试不使用用户笔记或付费模型。

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

2026-11-22划词直接查询：codex/lingo-selection-queue，以发布HEAD 6e56abe和1307文件快照实施。selection_queue负责background、队列core/内部类型和core测试；selection_panel负责panel控制器、状态条与三语样式；selection_tests负责真实后台协调的合成浏览器测试及必要旧harness适配。主代理维护计划、文档、代码复核、全套检查、哈希整合和原路径构建。源码文件职责不重叠，Edge测试独占分配窗口，全部使用合成数据。cloud/5不变，无云端/模型/部署/提交；整合前核对原cloud-v1基线文件及发布源文件哈希。

同日后续源码发布：用户另行授权将已完成的划词直接查询修改提交并推送GitHub。发布负责人仅在codex/github-publish工作区核对本次22文件、原整合哈希及远端main，按明确路径暂存，普通Git fast-forward推送；不推旧main或其他分支，不包含缓存、生成构建及凭据。

2026-11-23 划词展示、历史同步与连接恢复：基于公开工作区 HEAD aac14ded978f890498c5ae36b624e45c49b26f27，在 codex/selection-repair 隔离分支实施。连接子任务负责 selection-client/background/selection-queue 及新增 core 测试；界面子任务负责 panel/history/三语样式及纯状态测试；测试子任务负责双端断开的平台夹具、浏览器回归及独立闲置验证工具。主代理负责代码复核、文档、完整检查、真实 Edge 闲置验证及原路径构建整合。分工文件不重叠，不调用 WorkBuddy，不访问个人记录或付费模型。整合前复查 1326 个源文件、原加载构建、旧 cloud-v1 基线及已提交 Edge ZIP 的哈希。仅修改扩展、相关测试和文档；不部署云端、不自动提交或推送、不改本机审核检查或已送审包。

同日继续并发修复与 1.0.1 本地交付：race_panel_repair 只维护 panel.ts；race_regression_tests 维护 selection/navigation 浏览器测试及必要的合成平台；release_boundary_review 先只读复核发布与身份边界，经复现后才维护队列跳过身份的会话持久化及对应 core 测试。主代理负责 manifest 版本、完整检查、文档和逐文件哈希整合。所有后台及浏览器测试使用合成记录，独立于微软审核账号和生产学习记录；已送审 ZIP 不覆盖，不触发网页、后端或商店发布。

同日防抖修复：codex/sidebar-stability 基于已整合 1.0.1 的当前快照实施，继承的 24 项未提交改动保持。sidebar_jitter_diagnosis 负责 panel.ts/panel.css；jitter_test_design 仅维护 selection 浏览器测试；jitter_safety_review 只读复核无变化渲染、终态、导航、提示计时器和连接协调。主代理维护新基线、依赖、文档、完整验证和原路径整合。三条故障均先取得有效旧码红灯再修复，测试只用合成接口及独立临时浏览器，不访问个人笔记或模型 Key。
