# 商店发布材料

这些是待审阅的发布材料，不表示已经上传、审核通过或发布。商店文案见 `listing.zh-CN.md`，权限与数据披露见 `privacy-disclosures.md`，审核步骤见 `reviewer-instructions.md`，真实验收表见 `chrome-acceptance.md`。整体顺序见 `../docs/store-release.md`。

## 图片清单

| 文件 | 尺寸 | 内容与来源 |
|---|---|---|
| `assets/icon-128.png` | 128×128 PNG | 与 `extension/assets/icon-128.png` 字节一致，保持现有产品图标 |
| `assets/screenshots/01-english-notes.png` | 1280×800 PNG | 实际扩展英文讲解卡片；合成短语、中文说明、读音与三条例句 |
| `assets/screenshots/02-japanese-notes.png` | 1280×800 PNG | 实际扩展日文讲解卡片；合成假名、中文说明与三条例句 |
| `assets/screenshots/03-history.png` | 1280×800 PNG | 实际历史列表与查询/删除按钮；四条合成内容 |
| `assets/screenshots/04-image-confirmation.png` | 1280×800 PNG | 通过实际选图处理进入确认界面；合成 PNG，未点击识别、没有上传 |
| `assets/render-report.json` | JSON | 尺寸、文件 SHA256、界面溢出和网络隔离检查 |

截图右侧由当前 `extension/panel.html`、`panel.css` 及临时打包的 `panel.ts` 实际渲染；没有重画产品控件或修改产品样式。左侧为展示用的本地合成阅读页和说明，不伪造 Chrome 工具栏。所有页面均标有“合成演示内容 · 实际扩展界面 · 未连接真实服务”。截图无个人邮箱、API Key、真实网页 URL或个人笔记。

接口和 Chrome API 在隔离浏览器中模拟，只读取合成笔记；没有生产请求、模型请求或真实云端保存。它们属于**真实前端代码的合成渲染**，不属于真实扩展安装、截图权限、OCR质量或平台连通性验收。当前发音图标仍随产品渲染，其授权证据未随仓库提供，MIT不覆盖该第三方素材；发行者负责核实可分发权利。

未制作小宣传图；440×280是可选素材，不影响此处四张截图的准备范围。若后续制作，仅使用有权分发的产品图标和文案。

## 重新生成

在已安装项目依赖的仓库根目录运行：

```sh
node store/render-assets.mjs
```

脚本先尝试 Playwright Chromium，未安装时尝试本机 Edge。无外部下载；需要运行无头浏览器和本地 loopback HTTP 的权限。固定 1280×800、1倍像素、同源字体；仅写 `store/assets/`，不读取 `.env`、运行配置或学习数据库。所有非 loopback 网络均由路由拦截，演示 API由本地内存返回，其余请求失败。每次会检查：四张截图尺寸、零横向溢出、零浏览器错误、没有 `learning.*` 请求，以及图标与产品源文件一致。

生成之后还需目视检查四张图片，尤其是换行、截断、字体和产品源码变动。最终投稿使用的源码、版本和图片应一致。真实模型讲解可能不同，不能把演示文字称为模型质量验证。

## 凭据边界与提交状态

用户暂没有审核专用 Key；独立审核账号/Key 均待配置。本轮不将个人 Key 供审核，也不提交完整功能审核。审核凭据只填商店后台私有 Test instructions，绝不写入本目录、Git或公开截图。支持邮箱可公开使用 wenbinyin@gmail.com。

首次计划选择 Unlisted，再采用 deferred publishing。Unlisted不是产品账号权限，审核通过后也要发布者手动放行。

## 官方尺寸依据

2026-11-20核对：[商店信息](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)列明128×128图标、1至5张1280×800截图及可选440×280小宣传图；[图片规范](https://developer.chrome.com/docs/webstore/images)要求截图方角、全幅。此处不添加外边框留白或伪造浏览器外壳。最终素材可否通过审核仍由商店决定。
