# Chrome Web Store 发布准备

当前只准备材料，不代表已上传商店、通过审核或发布。首次采用 Unlisted，并选择审核后手动发布（deferred publishing）；不改现有邀请制和用户自带 DeepSeek Key 的计费方式。

## 发布材料

- `store/listing.zh-CN.md`：名称、简短/详细说明、单一用途、邀请制和费用、分发方式。
- `store/privacy-disclosures.md`：五项权限与 Supabase host 理由、数据清单、隐私字段建议。
- `store/reviewer-instructions.md`：独立审核账号准备和实际操作步骤。凭据仅在商店后台私下提供。
- `store/chrome-acceptance.md`：最终 ZIP、Chrome、权限/截图、恢复/删除和升级的实际验收表，未验证不标通过。
- `store/README.md`：图标、截图尺寸、生成办法与合成演示边界。

## 提交顺序

1. 核对源码及第三方资源清单。现有第三方发音图标单独授权，仓库未提供其授权证据，MIT不覆盖该图标；发行者负责核实可分发权利。
2. 从当前发布分支构建扩展，打包范围仅为扩展产物目录，保留字体许可证。记录最终版本、包 SHA256 和构建来源；不上传整个项目、PWA产物或开发缓存。
3. 在商店后台创建草稿条目，核对分配的扩展 ID 和 public key。若与开发 ID不同，先校准包内 key、后端允许来源及相关配置，再用该身份完成测试；不能仅凭旧开发扩展通过放行。
4. 完成可公开访问的隐私政策和支持入口；逐项核对权限及数据披露。填写商店文案，上传本地审阅后的图标/截图。
5. 配置独立审核账号与受控测试 Key，只在商店后台提供必要凭据。完成 `store/chrome-acceptance.md` 的真实 Chrome 验收并记录剩余限制。
6. 选择 Unlisted；送审时关闭自动发布，使用 deferred publishing。发布负责人核对审核结果和当前版本后另行手动发布。商店审核通过不替代产品验收。

## 尚需实际处理的事项

- 商店账号/条目、公钥与 ID、审核账号仍需发布负责人确认，本文没有创建这些外部状态。公开支持邮箱为 wenbinyin@gmail.com，已经用户授权。
- 公开入口已部署并匿名回读 HTTP200：[隐私政策](https://lingo-notes.pages.dev/privacy)、[支持页](https://lingo-notes.pages.dev/support)、[学习中心](https://lingo-notes.pages.dev/)。提交前再次确认政策和支持无需登录。
- 审核专用 Key 尚未配置，目前仅准备包和材料，可创建草稿核对 ID；不配置个人 Key 给审核，也不提交完整功能审核。
- 发音图标授权待用户处理；最终包真实 Chrome 验收及剩余配套产品验收见对应清单，不得将合成素材渲染视为通过。
- 源码或发音图标改变后重新生成截图，避免商店页面与最终扩展不一致。

## 构建与打包接口

在配置了公开云端参数的仓库根目录运行，打包不会自动构建：

```sh
npm run build -- --profile store
npm run package:extension
```

首次 store 构建省略 `manifest.key`，不把开发公钥当成商店分配身份。取得并核对商店公钥后，可用下面的构建方式；占位文件只装 Base64 DER SPKI 公钥，不是私钥，且不会覆盖开发公钥：

```sh
npm run build -- --profile store --extension-key <商店公钥文件>
npm run package:extension
```

输出为 `artifacts/lingo-notes-<manifest.version>-store.zip`，旁边附 `.sha256` 和 `.report.json`；报告含版本、ID、包和逐文件哈希、字体及许可数量。相同路径已有不同内容的包时，打包器拒绝覆盖；取得商店公钥后的候选包可用 `npm run package:extension -- --out artifacts/store-identity` 单独保留。已发布版本后续升级必须增加 manifest 版本。打包器拒绝 development profile。只为 CI 或未配置连接的草稿检查时，两条命令都要显式加 `--allow-unconfigured`，得到 `-store-draft.zip`；这种包不能用于完整功能审核。

商店 ID 经后台实际核对后，由发布负责人另行设置服务允许来源：`node scripts/cloud-setup.mjs cors --store-id <商店ID> --store-id-verified`。该操作保留开发 ID，本文没有执行；`--store-id-verified`只是操作者已完成核对的声明，格式检查不能代替条目身份验证。

## 官方依据

核对日期：2026-11-20。后台字段与要求可能更新，实际提交时再次核对。

- [填写商店信息与图片尺寸](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)：128×128图标、1–5张1280×800截图；440×280宣传图可选。
- [图片与图标规范](https://developer.chrome.com/docs/webstore/images)：截图方角、全幅；PNG图标及图形留白说明。
- [权限和隐私披露](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)：单一用途、权限理由、远程代码、数据用途及隐私政策。
- [审核测试说明](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions)：后台提供受限访问项目的测试步骤与凭据。
- [分发可见性](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)：Unlisted凭链接可安装，仍需相同审核。
- [提交与延后发布](https://developer.chrome.com/docs/webstore/publish)：审核通过后手动发布及暂存有效期。
