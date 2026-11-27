# 部署自己的 Lingo Notes

Windows 和 Node.js 24.16–24.x。准备一个专用空 Supabase 项目，记录项目 **Reference ID**。在 Cloudflare 账号中选一个可用的 Pages 项目名。自部署会为这个实例创建 Direct Upload 项目并绑定生成的 HTTPS 地址。

在项目根目录执行以下命令。首次登录按 CLI 的提示完成平台授权。

```powershell
npm ci
npm run cloud:login
npx wrangler login
npm run deploy:self-host -- --supabase-ref <项目ID> --pages-project <项目名> --owner-email <邮箱>
```

有多个 Cloudflare 账号时追加 `--cloudflare-account <ID>`。想先核对目标时，在部署命令后追加 `--dry-run`。正式执行会创建或核对 Pages 项目，应用数据库迁移，部署 API 和定时函数，配置邀请登录、私有截图和复习调度，最后发布学习中心与自用扩展。

## 第一次使用

1. 从部署输出复制学习中心地址。使用当次终端显示的设密入口设置自己的密码。
2. 解压生成的自用扩展 ZIP。到 `edge://extensions` 或 `chrome://extensions` 启用开发者模式，选择“加载已解压的扩展程序”，打开含有 `manifest.json` 的目录。继续更新时，将新构建解压到同一加载目录并重新加载。
3. 用刚设置的邮箱和密码登录，进入扩展「设置」保存你自己的 DeepSeek Key。API 用量由 DeepSeek 按你的账户计费。
4. 要接收复习时，从 iPhone 主屏幕打开自建学习中心，在「设置」开启每日复习和手机通知，确认本机已连接并收到测试通知。每日批次从北京时间 07:00 起处理到期内容。

官方 Edge 安装链接提供连接官方服务的扩展。自建实例的扩展随本次部署生成，使用自己的云端账号和数据。

## 中断与恢复

- 用相同参数重跑，保留本机部署状态。重跑会核对目标与已完成阶段，复用数据库迁移、账号、扩展身份、推送密钥及调度。日志会指明需要处理的失败阶段。
- 初次设密链接过期时，可在交互终端使用相同参数追加 `--setup-link`。链接在有效期内只能使用一次，请私下打开。
- 本机部署状态属于实例运维资料。Windows 加密的凭据应随系统账号妥善保留。应用的日常学习、定时任务和推送由云端运行。
