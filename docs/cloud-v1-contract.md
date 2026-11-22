# Lingo Notes cloud/5

2026-11-22。cloud/5新增可配置复习数量、逐点掌握和显式完成推进的间隔复习；继承cloud/4字体、cloud/3讲解语言与纯手机推送。ping的protocol为cloud/5，protocol_version为lingo-cloud/5。无Native Messaging、SQLite、Pages或WorkBuddy运行依赖。

项目 `brbymnycnxtfchffanvs`，URL `https://brbymnycnxtfchffanvs.supabase.co`。业务 POST `/functions/v1/app-api`，body `{action,params,request_id}`，用户 access token 放 Authorization，项目 publishable key 放 apikey。JSON `{ok:true,result}` 或 `{ok:false,error}`，错误不返回上游正文或密钥。

学习请求直接 SSE：accepted/progress/complete/error；事件包含 request_id、record_id、revision，progress 含 sequence/preview，accepted/complete 含 record。只有真实持久化完成才 accepted；同一请求重复只查询、不重复计费。总期限120秒，断流后GET状态，不自动重发。

动作：learning.submit/recognize/confirm/retry/recognizeRetry/cancel；records.get/history/delete；images.url；key.status/save/delete；settings.get/update；review.today/get/opened/cards/mastery/complete；push.subscribe/unsubscribe/test；telemetry.record；ping。

记录：record_id、revision、local_date、status、input_type、original_text、recognized_text、corrected_text、context、source、result、image。result 为 language/summary_zh/vocabulary/grammar；词汇 term/reading/pos/meaning/examples，语法 point/explanation/examples；例句 text/translation。每次1–3点，每点3例。

history 返回 `{items,has_more}`，列表项带 text 摘要。images.url 返回 `{url}`。key.status 返回 `{configured,last_four}`，key.save 参数 `{key}`。review 返回 `{batch:null|{id,local_date,cards,opened_at}}`；卡片 id/record_id/term/reading/language/meaning/example:{text,translation}/local_date。push.subscribe 参数 `{subscription}`。

settings.get返回review_enabled/push_enabled/review_daily_limit/explanation_mode/font_theme/explanation_language，并附手机通知所需的vapid_public_key/pwa_url。settings.update仅更新传入字段并回读；字体枚举为handwritten（手写感）、bookish（书卷感）、clean（清爽自然）、refined（雅致清晰，默认），无效值返回INVALID_SETTINGS。默认仅用于缺少偏好或新账号，不批量修改已有账号的三种选择。字体按账号保存，两端打开或回到前台时重新读取；选择立即预览，保存失败回退已确认的方案。标题、正文、按钮使用同一方案，音标保留专用回退字体。

refined的中文使用Noto Sans SC，英文标题及按钮使用Manrope、正文使用Inter，日文使用Noto Sans JP；标题600、正文500、按钮500，真实字重随字体本地打包，不生成伪粗体。字号延续各端既有规范，其他三种方案的映射和字重不变。

讲解语言explanation_language枚举zh/ja/en，账号默认zh。learning.submit/confirm/retry显式传入所选语言，参与幂等指纹；同一请求ID改语言报IDEMPOTENCY_CONFLICT。旧调用缺省语言仍为zh，保持原有hash结构；不读取变化中的账号偏好来重新解释旧请求。OCR只识别原文，不翻译。学习请求不隐式修改账号偏好。

record.explanation_language是本次请求语言，result.explanation_language与progress.preview.explanation_language由服务端写入可信值。重试失败保留旧result及其语言。result.language继续表示原材料en/ja/mixed；summary_zh保留字段名，语义为所选语言的讲解摘要。概述、pos、meaning、语法point/explanation及example.translation用目标语言；原词、读音、例句原文用源语言。同语言的translation是简明同语释义。生成时按可信请求语言拒绝原样复制的例句释义，忽略标点、空格、全半角和大小写差异；失败返回INVALID_LESSON，不自动追加模型调用。模板版本lingo-cloud-5。

复习卡保留language表示例句源语言，新增explanation_language用于释义/译文，以及term_language用于标题字体与发音（词汇=原语言，语法标题=讲解语言）。旧结果缺讲解语言按zh，旧卡缺term_language沿用language。PWA读取现有内容，不再次调用模型翻译。账号恢复旧备份时补explanation_language=zh；不批量改写已有笔记。

扩展界面语言复用账号explanation_language：选择时本地预览，确认保存后沿用，失败恢复原账号语言。打开旧结果不修改界面偏好；UI翻译只更新应用文案，保存的原文和讲解继续使用各自语言。扩展本地右键菜单语言缓存按当前会话账号隔离，不参与学习请求、幂等或模型调用；退出/切账号时不得沿用其他账号的缓存。本次不增加公共云端动作或数据库字段。

复习提醒只通过手机推送。设置接口不再接受或返回邮件提醒字段，服务端不发送邮件、不创建或领取邮件投递。数据库旧邮件列和已投递审计保留，邮件开关强制关闭，待处理邮件投递转为 disabled。账号邮箱和密码登录保留。恢复旧版云端备份时补齐默认字体，且所有提醒仍按原恢复契约关闭。

共享客户端createCloudClient({url,publishableKey,storage?})使用邮箱密码登录、会话恢复、signOut/getSession/call/start；不发送登录验证码。扩展构建常量__SUPABASE_URL__/__SUPABASE_PUBLISHABLE_KEY__；PWA VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY/VITE_VAPID_PUBLIC_KEY。

身份从服务端验证后的 JWT 取得；所有资源核对 user_id，客户端不直接写生成结果。Key 仅按本人账号存 Vault，无全局模型 Key。应用渲染固定组件，不执行模型 HTML。

## cloud/5：可配置数量、逐点掌握与间隔复习

新增settings.review_daily_limit，整数1–100、默认5，后端拒绝字符串、小数和越界。新建批次使用该值；既有当天批次幂等保留，改设置不重建。前端不得再硬截取5张。

- `review.cards {record_id}`返回`{cards}`，按保存结果的词汇再语法slot顺序提供该记录学习点。
- `review.mastery {card_id,point_key,mastered:boolean}`返回`{card}`；标记/撤销账号内同一point的掌握。
- `review.complete {batch_id,card_id,point_key}`返回`{card,reviewed:true}`；仅已分配且到期的本轮项目能推进，重复或旧轮不重复推进。
- card增加`slot,kind,point_key,mastered,mastered_at,review_round,next_due_date,completed,last_completed_at`，kind为vocabulary/grammar，review_round为已完成轮数0–5。批次卡另带`scheduled_round,reviewed,completed_at`。`CARD_CHANGED`、`REVIEW_ITEM_NOT_FOUND`表示材料或项目已变化，前端须刷新而不是静默重试。

lingo_review_points保存账号内统一进度；cards关联point_key，review_items保存point_key和轮次快照。准确相同的类型、语言、原学习点及词义定义归为同一点；不按词面合并不同义项。首次due为学习日+1；显式完成后按实际完成北京时间日期+2/+4/+7/+16，五轮结束。旧推送/打开记录不转换成已复习证据。逾期due优先且每天同点至多一轮；不通过重新生成批次补发多轮。

已掌握的点不参与选择、当前/历史批次回读和待发送投递；原笔记保留并可撤销掌握。撤销未完成的点恢复安排；已完成五轮时重置首轮、次日开始。记录修订同一点保留进度，内容换义视作新点；旧批次不能对换义后的同槽执行操作。进度和掌握纳入备份与恢复，旧备份补首轮未完成状态，不恢复提醒或凭据。新迁移不修改已有六份部署文件。
