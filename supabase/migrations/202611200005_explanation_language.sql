-- Explain in Chinese, Japanese or English; original learning language is separate.
alter table public.lingo_settings add column explanation_language text not null default 'zh'
  constraint lingo_settings_explanation_language_check check (explanation_language in ('zh','ja','en'));

create or replace function public.lingo_begin(p_user uuid,p_id uuid,p_record uuid,p_action text,p_hash text,p_material jsonb,p_revision integer default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare request public.lingo_requests; rec public.lingo_records; initial boolean; body jsonb; rev integer; selected_mode text; selected_language text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
  perform public.lingo_expire(p_user);
  select * into request from public.lingo_requests where user_id=p_user and id=p_id;
  if found then
    if request.record_id<>p_record or request.action<>p_action or request.input_hash<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    select * into rec from public.lingo_records where user_id=p_user and id=p_record;
    if rec.deleted_at is not null then raise exception 'RECORD_DELETED'; end if;
    return jsonb_build_object('replay',true,'record',rec.payload,'deadline',request.deadline);
  end if;
  if exists(select 1 from public.lingo_requests where user_id=p_user and status='processing') then raise exception 'REQUEST_IN_PROGRESS'; end if;
  initial := p_action in ('learning.submit','learning.recognize');
  select * into rec from public.lingo_records where id=p_record and user_id=p_user for update;
  if initial then
    if found or exists(select 1 from public.lingo_records where id=p_record) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    rev:=1;
    body:=jsonb_build_object('record_id',p_record,'revision',rev,'created_at',now(),'local_date',(now() at time zone 'Asia/Shanghai')::date,'input_type',case when p_action='learning.recognize' then 'image' else 'text' end,'original_text','','context','','recognized_text',null,'corrected_text',null,'result',null,'image',null,'source',null)||p_material;
  else
    if rec.id is null or rec.deleted_at is not null then raise exception 'RECORD_NOT_FOUND'; end if;
    if p_revision is null or (rec.payload->>'revision')::int<>p_revision then raise exception 'REVISION_CONFLICT'; end if;
    if p_action='learning.confirm' and rec.payload->>'status'<>'awaiting_review' then raise exception 'INVALID_RECORD_STATE'; end if;
    if p_action='learning.recognizeRetry' and rec.image_path is null then raise exception 'IMAGE_NOT_SAVED'; end if;
    rev:=(rec.payload->>'revision')::int+1;
    body:=rec.payload||p_material;
  end if;
  -- Read the preference after the replay gate, inside the save transaction. It
  -- is deliberately absent from the client-material hash. Client input cannot
  -- override the server snapshot, and retries of one request never select again.
  selected_mode:=case when p_action in ('learning.recognize','learning.recognizeRetry') then 'fast'
    else coalesce((select explanation_mode from public.lingo_settings where user_id=p_user),'fast') end;
  -- Explicit client language is already part of the request hash. Legacy calls
  -- omit it and default to Chinese only after replay detection. Never relabel
  -- a previously completed result when starting a new attempt.
  selected_language:=case when p_action in ('learning.recognize','learning.recognizeRetry') then 'zh'
    else coalesce(p_material->>'explanation_language','zh') end;
  if selected_language not in ('zh','ja','en') then raise exception 'INVALID_EXPLANATION_LANGUAGE'; end if;
  body:=body||jsonb_build_object('request_id',p_id,'revision',rev,'status','processing','error',null,'error_details',null,'usage',null,'explanation_mode',selected_mode,'explanation_language',selected_language,'provider','deepseek','model','deepseek-flash','template_version','lingo-cloud-4');
  if initial then
    insert into public.lingo_records(id,user_id,local_date,payload) values(p_record,p_user,(body->>'local_date')::date,body);
  else
    update public.lingo_records set payload=body,updated_at=now() where id=p_record and user_id=p_user;
  end if;
  insert into public.lingo_requests(user_id,id,record_id,action,input_hash,deadline) values(p_user,p_id,p_record,p_action,p_hash,now()+interval '120 seconds') returning * into request;
  return jsonb_build_object('replay',false,'record',body,'deadline',request.deadline);
end $$;
revoke all on function public.lingo_begin(uuid,uuid,uuid,text,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.lingo_begin(uuid,uuid,uuid,text,text,jsonb,integer) to service_role;

-- Old backup preferences have no language field. Keep material as saved and
-- normalize only account preferences before populating the settings table.
create or replace function public.lingo_restore_empty(p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t text; row jsonb; owner uuid; occupied boolean; columns_expected text[]; settings_rows jsonb;
begin
  if p_snapshot->>'format'<>'lingo-cloud/1' or jsonb_typeof(p_snapshot->'tables')<>'object' then raise exception 'INVALID_BACKUP_FORMAT'; end if;
  columns_expected:=array['lingo_records','lingo_requests','lingo_settings','lingo_cards','lingo_review_batches','lingo_review_items','lingo_deliveries'];
  if (select array_agg(key order by key) from jsonb_object_keys(p_snapshot->'tables') key)
    is distinct from (select array_agg(value order by value) from unnest(columns_expected) value) then raise exception 'INVALID_BACKUP_TABLES'; end if;
  lock table public.lingo_records,public.lingo_requests,public.lingo_settings,public.lingo_push_subscriptions,public.lingo_cards,public.lingo_review_batches,public.lingo_review_items,public.lingo_deliveries,lingo_private.user_keys in access exclusive mode;
  if exists(select 1 from public.lingo_push_subscriptions) or exists(select 1 from lingo_private.user_keys) then raise exception 'RESTORE_TARGET_NOT_EMPTY'; end if;
  foreach t in array columns_expected loop
    execute format('select exists(select 1 from public.%I)',t) into occupied;
    if occupied then raise exception 'RESTORE_TARGET_NOT_EMPTY'; end if;
    if jsonb_typeof(p_snapshot->'tables'->t)<>'array' then raise exception 'INVALID_BACKUP_TABLES'; end if;
    for row in select value from jsonb_array_elements(p_snapshot->'tables'->t) loop
      owner:=(row->>'user_id')::uuid;
      if owner is null or not exists(select 1 from auth.users where id=owner) then raise exception 'RESTORE_AUTH_USER_MISSING'; end if;
    end loop;
  end loop;
  for row in select value from jsonb_array_elements(p_snapshot->'tables'->'lingo_records') loop
    if row->>'deleted_at' is not null and row->>'image_path' is not null then raise exception 'DELETED_IMAGE_IN_BACKUP'; end if;
    if row->>'image_path' is not null and not exists(select 1 from storage.objects where bucket_id='lingo-images' and name=row->>'image_path') then raise exception 'RESTORE_IMAGE_MISSING'; end if;
  end loop;
  if exists(select 1 from storage.objects o where o.bucket_id='lingo-images' and not exists(
    select 1 from jsonb_array_elements(p_snapshot->'tables'->'lingo_records') r where r->>'image_path'=o.name and r->>'deleted_at' is null
  )) then raise exception 'RESTORE_BUCKET_NOT_EMPTY'; end if;
  select coalesce(jsonb_agg(value||jsonb_build_object('font_theme',coalesce(value->>'font_theme','clean'),'explanation_language',coalesce(value->>'explanation_language','zh'),'email_enabled',false)),'[]'::jsonb)
    into settings_rows from jsonb_array_elements(p_snapshot->'tables'->'lingo_settings');
  insert into public.lingo_records select * from jsonb_populate_recordset(null::public.lingo_records,p_snapshot->'tables'->'lingo_records');
  insert into public.lingo_requests select * from jsonb_populate_recordset(null::public.lingo_requests,p_snapshot->'tables'->'lingo_requests');
  insert into public.lingo_settings select * from jsonb_populate_recordset(null::public.lingo_settings,settings_rows);
  insert into public.lingo_cards select * from jsonb_populate_recordset(null::public.lingo_cards,p_snapshot->'tables'->'lingo_cards');
  insert into public.lingo_review_batches select * from jsonb_populate_recordset(null::public.lingo_review_batches,p_snapshot->'tables'->'lingo_review_batches');
  insert into public.lingo_review_items select * from jsonb_populate_recordset(null::public.lingo_review_items,p_snapshot->'tables'->'lingo_review_items');
  insert into public.lingo_deliveries select * from jsonb_populate_recordset(null::public.lingo_deliveries,p_snapshot->'tables'->'lingo_deliveries');
  update public.lingo_requests set status='interrupted' where status='processing';
  update public.lingo_records set payload=payload||jsonb_build_object('status','interrupted','error','RESTORED_REQUEST_NOT_RESUMED','revision',(payload->>'revision')::integer+1)
    where deleted_at is null and payload->>'status' in ('saved','processing');
  update public.lingo_settings set review_enabled=false,push_enabled=false,email_enabled=false,updated_at=now();
  update public.lingo_deliveries set status=case when status='accepted' then 'accepted' else 'disabled' end,claim_token=null,lease_until=null;
  if exists(select 1 from public.lingo_requests q join public.lingo_records r on r.id=q.record_id where q.user_id<>r.user_id)
    or exists(select 1 from public.lingo_cards c join public.lingo_records r on r.id=c.record_id where c.user_id<>r.user_id or r.deleted_at is not null)
    or exists(select 1 from public.lingo_review_items i join public.lingo_review_batches b on b.id=i.batch_id join public.lingo_cards c on c.id=i.card_id where i.user_id<>b.user_id or i.user_id<>c.user_id)
    or exists(select 1 from public.lingo_deliveries d join public.lingo_review_batches b on b.id=d.batch_id where d.user_id<>b.user_id)
    then raise exception 'BACKUP_OWNERSHIP_MISMATCH'; end if;
  return jsonb_build_object('restored',true,'record_count',(select count(*) from public.lingo_records),'review_disabled',true,'keys_restored',false,'subscriptions_restored',false);
end $$;

revoke all on function public.lingo_restore_empty(jsonb) from public,anon,authenticated;
grant execute on function public.lingo_restore_empty(jsonb) to service_role;
