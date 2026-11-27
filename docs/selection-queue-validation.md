# 划词直接查询与会话队列验证

2026-11-23 行为更新：本文以下是 11 月 22 日的历史验收。新的划词会在发起窗口立即显示对应任务，并暂存未提交编辑；用户之后主动切页时，完成结果仍不抢回页面。历史自动同步与闲置恢复的本次证据见 [侧栏修复验证](selection-repair-validation.md)。

2026-11-22。用户确认右键直接讲解、连续划词FIFO自动处理，未登录/缺Key设置后手动讲解。公共接口保持cloud/5，仅修改扩展、相关测试与文档。

## 已实现行为

- 右键一次即查询，无材料确认步骤；手动输入与截图确认维持既有行为。
- Chrome会话队列按账号隔离，后台单一协调，跨侧栏一次领取；上下文异步返回不改变点击顺序。
- 队列材料不受编辑框、新建或切页影响，结果不覆盖草稿、不抢历史或设置。
- 模型请求先保存身份；重复事件、worker休眠与侧栏重开不能自动重发。未知只读核对，明确终态继续；退出清旧等待内容。
- 通过合成测试、类型检查和构建后按哈希整合并更新原扩展加载目录，ID不变。

## 实际验证

- 最终`npm test`：182/182通过，0失败、0跳过，224.0秒。包含原有笔记、OCR确认、修订、历史、字体、复习、账号与备份回归。
- 新队列core测试11/11通过，覆盖FIFO、跨窗口许可、先持久化后许可、存储失败、worker重启、图片不重复持久化与账号隔离；已有surface纯回归3/3通过。
- 最终全套包含15项真实Edge侧栏与真实background VM联调场景，使用合成Chrome平台/云端接口和受控SSE：冷/热右键、双消息去重、上下文乱序、共享许可、手动设置续查、初始化失败恢复、未知核对/跳过、重开、旧请求GET/取消回执、账号切换及非法/超长文本。
- 原功能与新流程第二轮47/47通过；36个队列状态条布局检查通过，覆盖中英日、四字体与320/390/480px。6张中英日refined 320/390px合成截图静态核验，无横向溢出或控件裁切。旧144布局亦在完整回归中通过。
- `npm run typecheck`、`npm run build -- --allow-unconfigured`和`git diff --check`通过。隔离目录构建明确为configured=false，不作为连接生产的交付包。

## 修复证据与边界

- 取消旧请求回执的竞态先在旧码0/1红灯复现，修复后1/1通过：仅相同request_id的回执能推进当前许可，不匹配维持未知并只读核对；重讲前旧GET终态同样不能提前解锁。
- 两次队列用例失败来自匹配GET已自动恢复后，测试仍强制点击已隐藏的旧按钮。改为断言匹配request_id的终态GET先于下一POST，保留原请求仅一次和FIFO断言，未修改生产轮询。
- 首轮完整回归181项中180通过，唯一失败为互操作after hook的10秒清理超时。先断开合成后台、停止HTTP接收并关闭连接，再关浏览器；本体30秒和清理10秒上限不变，定向3/3及最终182项通过。不将该超时称作生产故障。
- 全部验证使用合成数据，真实模型调用0次，个人笔记读取/修改0次，用户通知0次。实施与验证期间没有网页/后端部署或商店上传；模拟浏览器验证不等同用户实际Chrome安装验收。功能完成后，用户另行授权将本次源码提交并推送GitHub，构建、缓存及本机配置不进入提交。

## 构建整合与交付

- 以发布HEAD `6e56abef7a0e59f9e4b9903ef39c0274a14fa5d5`和1307源码文件哈希为基线，在codex/lingo-selection-queue实施；整合前复查全部基线源文件、发布HEAD及原`.cache/cloud-v1-baseline.json`，没有并发冲突。仅整合扩展、相关测试和文档，未改PWA/后端源码。
- 发布目录再次`npm run typecheck`与`npm run build`通过，configured=true、development、版本1.0.0，扩展ID保持`gpjdnplnbcghjhajllhpngenbplncgdi`。
- 运行文件白名单、权限、字体及敏感内容检查通过：1186个扩展文件、1155个字体、12份字体许可；新队列已进入后台及侧栏bundle。与原构建逐文件SHA256比较，仅background.js、panel.js、panel.html、panel.css变化，PWA的1182个文件全部字节一致。
- 经源/暂存SHA256与原目标并发检查，将2369个构建文件更新回`D:\AI-Language-Learning\dist\extension`所在的原dist目录，ID不变。旧根构建备份在`.cache/selection-queue-20261122/previous-root-dist`，发布目录旧构建备份在`.worktrees/github-publish/.cache/selection-queue-previous-dist`。没有自动重新加载用户扩展；在Chrome扩展管理页点击重新加载后使用。
- 隔离依赖安装首次受限沙箱npm报`Exit handler never called`，随后从宿主离线缓存`npm ci --ignore-scripts --offline --no-audit --no-fund`成功安装140包；没有修改锁文件，也不声称执行了网络漏洞审计。

实施基线及集成报告保存在根目录`.cache/selection-queue-20261122/`，包括baseline、integrated、build-validation和artifact-mirror；隔离目录`.cache/selection-full-tests-final.log`保存最终全套结果，`selection-cancel-red.log`/`selection-cancel-green.log`保存取消竞态红绿证据，`selection-e2e-r2.log`及`selection-ui/`保存联调和合成截图。缓存及截图不进入Git。
