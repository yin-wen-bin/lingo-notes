# Lingo Notes cloud/2

2026-11-20。新数据、新账号归属；无 Native Messaging、SQLite、Pages 或 WorkBuddy 运行依赖。cloud/2 新增账号字体方案并移除邮件提醒，ping 的 protocol 为 cloud/2，protocol_version 为 lingo-cloud/2；其他学习请求结构保持不变。

项目 `brbymnycnxtfchffanvs`，URL `https://brbymnycnxtfchffanvs.supabase.co`。业务 POST `/functions/v1/app-api`，body `{action,params,request_id}`，用户 access token 放 Authorization，项目 publishable key 放 apikey。JSON `{ok:true,result}` 或 `{ok:false,error}`，错误不返回上游正文或密钥。

学习请求直接 SSE：accepted/progress/complete/error；事件包含 request_id、record_id、revision，progress 含 sequence/preview，accepted/complete 含 record。只有真实持久化完成才 accepted；同一请求重复只查询、不重复计费。总期限120秒，断流后GET状态，不自动重发。

动作：learning.submit/recognize/confirm/retry/recognizeRetry/cancel；records.get/history/delete；images.url；key.status/save/delete；settings.get/update；review.today/get/opened；push.subscribe/unsubscribe/test；telemetry.record；ping。

记录：record_id、revision、local_date、status、input_type、original_text、recognized_text、corrected_text、context、source、result、image。result 为 language/summary_zh/vocabulary/grammar；词汇 term/reading/pos/meaning/examples，语法 point/explanation/examples；例句 text/translation。每次1–3点，每点3例。

history 返回 `{items,has_more}`，列表项带 text 摘要。images.url 返回 `{url}`。key.status 返回 `{configured,last_four}`，key.save 参数 `{key}`。review 返回 `{batch:null|{id,local_date,cards,opened_at}}`；卡片 id/record_id/term/reading/language/meaning/example:{text,translation}/local_date。push.subscribe 参数 `{subscription}`。

settings.get 返回 review_enabled/push_enabled/explanation_mode/font_theme，并附手机通知所需的 vapid_public_key/pwa_url。settings.update 仅更新传入字段并回读；字体枚举为 handwritten（手写感）、bookish（书卷感）、clean（清爽自然，默认），无效值返回 INVALID_SETTINGS。字体按账号保存，两端打开或回到前台时重新读取；选择立即预览，保存失败回退已确认的方案。标题、正文、按钮使用同一方案，音标保留专用回退字体。

复习提醒只通过手机推送。设置接口不再接受或返回邮件提醒字段，服务端不发送邮件、不创建或领取邮件投递。数据库旧邮件列和已投递审计保留，邮件开关强制关闭，待处理邮件投递转为 disabled。账号邮箱和密码登录保留。恢复旧版云端备份时补齐默认字体，且所有提醒仍按原恢复契约关闭。

共享客户端 createCloudClient({url,publishableKey,storage?})：sendOtp(email)、verifyOtp(email,token)、signOut()、getSession()、call(action,params?,requestId?)、start(action,params,requestId,onEvent)。扩展构建常量 __SUPABASE_URL__/__SUPABASE_PUBLISHABLE_KEY__；PWA VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY/VITE_VAPID_PUBLIC_KEY。

身份从服务端验证后的 JWT 取得；所有资源核对 user_id，客户端不直接写生成结果。Key 仅按本人账号存 Vault，无全局模型 Key。应用渲染固定组件，不执行模型 HTML。
