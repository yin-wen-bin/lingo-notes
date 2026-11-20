-- New application only. No imports or writes to previous learning data.
create schema if not exists lingo_private;
create extension if not exists supabase_vault with schema vault;
revoke all on schema lingo_private from public, anon, authenticated;
grant usage on schema lingo_private to service_role;

create table public.lingo_records (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  local_date date not null, payload jsonb not null, image_path text, deleted_at timestamptz
);
create index lingo_records_history on public.lingo_records(user_id, created_at desc) where deleted_at is null;
create table public.lingo_requests (
  user_id uuid not null references auth.users(id) on delete cascade, id uuid not null,
  record_id uuid not null references public.lingo_records(id) on delete cascade,
  action text not null, input_hash text not null, status text not null default 'processing',
  created_at timestamptz not null default now(), deadline timestamptz not null,
  timings jsonb not null default '{}', primary key(user_id,id),
  check(status in ('processing','complete','failed','interrupted','cancelled'))
);
create unique index lingo_one_active_request on public.lingo_requests(user_id) where status='processing';
create table public.lingo_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  review_enabled boolean not null default false, push_enabled boolean not null default false,
  email_enabled boolean not null default false, updated_at timestamptz not null default now()
);
create table public.lingo_push_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  subscription jsonb not null, updated_at timestamptz not null default now()
);
create table public.lingo_cards (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  record_id uuid not null references public.lingo_records(id) on delete cascade,
  slot integer not null check(slot between 0 and 2),
  local_date date not null, payload jsonb not null, last_selected_at timestamptz,
  unique(record_id,slot)
);
create index lingo_cards_due on public.lingo_cards(user_id,local_date,last_selected_at);
create table public.lingo_review_batches (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null, created_at timestamptz not null default now(), opened_at timestamptz,
  unique(user_id,local_date)
);
create table public.lingo_review_items (
  batch_id uuid not null references public.lingo_review_batches(id) on delete cascade,
  card_id uuid not null references public.lingo_cards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, position integer not null,
  primary key(batch_id,card_id)
);
create table public.lingo_deliveries (
  batch_id uuid not null references public.lingo_review_batches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, channel text not null check(channel in ('push','email')),
  status text not null default 'pending' check(status in ('pending','sending','accepted','failed','disabled')),
  attempts integer not null default 0, lease_until timestamptz, claim_token uuid,
  accepted_at timestamptz, last_error text, updated_at timestamptz not null default now(), primary key(batch_id,channel)
);
create table lingo_private.user_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  secret_id uuid not null, last_four text not null, updated_at timestamptz not null default now()
);
grant all on lingo_private.user_keys to service_role;

-- Every browser table is owner-readable and has no browser write policy.
do $$ declare t text; begin
  foreach t in array array['lingo_records','lingo_requests','lingo_settings','lingo_push_subscriptions','lingo_cards','lingo_review_batches','lingo_review_items','lingo_deliveries'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid()) = user_id)',t);
  end loop;
end $$;
-- Key references and Vault plaintext are never exposed through the application.
revoke all on schema vault from public, anon, authenticated;
revoke all on all tables in schema vault from public, anon, authenticated;
-- Vault contains Supabase-owned crypto functions which the project postgres
-- role cannot ALTER. Do not change their platform grants. Revoking schema USAGE
-- blocks browser roles from reaching them; our public wrappers are separately
-- restricted to service_role below.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('lingo-images','lingo-images',false,4194304,array['image/png']);
-- All object access goes through owner-checked Edge Functions and short-lived URLs.

create function public.lingo_key_set(p_user uuid,p_key text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare sid uuid;
begin
  if p_key !~ '^sk-[A-Za-z0-9_-]{16,250}$' then raise exception 'INVALID_API_KEY'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
  select secret_id into sid from lingo_private.user_keys where user_id=p_user;
  if sid is null then
    select vault.create_secret(p_key,'lingo-user-'||p_user::text) into sid;
  else
    perform vault.update_secret(sid,p_key);
  end if;
  insert into lingo_private.user_keys(user_id,secret_id,last_four) values(p_user,sid,right(p_key,4))
    on conflict(user_id) do update set last_four=excluded.last_four,updated_at=now();
  return jsonb_build_object('configured',true,'last_four',right(p_key,4));
end $$;
create function public.lingo_key_get(p_user uuid,p_plain boolean default false) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare k lingo_private.user_keys; value text;
begin
  select * into k from lingo_private.user_keys where user_id=p_user;
  if not found then return jsonb_build_object('configured',false); end if;
  if p_plain then
    select decrypted_secret into value from vault.decrypted_secrets where id=k.secret_id;
    if value is null then raise exception 'KEY_UNAVAILABLE'; end if;
    return jsonb_build_object('key',value);
  end if;
  return jsonb_build_object('configured',true,'last_four',k.last_four);
end $$;
create function public.lingo_key_delete(p_user uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare sid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,1));
  delete from lingo_private.user_keys where user_id=p_user returning secret_id into sid;
  if sid is not null then delete from vault.secrets where id=sid; end if;
  return jsonb_build_object('configured',false);
