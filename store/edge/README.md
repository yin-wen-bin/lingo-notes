# Edge Add-ons 1.0.1 更新

此版本沿用原 Lingo Notes 商店条目和 Hidden 分发。商店扩展连接官方学习中心。自部署用户使用自己的解压扩展。

## 候选包

在独立、干净的发布 checkout 中提供现有公开客户端配置，然后运行：

```powershell
npm run package:edge -- --out artifacts/edge-1.0.1
```

命令从当前提交构建官方 `store` 产物。Edge ZIP 使用英文短描述和工具栏标题，源码与原始构建的 manifest 保持原样。ZIP 省略 `manifest.key`，由 Edge 对原条目签名。命令会输出 ZIP、SHA-256 和报告；报告记录构建提交，并以 Windows .NET 读取器逐项验证 ZIP 中的文件和哈希。

在已安装 Microsoft Edge 的 Windows 运行 `node store/edge/render-assets.mjs`，将当前扩展界面的三张合成截图和图标生成到 `artifacts/edge-1.0.1-screenshots`。截图的尺寸和 SHA-256 见同目录报告。

## Partner Center

1. 打开现有 Lingo Notes 条目（Store ID `0RDCKCJ6MS51`），回读旧版审核结果、现有包版本、可见性及市场。原 CRX ID 为 `ldpeomklgacdhbnmbnoohkjfegikljem`，该 ID 应用于升级和后端来源验证。
2. 单独核对官方 app-api 是否允许该扩展来源，并验证私有审核流程可使用原有审核账号。后台身份以同一条目实际显示为准。
3. 保留已提交的旧 ZIP，将已验证的 `1.0.1` 上传至原条目。沿用原有 Hidden 分发、地区与语言设置，核对英文文案、隐私披露、合成截图及私有审核说明。
4. 提交审核后回读包版本、身份及认证状态。显示 `In the store` 后核对商店版本，并用已装旧版的 Edge 测试原位升级、登录和历史读取。

- [英文商店文案](listing.en-US.md)
- [权限与隐私披露](privacy-disclosures.md)
- [审核说明模板](reviewer-instructions.md)
- [Microsoft Edge 扩展更新流程](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/update-extension)
