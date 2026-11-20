# Lingo Notes

随手记，然后让AI帮你整理和复习。

在 Chrome 划词或框选截图，用中文理解英文、日文，再到手机阅读保存的笔记和每日精选卡片。项目由 Chrome Manifest V3 扩展、Supabase 云端和 React PWA 组成，模型仅使用用户自己的 DeepSeek API Key。

**当前为邀请试用版。安装扩展不自动获得账号。** 请先通过邀请渠道开通账号，再设置密码、登录并填写自己的 Key。Lingo Notes 当前不收软件使用费；模型 API 费用由 DeepSeek 按你的账户用量直接收取。

- [学习中心](https://lingo-notes.pages.dev)
- [隐私说明](https://lingo-notes.pages.dev/privacy)
- [使用与支持](https://lingo-notes.pages.dev/support)
- [当前验收状态](docs/release-status.md)

Chrome 商店首发将采用不公开列出（Unlisted）的链接安装方式。尚未取得可安装链接时，不把开发包称作商店已上架版本。

## 功能

- 划词、自动提取上下文、网页框选截图；图片预览确认后才上传。
- 流式中文讲解、完整例句和译文；单词和例句点击发音，再次点击停止。
- 笔记和确认截图按账号保存在私有云端，支持搜索及删除。
- 默认快速讲解，可切换思考模式；思考通常更慢、用量更多，仍可能出错。
- 中、英、日三组字体方案，偏好按账号保存。
- 手机 PWA 阅读与 Web Push 提醒，复习复用已保存内容，不每日额外调用模型。

手机不提供新的 AI 查询；历史需要网络。首版验证设备为 Windows Chrome 和 iPhone，其他平台尚不作完整支持承诺。

## 开发与构建

需要 Node.js **24.16.0–24.x**、npm，以及浏览器测试使用的 Microsoft Edge。Windows 是当前 CI 环境。

```powershell
npm ci
npx playwright install msedge
npm test
npm run typecheck
npm run build -- --allow-unconfigured
```

全新克隆未配置云端时，最后一条命令生成不连接生产账号的检查构建，不可作为正常可用的商店包；该开关允许缺少配置，并不会忽略已经存在的本机配置。产物为 `dist/extension` 和 `dist/pwa`。本地测试使用合成接口，不调用真实 DeepSeek，也不会访问个人笔记。

有部署权限的维护者可复制 `config/cloud.public.example.json` 为被 Git 忽略的 `config/cloud.public.json`，配置项目 URL、publishable key、VAPID 公钥和 PWA URL，然后运行 `npm run build`。这些客户端公开参数不是服务端密钥；**不要填入 service-role、DeepSeek Key 或 VAPID 私钥**。已配置构建可在 Chrome 扩展管理页选择“加载已解压的扩展程序”，定位到 `dist/extension`。

本仓库发布当前 Lingo Notes 服务的实现，部署脚本对指定 Supabase 项目设有保护。更换后端项目需维护者审查配置和部署流程，不是填写任意 URL 即可的一键自部署模板。

## 架构与运维

扩展 → Supabase Auth／Edge Functions → Postgres、私有 Storage 和 Vault；生成请求由 Edge Function 调用 DeepSeek。PWA 从同一云端读取记录。一个云端 Cron 负责每日精选、推送重试和图片清理，手机推送不要求桌面电脑运行。

账号采用邀请制邮箱密码登录，无公开注册，不通过邮箱发送登录验证码。初次设置或忘记密码由管理员提供一次性设置入口。复习提醒仅使用手机推送，已移除邮件渠道。

API 契约见 [cloud/2](docs/cloud-v1-contract.md)，后端部署和加密备份／恢复边界见 [Supabase 说明](supabase/README.md)。付费模型探针、部署、邀请账号和通知命令必须由维护者明确触发，不能用于普通 CI。历史快速／思考对比脚本需要本机历史基线输入，普通克隆不具备该基线；默认测试只验证它不自动执行请求。

使用浏览器系统语音服务；优先本地语音，但可用语音可能依赖平台网络服务，不保证全部离线。

## 发布与质量边界

商店打包、权限说明及审核步骤见 [商店发布说明](docs/store-release.md)。源码公开、商店提交、审核通过及完整验收分别记录。真实 Chrome 安装流程、关闭电脑后的定时推送、iPhone 更新体验、真实备份恢复和连续七天试用的缺口见验收状态，不用模拟测试代替。

AI 讲解可能有误，尤其是日语活用、读音和敬语；学习时请结合可靠资料核对。不要上传不希望交给云端服务处理的网页内容或截图。

## 许可

项目代码使用 [MIT](LICENSE)。字体、发音图片和依赖适用各自条款，见 [第三方素材说明](THIRD_PARTY_NOTICES.md)。仓库不包含个人学习数据、账号凭据、旧产品代码或历史提交。
