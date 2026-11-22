-- Add the refined typography option and change only future defaults. Existing
-- account selections, including explicitly selected clean, remain untouched.
alter table public.lingo_settings drop constraint lingo_settings_font_theme_check;
alter table public.lingo_settings add constraint lingo_settings_font_theme_check
  check (font_theme in ('handwritten','bookish','clean','refined'));
alter table public.lingo_settings alter column font_theme set default 'refined';

-- Preserve explicit preferences in cloud backups and use the current default
-- only when the old snapshot has no font preference. No learning data is changed.
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
  select coalesce(jsonb_agg(value||jsonb_build_object('font_theme',coalesce(value->>'font_theme','refined'),'explanation_language',coalesce(value->>'explanation_language','zh'),'email_enabled',false)),'[]'::jsonb)
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
