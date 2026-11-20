import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {adminClient} from './cloud-admin.mjs';
import {PROJECT_REF} from './cloud-config.mjs';

const PWA='https://lingo-notes.pages.dev';
const APP_TABLES=['lingo_records','lingo_requests','lingo_settings','lingo_cards','lingo_review_batches','lingo_review_items','lingo_deliveries','lingo_push_subscriptions'];
const assert=(condition,code)=>{if(!condition)throw Error(code);};
const safeCode=error=>/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'AUTH_SMOKE_OPERATION_FAILED';
const checked=(response,code)=>{if(response.error)throw Object.assign(Error(code),{status:response.error.status});return response.data;};

// Real hosted-browser acceptance, opt-in only. No owner discovery, paid model
// calls, email delivery, screenshots, trace files or persisted credentials.
export async function runAuthSmoke({run=false}={}){
  assert(run,'RUN_FLAG_REQUIRED');
  const report={passed:false,mode:'deployed-password-flow-qa-only',checks:[],http:[],blocked_requests:0,browser_errors:0,cleanup:{passed:false,users_created:0,users_deleted:0,remaining_app_rows:null}};
  let admin,browser,page,createdId=null,stage='initialize',password='',tokenHash='';
  const email=`lingo-auth-${randomUUID()}@example.invalid`;
  async function check(name,work){
    stage=name;
    try{await work();report.checks.push({name,passed:true});}
    catch(error){report.checks.push({name,step:stage,passed:false,error:safeCode(error),...(Number.isInteger(error?.status)?{http_status:error.status}:{})});throw error;}
  }
  try{
    admin=await adminClient();
    await check('create_isolated_confirmed_qa_without_email',async()=>{
      const created=checked(await admin.auth.admin.createUser({email,email_confirm:true,app_metadata:{qa_only:true,lingo_auth_smoke:true}}),'QA_USER_CREATE_FAILED');
      assert(created.user?.id&&created.user.email===email,'QA_USER_IDENTITY_MISMATCH');
      createdId=created.user.id;report.cleanup.users_created++;
      const link=checked(await admin.auth.admin.generateLink({type:'recovery',email}),'QA_SETUP_LINK_FAILED');
      assert(link.user?.id===createdId&&link.properties?.hashed_token,'QA_SETUP_LINK_IDENTITY_MISMATCH');
      tokenHash=link.properties.hashed_token;
    });
    stage='launch_isolated_browser';browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844}});page=await context.newPage();
    page.setDefaultTimeout(25000);page.setDefaultNavigationTimeout(30000);
    page.on('pageerror',()=>{report.browser_errors++;});
    const expectedHost=`${PROJECT_REF}.supabase.co`;
    const allowedAuth=new Set(['/auth/v1/verify','/auth/v1/user','/auth/v1/token','/auth/v1/logout']);
    const allowedActions=new Set(['review.today','settings.get','key.status']);
    await page.route(`https://${expectedHost}/**`,async route=>{
      const request=route.request(),url=new URL(request.url());
      if(request.method()==='OPTIONS'){await route.continue();return;}
      let allowed=allowedAuth.has(url.pathname);
      if(url.pathname==='/functions/v1/app-api'){
        let action='';try{action=request.postDataJSON()?.action;}catch{}
        allowed=allowedActions.has(action);
      }
      if(!allowed){report.blocked_requests++;await route.abort('blockedbyclient');return;}
      await route.continue();
    });
    const safeAction=request=>{try{const action=request.postDataJSON()?.action;return allowedActions.has(action)?action:null;}catch{return null;}};
    page.on('response',response=>{
      const url=new URL(response.url());
      if(url.hostname===expectedHost&&(allowedAuth.has(url.pathname)||url.pathname==='/functions/v1/app-api'))report.http.push({path:url.pathname,action:safeAction(response.request()),status:response.status()});
    });
    page.on('requestfailed',request=>{
      const url=new URL(request.url());
      const failure=request.failure()?.errorText;
      if(url.hostname===expectedHost)report.http.push({path:allowedAuth.has(url.pathname)?url.pathname:'/functions/v1/app-api',action:safeAction(request),status:null,network_failed:true,...(/^net::ERR_[A-Z_]+$/.test(failure??'')?{network_code:failure}:{})});
      else if(url.origin===PWA)report.http.push({path:'pwa-asset',status:null,network_failed:true});
    });
    await check('recovery_link_consumed_and_setup_form_visible',async()=>{
      const target=new URL(PWA);target.hash=new URLSearchParams({token_hash:tokenHash,token_type:'recovery'}).toString();
      const response=await page.goto(target.href,{waitUntil:'domcontentloaded'});
      assert(response?.ok(),'PWA_LOAD_FAILED');
      await page.getByRole('heading',{name:'设置登录密码',exact:true}).waitFor();
      assert(new URL(page.url()).hash===''&&!new URL(page.url()).search.includes('token'),'SETUP_TOKEN_NOT_REMOVED_FROM_URL');
      const clean=await page.evaluate(hash=>!JSON.stringify({...localStorage,...sessionStorage}).includes(hash),tokenHash);
      assert(clean,'SETUP_TOKEN_PERSISTED');tokenHash='';
    });
    password='Ln!'+randomBytes(24).toString('base64url');
    await check('set_password_twice_and_open_daily_cards',async()=>{
      await page.getByLabel('新密码',{exact:true}).fill(password);await page.getByLabel('再次输入新密码',{exact:true}).fill(password);
      await page.getByRole('button',{name:'保存密码并继续',exact:true}).click();
      await page.getByRole('heading',{name:'今日复习',exact:true}).waitFor();
      await page.getByRole('heading',{name:'今天还没有复习卡片',exact:true}).waitFor();
      const state=await page.evaluate(({password,project})=>{
        const session=JSON.parse(localStorage.getItem(`lingo-session:https://${project}.supabase.co`)??'null');
        return {userId:session?.user?.id,passwordStored:JSON.stringify({...localStorage,...sessionStorage}).includes(password)};
      },{password,project:PROJECT_REF});
      assert(state.userId===createdId&&!state.passwordStored,'SETUP_SESSION_IDENTITY_OR_PRIVACY_FAILED');
    });
    await check('logout_clears_session',async()=>{
      stage='initial_settings_read';await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByText('尚未配置 Key',{exact:true}).waitFor();
      stage='logout_click';await page.getByRole('button',{name:'退出登录',exact:true}).click();
      await page.getByRole('heading',{name:'登录 Lingo Notes',exact:true}).waitFor();
      const noSession=await page.evaluate(project=>localStorage.getItem(`lingo-session:https://${project}.supabase.co`)===null,PROJECT_REF);
      assert(noSession,'LOGOUT_SESSION_NOT_REMOVED');
    });
    await check('password_login_and_missing_key_state',async()=>{
      stage='password_login_submit';
      await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);
      // Logout preserves the requested route. Signing back in from Settings must
      // return to Settings, rather than forcing the user to the daily card tab.
      await page.getByRole('button',{name:'登录',exact:true}).click();stage='password_login_settings';await page.getByRole('heading',{name:'设置',exact:true}).waitFor();
      stage='password_login_key_read';await page.getByText('尚未配置 Key',{exact:true}).waitFor();
      assert(await page.locator('.account-email').textContent()===email,'PASSWORD_LOGIN_IDENTITY_MISMATCH');
      const noPassword=await page.evaluate(value=>!JSON.stringify({...localStorage,...sessionStorage}).includes(value),password);
      assert(noPassword,'PASSWORD_PERSISTED');
      assert(report.blocked_requests===0,'UNEXPECTED_API_ACTION_ATTEMPTED');
      assert(report.browser_errors===0,'PWA_BROWSER_ERROR');
    });
  }catch(error){
    report.error={stage,code:safeCode(error)};
    if(page)try{report.ui_state=await page.evaluate(()=>{
      const text=document.body.innerText;
      return {setup_form:!!document.querySelector('#new-password'),login_form:!!document.querySelector('#password'),settings_heading:[...document.querySelectorAll('h1')].some(h=>h.textContent==='设置'),key_unconfigured:text.includes('尚未配置 Key'),loading_settings:text.includes('正在读取设置'),network_notice:text.includes('网络')||text.includes('连接失败'),alert_present:!!document.querySelector('[role=alert]')};
    });}catch{}
  }finally{
    password='';tokenHash='';
    if(browser)try{await browser.close();}catch{report.browser_close_failed=true;}
    if(createdId&&admin){
      try{
        checked(await admin.auth.admin.deleteUser(createdId),'QA_USER_CLEANUP_FAILED');report.cleanup.users_deleted++;
        const remaining=await admin.auth.admin.getUserById(createdId);
        assert(!remaining.data?.user&&remaining.error?.status===404,'QA_AUTH_CLEANUP_READBACK_FAILED');
        let rows=0;
        for(const table of APP_TABLES){const check=await admin.from(table).select('user_id',{count:'exact',head:true}).eq('user_id',createdId);checked(check,'QA_DATA_CLEANUP_READBACK_FAILED');rows+=check.count??0;}
        report.cleanup.remaining_app_rows=rows;assert(rows===0,'QA_APP_ROWS_REMAIN');report.cleanup.passed=true;
      }catch(error){report.cleanup.error=safeCode(error);}
    }else report.cleanup.passed=report.cleanup.users_created===0;
  }
  report.passed=!report.error&&report.checks.length===5&&report.checks.every(check=>check.passed)&&report.cleanup.passed;
  report.checks_passed=report.checks.filter(check=>check.passed).length;report.checks_total=5;
  return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(!args.length||args.length===1&&args[0]==='--help')console.log(JSON.stringify({mode:'not-run',usage:'node scripts/cloud-auth-smoke.mjs --run',creates_temporary_qa:true,sends_email:false,model_calls:0}));
  else if(args.length===1&&args[0]==='--run'){
    try{const report=await runAuthSmoke({run:true});console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;}
    catch(error){console.error(JSON.stringify({passed:false,error:safeCode(error)}));process.exitCode=1;}
  }else{console.error(JSON.stringify({passed:false,error:'UNKNOWN_ARGUMENT'}));process.exitCode=1;}
}
