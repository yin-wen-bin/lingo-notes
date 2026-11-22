# 默认字体：雅致清晰

2026-11-21。按用户要求保留手写感、书卷感、清爽自然，新增雅致清晰（`refined`）并设为新默认。扩展“连接与设置”和网页/PWA“设置”沿用独立字体卡片，共四个选项。

## 映射与账号行为

|用途|中文|英文|日文|
|---|---|---|---|
|标题|Noto Sans SC 600|Manrope 600|Noto Sans JP 600|
|正文|Noto Sans SC 500|Inter 500|Noto Sans JP 500|
|按钮|Noto Sans SC 500|Manrope 500|Noto Sans JP 500|

延续各端现有字号、布局和操作流程。使用真实字重，关闭伪粗体；音标保留独立字体回退。新方案适度加深扩展中的次要文字，不更改旧三套的家族及字重。清晰度仍受屏幕和浏览器影响，本次没有把字重检查等同所有设备的视觉验收。

默认用于新账号、缺少设置和退出后的公共界面；已保存的handwritten/bookish/clean选择不会被迁移覆盖。用户可随时在四个选项中切换。沿用即时预览、写入后GET确认、失败回退、打开/回到前台同步及过期请求/跨账号保护。

公共接口升为cloud/4，仅新增枚举和默认值，讲解语言、幂等、取消、历史与纯推送功能保留。新增 `202611210006_refined_typography.sql`；已部署001–005保持原哈希。006不批量更新既有字体选择；旧云端备份缺字段时补refined，显式旧选择及讲解语言保留，恢复后继续关闭提醒。

## 本地检查

本轮在 `codex/lingo-font-refined` 隔离目录，以当前 `codex/github-publish` 未提交源码的1161文件快照实施，不以旧主目录main作为发布基线。

- `npm ci --ignore-scripts`：安装140包，审计0项漏洞。
- `npm test`：**116/116通过**，0失败、0取消，207.4秒。覆盖旧三方案与新增方案、默认、保存/回读、账号和请求竞态、原有三语界面与历史列表。
- `npm run typecheck`：隔离目录和整合后的发布目录均通过。
- `npm run build -- --allow-unconfigured`：隔离目录通过，configured=false。
- `npm run build`：发布目录通过，configured=true，开发扩展ID仍为 `gpjdnplnbcghjhajllhpngenbplncgdi`。
- 后端和备份独立回归40/40通过；完整回归也包含这些检查。
- 独立Edge实际CSS/字体审查180项通过，覆盖两端、无主题属性的默认状态、四方案、三语言、JA根界面选择器、混合Latin标题/按钮及IPA。外部字体请求和浏览器错误均为0；这是合成DOM，不替代完整产品操作。
- 两端设置卡片生成16张320/390px合成截图；已目视两端refined320及旧clean320，未见裁切或横向溢出。

一次并发截图检查触及旧auth测试30秒上限，未发生断言失败。该测试预算调整为60秒；后续完整116项检查中auth用5.66秒通过，不将最初超时轮记作通过。

## 字体与构建完整性

新增Inter、Manrope及Noto Sans JP，共128个WOFF2、5,646,932字节。共12族、1155文件、46,210,388字节。原1027文件、9族原始manifest记录和原fonts.css前缀保留；全部文件解析、SHA256、字形覆盖、Unicode范围、真实字重轴和12份许可证核验通过。

Inter/Manrope采用Fontsource Variable 5.3.0，Noto Sans JP采用5.3.1；这是包版本号。Manrope来自Google Fonts的OFL发行，未采用作者另行授权的Manrope V5。字体在产品内同源分包，不请求外部字体CDN。

实际交付扩展/PWA各1155个字体哈希与源文件相符，Service Worker允许清单1155项，12份许可完整。扩展产物通过既有运行文件白名单与敏感文本扫描。打包脚本及合成ZIP回归已适配12份许可，未生成或上传新的商店ZIP。

## 整合与实际部署

整合前核对原 `.cache/cloud-v1-baseline.json` 文件哈希及本轮发布目录快照；162个改动（含132个新增文件）逐文件核对后复制，0并发覆盖。保留此前未提交的讲解语言、历史和界面修改，没有提交或推送GitHub；旧主目录源码未改。

生产006迁移已应用，001–005报告already_applied；app-api和review-tick已部署，Cron未改动。线上两个独立合成账号通过5组检查：cloud/4及默认refined、四方案持久化、部分设置保留旧选择、账号隔离、非法枚举拒绝与真实数据库默认。两个账号清理成功；模型调用、邮件发送、推送发送均为0，没有读取个人笔记。

网页：[学习中心](https://lingo-notes.pages.dev)。本次不可变部署：[4da847a6](https://4da847a6.lingo-notes.pages.dev)。生产28份JS/CSS/SW/字体清单/许可/字体样本回读状态及哈希通过；四方案三语标题/正文/按钮共36项实际字体核对通过，新默认标题600、正文/按钮500，浏览器错误0。线上登录页默认样式已目视检查。

扩展开发构建保留原加载位置 `D:/AI-Language-Learning/dist/extension`，由发布目录已核验产物镜像，ID不变。2368个生成文件复制前后核对；发布目录旧构建存于其 `.cache/refined-font-previous-dist`，原加载目录旧构建存于主目录 `.cache/refined-font-20261121/previous-root-dist`。重新加载扩展后使用四选项；PWA关闭重开以获取新版本。

本地证据：隔离目录 `.cache/refined-full-tests.log`、`refined-backend-tests.log`、`refined-frontend-tests.log`、`refined-unconfigured-build.log`、`refined-ui/`、`refined-font-assets/`；发布目录 `.cache/refined-build.log`、`refined-build-check.json`、`refined-live-check.json`、`refined-publish-check.json`、`refined-published-login.png`；主目录 `.cache/refined-font-20261121/` 保留源文件基线、整合清单与产物镜像核验记录。证据不进入Git。

没有执行真实iPhone Safari/主屏幕PWA的字体复测，未将合成窄屏或Edge渲染称为真机通过。既有07:00实际推送、七天试用、商店审核与语言准确性缺口继续见 [发布状态](release-status.md)。
