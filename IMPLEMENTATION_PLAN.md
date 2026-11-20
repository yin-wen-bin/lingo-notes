# Lingo Notes GitHub 与 Chrome 商店发布计划

2026-11-20。当前产品：Chrome 扩展、Supabase、DeepSeek BYOK、PWA，只处理云端新记录。保留现有 UI 与 cloud/2 契约，不增加自助注册、收费或通用部署平台。

1. 以当前源码建立干净的公开 GitHub 仓库 yin-wen-bin/lingo-notes，默认 main，项目代码 MIT；旧开发历史不发布。按白名单保留应用、云端、必要测试、字体许可及维护文档。
2. 在全新目录完成 npm ci、npm test、npm run typecheck 和无生产配置构建；Windows CI 不持有生产密钥、不自动部署。
3. 商店包只含扩展运行文件；统一 manifest 版本来源，核对最终商店 ID、公钥和后端来源允许列表。保留当前开发版可用性。
4. 提供中文商店介绍、合成截图、隐私/支持页面、权限与数据流说明、专用审核账号及测试步骤。审核凭据不进入源码或公开材料。
5. 首发通过 Chrome 商店 Unlisted 链接分发，保持邀请制与用户自备 DeepSeek Key。开发者账号注册/验证/缴费由本人完成；审核通过后手动发布。
6. 补齐真实 Chrome 安装流程、07:00 关机电脑后的手机推送、真机字体、真实空目标恢复、已知语言错误复核与七天试用。完整放行与源码公开、审核状态分开报告。

现有发音图片由项目所有者选择保留，其授权由所有者另行处理，不列入代码 MIT 授权。当前状态见 docs/release-status.md，商店交付见 docs/store-release.md。
