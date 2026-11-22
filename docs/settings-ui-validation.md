# 扩展新建入口与设置页验证

2026-11-22。本轮范围为 Chrome 扩展的新建入口、学习笔记操作栏、历史搜索字号及设置布局。公共接口仍为 cloud/4，不改 PWA、后端、数据库或模型请求契约。

## 用户要求与实现

| 要求 | 本轮实现 |
| --- | --- |
| 顶部“随手记”应具有实际用途 | 顶部入口执行新建操作，清理当前材料、上下文与图片预览，进入新的讲解输入；历史查询、分页和返回位置继续按原规则保留。 |
| “随手记”替换为“新建” | 中、日、英分别为“新建”“新規”“New”；界面文案随用户语言选择切换。 |
| “修订或重试”与“学习笔记”同一行、靠右 | 操作放入标题右侧；取消仍按记录状态显示，重新识别保留独立入口。窄屏长标题和按钮文字允许内部换行，不让操作另起一行或横向溢出。 |
| 移除冗余“新建笔记” | 删除内容区顶部和底部的两个重复按钮，保留历史详情的“返回历史”；空工具栏不占位。 |
| 历史搜索文案缩小一号 | 搜索输入与占位文案 15px，查询按钮 14px；输入框与按钮继续同高 44px。 |
| 按选定草图优化设置 | 顺序为讲解模式、字体外观、账号与连接，使用细分隔线；主文字、标题、输入和预览 16px，按钮 15px，说明、状态及链接 14px。控件保持至少 44px。 |

设置保留全部现有能力：快速／思考模式、四种字体及中英日三行预览、邮箱密码登录、Key 保存和移除、连接检查、退出及隐私／支持入口。模式说明和字体详情使用展开说明；模式保存反馈独立于模式短说明。已配置的 Key 默认折叠，可展开更新；未配置时显示配置输入。Key 加密及 DeepSeek 计费说明、退出清草稿说明始终可见。连接或保存结果未知时明确显示未知，不以界面切换代替确认成功。

## 定向验证

机器可读回执：`.cache/settings-ui/targeted-validation.json`。测试使用独立 Edge 配置和合成接口；生产请求和模型请求均拦截，真实生产／模型调用为 **0**，未读取个人学习内容或真实 Key。

- 首次执行：`node --test --test-concurrency=1 test/panel-cloud-settings.test.mjs test/panel-cloud-navigation.test.mjs test/panel-cloud-auth.test.mjs test/panel-cloud-language.test.mjs`。保留认证 1/1、语言 5/5 通过结果；导航夹具问题修正后进行定向重跑。
- 设置及导航重跑：设置 `LINGO_SETTINGS_SCREENSHOTS=1` 后执行 `node --test --test-concurrency=1 test/panel-cloud-settings.test.mjs test/panel-cloud-navigation.test.mjs`，15/15 通过、0 失败，45.203 秒。
- 最终覆盖共 **21/21 通过**。该数字由认证、语言及重跑后的设置／导航结果合并，不表示首轮全通过，也不表示项目完整回归通过。

行为覆盖新建清理、重复入口移除、历史查询／分页／滚动与重开恢复、迟到后台结果不抢页面或恢复已删除 ID、Key 折叠／保存失败／验证后保存／移除确认、模式失败恢复显示，以及旧账号诊断／修改结果隔离。

布局覆盖中文、日语、英语 × 四种字体 × 320／390 CSS px，共 24 个组合；检查无横向溢出、标题与修订操作同行、搜索字号和 44px 同高、窄屏账号按钮等高。测试覆盖的布局组合数与保存的代表截图数量分别记录。

## 视觉核对与截图

源草图：`C:/Users/wenbi/.codex/generated_images/01a1d321-cf63-7193-805e-888ad761b1f3/exec-96ec39ad-b8e1-4f56-ab65-11870cbd7986.png`。

主实施代理已在同一次视觉输入中对比源草图与 390px 设置实图：模式／字体／账号三段顺序、轻量分隔线、16／15／14px 字号和 Key 折叠符合选定方向。草图显示比例与浏览器 viewport 不同，且顶部“随手记”按本轮要求改为“新建”，不宣称像素级一致。

英文 320px 时，账号按钮因换行曾出现高度不同；为按钮组设置 `align-items: stretch` 后，等高断言通过。标题旁修订按钮仍同行，没有重复 New 入口。

`.cache/settings-ui/screenshots/` 保存以下 **7 张合成截图**，不纳入 Git：

1. `settings-configured-zh-refined-390.png`：已登录、Key 已配置并折叠。
2. `settings-unconfigured-zh-refined-390.png`：Key 未配置。
3. `settings-signed-out-zh-refined-390.png`：未登录表单。
4. `settings-key-expanded-zh-refined-390.png`：展开 Key 编辑。
5. `settings-en-refined-320.png`：英文窄屏。
6. `settings-ja-refined-320.png`：日文窄屏。
7. `result-title-action-zh-refined-390.png`：学习笔记标题与右侧修订操作。

标准截图 viewport 为 390×844 CSS px、非全页截图；英文／日文窄屏图宽为 320px。详细视觉审查及前次列表设计结论见根目录 `design-qa.md`。

## 完整检查与交付状态

- `npm test`：138/138 通过，0 失败、取消或跳过（437.133 秒）。旧 `pwa-interop` 夹具在断言完成后先等待 HTTP 服务关闭、后关闭浏览器，导致清理停顿；核验归属后仅关闭该轮隔离 Edge，原全量正常退出 0。未关闭用户浏览器。
- 清理夹具改为先关闭浏览器，再关闭连接和 HTTP 服务，收尾限制 10 秒。`node --test test/pwa-interop.test.mjs` 定向复测 3/3 通过（5.145 秒）；产品代码和业务断言未因清理问题改变。
- `npm run typecheck`、`npm run build -- --allow-unconfigured`、`git diff --check` 通过。隔离构建 `configured=false`，没有复制生产配置或凭据。
- 源码基线及原始 cloud-v1 基线哈希核对通过，14 个本轮文件整合到 `.worktrees/github-publish`；既有未提交修改保留。
- 发布目录 `npm run build` 通过，`configured=true`、development profile、扩展 ID 仍为 `gpjdnplnbcghjhajllhpngenbplncgdi`。包检查包含 1,155 个字体文件及 12 份字体许可。
- 核对 2,367 个运行文件后，已更新用户当前加载的 `D:/AI-Language-Learning/dist/extension`；只有 `panel.html`、`panel.css`、`panel.js` 变化，旧版本已备份。PWA 产物逐字节一致。
- 整合与运行文件回执分别在主目录 `.cache/settings-ui-20261121/integrated.json` 和 `runtime-validation.json`；构建日志为 `build-configured.log`。用户需在 Chrome 扩展管理页重新加载扩展，再关闭并重开侧栏以使用新版。

本轮合成浏览器验证不等同用户真实 Chrome 扩展重载、商店安装、iPhone 或七天试用。本轮不推送 GitHub、上传商店或部署云端。
