# Lingo Notes PWA

React、TypeScript、Vite 实现的手机学习中心。只提供回看、每日精选、历史删除和设置；手机不发起 AI 查询。用户 API Key 通过已登录后端保存在 Vault，不写入浏览器存储。

## 配置与运行

根工程安装 `react`、`react-dom`，开发依赖 `vite`、`@types/react`、`@types/react-dom`、`typescript`。使用：

```powershell
npx vite --config pwa/vite.config.ts
npx tsc --project pwa/tsconfig.json --noEmit
npx vite build --config pwa/vite.config.ts
npx vite preview --config pwa/vite.config.ts
```

部署目录 `pwa/dist`。环境变量放在未提交的 `pwa/.env.local` 或构建环境：

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
VITE_VAPID_PUBLIC_KEY=YOUR_VAPID_PUBLIC_KEY
```

三项都是客户端公开配置，不得把服务角色密钥、VAPID 私钥、DeepSeek Key 放入 `VITE_*`。仅 HTTPS 项目受共享客户端支持。站点部署在域名根目录。托管层另加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 和禁止 iframe 嵌入的响应头。

需要 `public/icons/icon-192.png`、`icon-512.png` 和 `apple-touch-icon.png`；品牌 SVG 已提供，PNG 由主工程准备。

## 接口与运行边界

- 复用 `shared/cloud-client.ts`，使用已有受邀账号的邮箱＋密码登录，不提供公开注册，不发送验证码或密码重置邮件；登录不依赖 SMTP。
- 初次开通或忘记密码时，由管理员提供一次性 `/#token_hash=...&token_type=recovery` 链接。页面读取立即清除 fragment，先经服务端 recovery 验证，再让用户亲自输入两遍至少 10 个字符的密码。刷新页面仍进入未完成的设置流程；设置成功才进入学习页面。
- 浏览器只保存会话和不含凭据的设置流程标志，密码、一次性 token_hash 不写入存储、日志或缓存。设密码期间不发学习 API；退出或切换账号会使旧认证响应失效。
- `/?batch=<id>` 打开通知批次，`/?record=<id>` 打开完整记录；未登录保留地址，登录后继续打开。
- 今日显示最多五卡，完整记录展示 `record.result` 的全部词汇、语法和例句；截图通过 `images.url({record_id})` 获取短期签名 URL。
- 每次放大截图前获取新签名，避免复用已过期的缩略图链接；图片加载失败可重试。离开记录或切换账号会使在途图片请求失效。
- 删除使用记录修订和 `confirmed:true`；成功后重新加载列表和卡片，不将失败显示为成功。
- 通知权限只由“开启通知”按钮申请。服务端负责一个主要订阅的替换、通知幂等及失效订阅处理。测试按钮只报告“请求已提交”，不能据此证明设备收到通知。
- 退出登录会清除当前设备订阅，并通过 endpoint 尝试移除对应后台订阅，不关闭别的主要设备；后台移除失败不阻止退出，失效 endpoint 由发送端后续清理。
- Service Worker 只缓存构建生成的公开应用文件，不缓存 API 响应、登录响应、学习正文和私有截图。离线只能打开外壳，正文需要网络。消息通知使用固定文案，不带学习正文；点击只允许同源批次链接。
- `review.opened` 仅表示批次页面已打开，不代表读完或掌握。
- AI 服务显示“快速／思考”讲解模式；只在用户选择时保存并回读，不在载入时写入默认值。思考通常更慢、用量更多，不保证更准确。此设置不在手机发起查询。
- 测试通知按钮始终可见，未开启通知时禁用并提示先开启；加载页面或更改讲解模式不申请通知权限、不自动发送测试。
- 首版不后台自动申请通知权限，不定时调用 AI，不提供注册入口或手机学习输入。

## 验证边界

本地测试可以验证 URL 安全、五卡上限、服务工作线程缓存范围、通知链接和播放状态；不替代真实登录、DeepSeek Key 托管、Supabase 权限、推送服务器和 iPhone 关机电脑后实际推送验收。

`node --test test/pwa.test.mjs` 验证 URL、缓存和通知行为。`node --test test/pwa-ui.test.mjs` 用独立无头 Edge 和临时构建目录运行密码登录、一次性初始化/失败/刷新、自设密码、深链、18px 例句/译文、发音停止、搜索删除、通知点击和跨标签页退出流程，全部 API 为合成拦截；需要系统允许启动子浏览器，Windows AppContainer 沙箱可能阻止该进程。iPhone 安装引导在模拟环境检查，仍需真机验收。
