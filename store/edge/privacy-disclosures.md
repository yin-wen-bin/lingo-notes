# Edge 权限与数据披露

Lingo Notes 把用户主动选择、输入或确认上传的英语和日语材料转为学习笔记，提供讲解、发音、历史回看与复习。

| 权限 | 用途 |
| --- | --- |
| `contextMenus` | 提供划词学习入口。点击该入口即请求讲解，连续选择按顺序处理。 |
| `sidePanel` | 在原网页旁展示输入、图片预览、讲解、笔记与复习设置。 |
| `activeTab` | 用户发起操作后，临时访问当前网页的材料、附近上下文和来源，以便学习或截图。 |
| `scripting` | 注入包内脚本，读取附近可见文本并实现框选。脚本、字体和图标随包提供。 |
| `storage` | 按账号保存会话、草稿、队列和请求恢复状态。密码和 DeepSeek Key 不保存在扩展存储。 |
| 官方 Supabase 主机 | 处理登录、私有学习记录和确认图片、加密 Key、偏好和复习状态。 |

在 Partner Center 核对账号邮箱、身份验证信息、学习材料和确认截图、网页标题及去除查询参数后的来源 URL、用户操作与技术诊断数据。文字通过划词菜单或讲解按钮提交；截图在预览确认后上传。Supabase 负责认证、数据与私有截图存储、Key 加密和后端运行，DeepSeek 处理学习材料。浏览器及系统参与发音和通知投递。

配套 PWA 在本机 IndexedDB 按账号保存最多 7 天或 5 MB 的近期已读文字、历史页和复习卡。离线可读这些内容。截图、未缓存的内容及修改仍需联网。退出、切换账号或确认登录失效时清理相应缓存。推送设置核对本机订阅，通知只提供通用提醒和需要登录的批次入口。

最终按 ZIP 中的权限和后台实际字段核对声明。[官方隐私政策](https://lingo-notes.pages.dev/privacy) · [使用与删除支持](https://lingo-notes.pages.dev/support) · [Microsoft 发布指引](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension#step-6-enter-privacy-information)
