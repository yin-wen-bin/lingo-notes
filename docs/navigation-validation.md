# 扩展常驻导航验证

2026-11-21。按用户确认的导航方案实施，公共接口仍为cloud/4。

## 最终行为

- 顶部常驻“随手记、历史、设置”，移除标语和折叠菜单；浅色背景、下划线和aria-current表示当前入口。
- 内容顶部可新建笔记；选图紧邻截图；修订/重试及重新识别就近放置在记录区。
- 历史与设置移除重复可见标题和返回，保留无障碍标题。历史详情保留“返回历史”，导航仍高亮历史。
- 切页保留随手记草稿、图片预览、修订输入和语言；历史详情返回保留查询、已加载分页及滚动，不额外请求列表。新建笔记显式清空工作区；账号切换清空快照，登录完成仍停在设置。
- 流式更新、只读轮询、迟到截图及历史详情请求不会抢回页面。新记录/修订后主动进入历史时，从服务端原子刷新原分页窗口；查询和滚动保留，失败保留旧缓存，账号切换丢弃迟到结果。
- 四字体与三语UI保留；PWA、后端、数据库和学习请求契约无改动。

## 已执行验证

- 定向浏览器回归17/17通过，覆盖登录、三导航、草稿与图片、详情返回、异步流、轮询、迟到截图、账号切换、重开恢复以及变化后分页窗口刷新。
- 导航与会话纯状态测试14/14通过。
- 修正合成测试服务器的图标路由后，布局测试1/1通过，生成144张有效合成截图：中/日/英 × 四字体 × 320/390/480px × 随手记/历史/详情/设置。所有可见图片解码断言通过；中英日refined的六张320/390px代表截图人工静态核验，无横向溢出、控件裁切或损坏图标。
- 首轮登录回归发现登录后错误离开设置，已修复并在次轮通过；首版截图的测试服务器图标路由错误已修正，首版截图不作为图标证据。
- 最终检查发现删除已保存、尚未收到accepted消息的记录后，隐藏草稿可能复用旧记录/请求ID。新增真实ReadableStream模拟回归先在旧码精确失败，修复后导航9/9通过；草稿保留，重发使用新ID，旧accepted不能恢复已删除记录。按ID同步清理待提交身份及命中记录快照，存储等待期间的新输入也受保护。

## 完整检查与交付

- 初轮`npm test`为131/131通过；删除竞态修复后的最终`npm test`为132/132通过，0失败、0跳过，333.7秒。最终代码`npm run typecheck`、`npm run build -- --allow-unconfigured`和`git diff --check`通过；隔离目录检查构建明确为configured=false。
- 基于发布目录1294个源码文件的原始哈希快照整合，原`.cache/cloud-v1-baseline.json`及发布HEAD核对通过，没有覆盖并发修改。整合范围仅扩展、相关测试和文档，公共接口仍cloud/4。
- 发布目录再次`npm run typecheck`及`npm run build`通过，生成configured=true的开发版1.0.0，扩展ID保持`gpjdnplnbcghjhajllhpngenbplncgdi`。运行文件白名单和敏感内容扫描通过：1185个扩展文件、1155个字体、12份字体许可。
- 与整合前构建逐文件SHA256比较，扩展仅panel.html、panel.css、panel.js改变；PWA的1182个文件全部字节一致。本次未部署网页、PWA或后端，没有GitHub提交/推送或商店上传；旧商店ZIP和截图不包含此次改动。
- 2368个构建文件经源/暂存哈希及目标并发检查后，更新回原加载目录`D:\AI-Language-Learning\dist\extension`，保持原ID；旧根目录构建备份位于`.cache/navigation-20261121/previous-root-dist`，发布目录旧构建保存在`.worktrees/github-publish/.cache/navigation-previous-dist`。在Chrome扩展管理页重新加载后使用新版。

本地证据：隔离目录`.cache/navigation-full-tests-final.log`、`.cache/navigation-delete-red.log`、`.cache/navigation-delete-green.log`、`.cache/navigation-layout-screenshots-r2.log`及144张合成截图；根目录`.cache/navigation-20261121/`保存baseline、integrated、build-validation和artifact-mirror报告。缓存及截图不进入Git。

上述验证使用本机Edge与合成接口，不调用真实模型，不读取或修改个人笔记；不等同真实Chrome安装、iPhone或商店验收。未自动重载用户正在使用的扩展。