end $$;

create function public.lingo_expire(p_user uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare r record;
begin
  for r in update public.lingo_requests set status='interrupted'
    where user_id=p_user and status='processing' and deadline<=now() returning record_id,id loop
    update public.lingo_records set payload=payload||jsonb_build_object('status','interrupted','error','REQUEST_INTERRUPTED_RESULT_UNKNOWN','revision',(payload->>'revision')::int+1),updated_at=now()
      where id=r.record_id and user_id=p_user and deleted_at is null and payload->>'request_id'=r.id::text;
  end loop;
end $$;
create function public.lingo_begin(p_user uuid,p_id uuid,p_record uuid,p_action text,p_hash text,p_material jsonb,p_revision integer default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare request public.lingo_requests; rec public.lingo_records; initial boolean; body jsonb; rev integer;
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
  body:=body||jsonb_build_object('request_id',p_id,'revision',rev,'status','processing','error',null,'provider','deepseek','model','deepseek-flash','template_version','lingo-cloud-1');
  if initial then
    insert into public.lingo_records(id,user_id,local_date,payload) values(p_record,p_user,(body->>'local_date')::date,body);
  else
    update public.lingo_records set payload=body,updated_at=now() where id=p_record and user_id=p_user;
  end if;
  insert into public.lingo_requests(user_id,id,record_id,action,input_hash,deadline) values(p_user,p_id,p_record,p_action,p_hash,now()+interval '120 seconds') returning * into request;
  return jsonb_build_object('replay',false,'record',body,'deadline',request.deadline);
end $$;
create function public.lingo_attach_image(p_user uuid,p_id uuid,p_image jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare request public.lingo_requests; value jsonb;
begin
  select * into request from public.lingo_requests where user_id=p_user and id=p_id for update;
  if not found or request.status<>'processing' or request.deadline<=now() then raise exception 'REQUEST_NOT_ACTIVE'; end if;
  update public.lingo_records set image_path=p_image->>'path',payload=payload||jsonb_build_object('image',p_image),updated_at=now()
    where id=request.record_id and user_id=p_user and deleted_at is null and payload->>'request_id'=p_id::text returning payload into value;
  if value is null then raise exception 'REQUEST_NOT_ACTIVE'; end if;
  return value;
end $$;
create function public.lingo_finish(p_user uuid,p_id uuid,p_status text,p_patch jsonb,p_cards jsonb default '[]') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare request public.lingo_requests; value jsonb; card jsonb; card_index integer:=0; existing_card uuid;
begin
  if p_status not in ('complete','failed','interrupted') then raise exception 'INVALID_REQUEST_STATE'; end if;
  select * into request from public.lingo_requests where user_id=p_user and id=p_id for update;
  if not found or request.status<>'processing' or request.deadline<=now() then raise exception 'REQUEST_NOT_ACTIVE'; end if;
  update public.lingo_records set payload=payload||p_patch||jsonb_build_object('revision',(payload->>'revision')::int+1),updated_at=now()
    where id=request.record_id and user_id=p_user and deleted_at is null and payload->>'request_id'=p_id::text returning payload into value;
  if value is null then raise exception 'REQUEST_NOT_ACTIVE'; end if;
  update public.lingo_requests set status=p_status where user_id=p_user and id=p_id;
  if p_patch->>'status'='complete' then
    -- IDs identify a slot within one note. Revisions update that slot, so a batch
    -- already sent still opens the corrected content. No semantic deduplication.
    for card in select * from jsonb_array_elements(p_cards) loop
      select id into existing_card from public.lingo_cards where record_id=request.record_id and user_id=p_user and slot=card_index;
      if existing_card is null then
        insert into public.lingo_cards(id,user_id,record_id,slot,local_date,payload) values((card->>'id')::uuid,p_user,request.record_id,card_index,(value->>'local_date')::date,card);
      else
        update public.lingo_cards set payload=card||jsonb_build_object('id',existing_card) where id=existing_card and user_id=p_user;
      end if;
      card_index:=card_index+1;
    end loop;
    delete from public.lingo_cards where record_id=request.record_id and user_id=p_user and slot>=card_index;
  end if;
  return value;
end $$;
create function public.lingo_cancel(p_user uuid,p_record uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare value jsonb; request_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
  update public.lingo_requests set status='cancelled' where user_id=p_user and record_id=p_record and status='processing' returning id into request_id;
  if request_id is not null then
    update public.lingo_records set payload=payload||jsonb_build_object('status','cancelled','error','CANCELLED_REQUEST_MAY_HAVE_BEEN_SENT','revision',(payload->>'revision')::int+1),updated_at=now()
      where id=p_record and user_id=p_user and deleted_at is null;
  end if;
  select payload into value from public.lingo_records where user_id=p_user and id=p_record and deleted_at is null;
  if value is null then raise exception 'RECORD_NOT_FOUND'; end if;
  return value;
end $$;
create function public.lingo_delete(p_user uuid,p_record uuid,p_revision integer) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare rec public.lingo_records;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
  -- Match finish's lock order (request before record) to avoid cancel/delete deadlocks.
  perform 1 from public.lingo_requests where user_id=p_user and record_id=p_record for update;
  select * into rec from public.lingo_records where user_id=p_user and id=p_record for update;
  if not found then raise exception 'RECORD_NOT_FOUND'; end if;
  if rec.deleted_at is not null then return jsonb_build_object('record_id',p_record,'deleted',true); end if;
  if (rec.payload->>'revision')::integer<>p_revision then raise exception 'REVISION_CONFLICT'; end if;
  update public.lingo_requests set status='cancelled',timings='{}' where user_id=p_user and record_id=p_record and status='processing';
  delete from public.lingo_cards where user_id=p_user and record_id=p_record;
  update public.lingo_records set deleted_at=now(),updated_at=now(),payload=jsonb_build_object('record_id',p_record,'revision',p_revision+1,'deleted',true)
    where id=p_record and user_id=p_user;
  return jsonb_build_object('record_id',p_record,'deleted',true);
end $$;

create function public.lingo_make_batch(p_user uuid,p_now timestamptz default now()) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare day date := (p_now at time zone 'Asia/Shanghai')::date; bid uuid; selected uuid[]; recent uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,2));
  if not exists(select 1 from public.lingo_settings where user_id=p_user and review_enabled) then return null; end if;
  select id into bid from public.lingo_review_batches where user_id=p_user and local_date=day;
  if found then
    insert into public.lingo_deliveries(batch_id,user_id,channel)
      select bid,p_user,'push' from public.lingo_settings where user_id=p_user and push_enabled
      union all select bid,p_user,'email' from public.lingo_settings where user_id=p_user and email_enabled
      on conflict(batch_id,channel) do nothing;
    return bid;
  end if;
  select coalesce(array_agg(id),'{}'::uuid[]) into recent from (
    select c.id from public.lingo_cards c join public.lingo_records r on r.id=c.record_id
    where c.user_id=p_user and r.deleted_at is null and r.payload->>'status'='complete' and c.local_date<day and c.local_date>=day-7 and c.last_selected_at is null
    order by c.local_date desc,c.id limit 2
  ) q;
  select recent||coalesce(array_agg(id),'{}'::uuid[]) into selected from (
    select c.id from public.lingo_cards c join public.lingo_records r on r.id=c.record_id
    where c.user_id=p_user and r.deleted_at is null and r.payload->>'status'='complete' and c.local_date<day and not(c.id=any(recent))
      and (c.last_selected_at is null or c.last_selected_at<=p_now-interval '3 days')
    order by c.last_selected_at nulls first,c.local_date,c.id limit 5-cardinality(recent)
  ) q;
  if cardinality(selected)=0 then return null; end if;
  insert into public.lingo_review_batches(user_id,local_date) values(p_user,day) returning id into bid;
  insert into public.lingo_review_items(batch_id,card_id,user_id,position) select bid,id,p_user,n from unnest(selected) with ordinality as t(id,n);
  update public.lingo_cards set last_selected_at=p_now where user_id=p_user and id=any(selected);
  insert into public.lingo_deliveries(batch_id,user_id,channel)
    select bid,p_user,'push' from public.lingo_settings where user_id=p_user and push_enabled
    union all select bid,p_user,'email' from public.lingo_settings where user_id=p_user and email_enabled;
  return bid;
end $$;
create function public.lingo_claim_delivery(p_batch uuid,p_channel text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare value public.lingo_deliveries;
begin
  update public.lingo_deliveries d set status='sending',attempts=attempts+1,claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
    where batch_id=p_batch and channel=p_channel and attempts<3
      and (status in ('pending','failed') or (status='sending' and lease_until<now()))
      and exists(select 1 from public.lingo_settings s where s.user_id=d.user_id and s.review_enabled and case when p_channel='push' then s.push_enabled else s.email_enabled end)
      and exists(select 1 from public.lingo_review_items i where i.batch_id=d.batch_id)
    returning * into value;
  if not found then return null; end if;
  return to_jsonb(value);
end $$;
create function public.lingo_finish_delivery(p_batch uuid,p_channel text,p_token uuid,p_status text,p_error text default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare count integer;
begin
  if p_status not in ('accepted','failed','disabled') then raise exception 'INVALID_DELIVERY_STATE'; end if;
  update public.lingo_deliveries set status=p_status,last_error=p_error,accepted_at=case when p_status='accepted' then now() else null end,lease_until=null,updated_at=now()
    where batch_id=p_batch and channel=p_channel and claim_token=p_token and status='sending';
  get diagnostics count=row_count;
  return count=1;
end $$;

create function public.lingo_history(p_user uuid,p_query text default '',p_offset integer default 0,p_limit integer default 30) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare rows jsonb; total integer;
begin
  if p_offset<0 or p_limit<1 or p_limit>100 or length(p_query)>500 then raise exception 'INVALID_SEARCH'; end if;
  select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id),'[]'),count(*) into rows,total from (
    select r.id,r.created_at,jsonb_build_object('record_id',r.id,'revision',r.payload->'revision','local_date',r.local_date,'status',r.payload->>'status','input_type',r.payload->>'input_type','has_image',r.image_path is not null,'text',left(coalesce(r.payload->>'corrected_text',r.payload->>'recognized_text',r.payload->>'original_text',''),180)) as item
    from public.lingo_records r where r.user_id=p_user and r.deleted_at is null
      and (p_query='' or position(lower(p_query) in lower(coalesce(r.payload->>'original_text','')||' '||coalesce(r.payload->>'corrected_text','')||' '||coalesce(r.payload->>'recognized_text','')||' '||coalesce(r.payload->'result'->>'summary_zh','')))>0)
    order by r.created_at desc,r.id offset p_offset limit p_limit+1
  ) q;
  return jsonb_build_object('items',case when total>p_limit then rows-p_limit else rows end,'has_more',total>p_limit);
end $$;
create function public.lingo_metric(p_user uuid,p_id uuid,p_timings jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare value jsonb;
begin
  update public.lingo_requests set timings=timings||p_timings where user_id=p_user and id=p_id returning timings into value;
  if value is null then raise exception 'REQUEST_NOT_FOUND'; end if;
  return value;
end $$;
create function public.lingo_unsubscribe(p_user uuid,p_endpoint text default null,p_subscription jsonb default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare count integer;
begin
  delete from public.lingo_push_subscriptions where user_id=p_user and (p_endpoint is null or subscription->>'endpoint'=p_endpoint)
    and (p_subscription is null or subscription=p_subscription);
  get diagnostics count=row_count;
  if count>0 then update public.lingo_settings set push_enabled=false,updated_at=now() where user_id=p_user;end if;
  return jsonb_build_object('removed',count>0);
end $$;
create function public.lingo_cleanup_candidates() returns text[]
language sql security definer set search_path=public,pg_temp as $$
  select coalesce(array_agg(path),'{}'::text[]) from (
    select image_path as path from public.lingo_records where deleted_at is not null and image_path is not null
    union
    select name from storage.objects o where bucket_id='lingo-images' and created_at<now()-interval '1 day'
      and not exists(select 1 from public.lingo_records r where r.image_path=o.name and r.deleted_at is null)
    limit 100
  ) candidates
$$;
create function lingo_private.remove_key_secret() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin delete from vault.secrets where id=old.secret_id;return old;end $$;
create trigger lingo_remove_key_secret after delete on lingo_private.user_keys for each row execute function lingo_private.remove_key_secret();
revoke all on function lingo_private.remove_key_secret() from public,anon,authenticated;

-- PostgreSQL defaults function EXECUTE to PUBLIC. Revoke explicitly for every app RPC.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'lingo\_%' escape '\' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
