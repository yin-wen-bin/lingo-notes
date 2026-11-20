-- Account-scoped typography, with email reminders retired. Historical delivery
-- audit rows and all learning material remain in place.
alter table public.lingo_settings add column font_theme text not null default 'clean'
  constraint lingo_settings_font_theme_check check (font_theme in ('handwritten','bookish','clean'));
update public.lingo_settings set email_enabled=false where email_enabled;
alter table public.lingo_settings add constraint lingo_settings_email_disabled_check check (not email_enabled);
update public.lingo_deliveries set status='disabled',claim_token=null,lease_until=null,updated_at=now()
  where channel='email' and status in ('pending','failed','sending');

create or replace function public.lingo_make_batch(p_user uuid,p_now timestamptz default now()) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare day date := (p_now at time zone 'Asia/Shanghai')::date; bid uuid; selected uuid[]; recent uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,2));
  if not exists(select 1 from public.lingo_settings where user_id=p_user and review_enabled) then return null; end if;
  select id into bid from public.lingo_review_batches where user_id=p_user and local_date=day;
  if found then
    insert into public.lingo_deliveries(batch_id,user_id,channel)
      select bid,p_user,'push' from public.lingo_settings where user_id=p_user and push_enabled
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
    select bid,p_user,'push' from public.lingo_settings where user_id=p_user and push_enabled;
  return bid;
end $$;

create or replace function public.lingo_claim_delivery(p_batch uuid,p_channel text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare value public.lingo_deliveries;
begin
  if p_channel is distinct from 'push' then return null; end if;
  update public.lingo_deliveries d set status='sending',attempts=attempts+1,claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
    where batch_id=p_batch and channel='push' and attempts<3
      and (status in ('pending','failed') or (status='sending' and lease_until<now()))
      and exists(select 1 from public.lingo_settings s where s.user_id=d.user_id and s.review_enabled and s.push_enabled)
      and exists(select 1 from public.lingo_review_items i where i.batch_id=d.batch_id)
    returning * into value;
  if not found then return null; end if;
  return to_jsonb(value);
end $$;

-- Cloud backups made before this preference existed are still valid. Normalize
-- settings before record population because explicit JSON nulls bypass defaults.
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
  select coalesce(jsonb_agg(value||jsonb_build_object('font_theme',coalesce(value->>'font_theme','clean'),'email_enabled',false)),'[]'::jsonb)
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

revoke all on function public.lingo_make_batch(uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.lingo_claim_delivery(uuid,text) from public,anon,authenticated;
revoke all on function public.lingo_restore_empty(jsonb) from public,anon,authenticated;
grant execute on function public.lingo_make_batch(uuid,timestamptz) to service_role;
grant execute on function public.lingo_claim_delivery(uuid,text) to service_role;
grant execute on function public.lingo_restore_empty(jsonb) to service_role;
