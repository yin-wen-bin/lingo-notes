-- Operator-only backup/restore for the new cloud dataset. Keys, Auth data and
-- push subscriptions are deliberately excluded. Storage bytes are handled by
-- the local encrypted-object backup tool, never in this JSON aggregate.
create function public.lingo_backup_snapshot() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'format','lingo-cloud/1','captured_at',statement_timestamp(),
    'tables',jsonb_build_object(
      'lingo_records',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('image_path',case when r.deleted_at is null then r.image_path else null end,'payload',case when r.deleted_at is null then r.payload else jsonb_build_object('record_id',r.id,'revision',r.payload->'revision','deleted',true) end) order by r.id) from public.lingo_records r),'[]'::jsonb),
      'lingo_requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.user_id,r.id) from public.lingo_requests r),'[]'::jsonb),
      'lingo_settings',coalesce((select jsonb_agg(to_jsonb(r) order by r.user_id) from public.lingo_settings r),'[]'::jsonb),
      'lingo_cards',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.lingo_cards r),'[]'::jsonb),
      'lingo_review_batches',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.lingo_review_batches r),'[]'::jsonb),
      'lingo_review_items',coalesce((select jsonb_agg(to_jsonb(r) order by r.batch_id,r.position) from public.lingo_review_items r),'[]'::jsonb),
      'lingo_deliveries',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('claim_token',null,'lease_until',null) order by r.batch_id,r.channel) from public.lingo_deliveries r),'[]'::jsonb)
    )
  )
$$;
create function public.lingo_restore_check(p_users uuid[]) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.lingo_records) or exists(select 1 from public.lingo_requests)
    or exists(select 1 from public.lingo_settings) or exists(select 1 from public.lingo_cards)
    or exists(select 1 from public.lingo_review_batches) or exists(select 1 from public.lingo_review_items)
    or exists(select 1 from public.lingo_deliveries) or exists(select 1 from public.lingo_push_subscriptions)
    or exists(select 1 from lingo_private.user_keys) then raise exception 'RESTORE_TARGET_NOT_EMPTY'; end if;
  if exists(select 1 from storage.objects where bucket_id='lingo-images') then raise exception 'RESTORE_BUCKET_NOT_EMPTY'; end if;
  if exists(select 1 from unnest(p_users) u where not exists(select 1 from auth.users a where a.id=u)) then raise exception 'RESTORE_AUTH_USER_MISSING'; end if;
  return jsonb_build_object('empty',true,'users_verified',cardinality(p_users));
end $$;
create function public.lingo_restore_empty(p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t text; row jsonb; owner uuid; occupied boolean; columns_expected text[];
begin
  if p_snapshot->>'format'<>'lingo-cloud/1' or jsonb_typeof(p_snapshot->'tables')<>'object' then raise exception 'INVALID_BACKUP_FORMAT'; end if;
  columns_expected:=array['lingo_records','lingo_requests','lingo_settings','lingo_cards','lingo_review_batches','lingo_review_items','lingo_deliveries'];
  if (select array_agg(key order by key) from jsonb_object_keys(p_snapshot->'tables') key)
    is distinct from (select array_agg(value order by value) from unnest(columns_expected) value) then raise exception 'INVALID_BACKUP_TABLES'; end if;
  -- Lock every application table before testing emptiness. This is one database
  -- transaction; a failed FK/validation cannot leave half a restored dataset.
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
  -- Immutable screenshot objects must already exist and belong to these records.
  for row in select value from jsonb_array_elements(p_snapshot->'tables'->'lingo_records') loop
    if row->>'deleted_at' is not null and row->>'image_path' is not null then raise exception 'DELETED_IMAGE_IN_BACKUP'; end if;
    if row->>'image_path' is not null and not exists(select 1 from storage.objects where bucket_id='lingo-images' and name=row->>'image_path') then raise exception 'RESTORE_IMAGE_MISSING'; end if;
  end loop;
  -- No foreign/unrelated files may have arrived since the local empty-bucket preflight.
  if exists(select 1 from storage.objects o where o.bucket_id='lingo-images' and not exists(
    select 1 from jsonb_array_elements(p_snapshot->'tables'->'lingo_records') r where r->>'image_path'=o.name and r->>'deleted_at' is null
  )) then raise exception 'RESTORE_BUCKET_NOT_EMPTY'; end if;
  insert into public.lingo_records select * from jsonb_populate_recordset(null::public.lingo_records,p_snapshot->'tables'->'lingo_records');
  insert into public.lingo_requests select * from jsonb_populate_recordset(null::public.lingo_requests,p_snapshot->'tables'->'lingo_requests');
  insert into public.lingo_settings select * from jsonb_populate_recordset(null::public.lingo_settings,p_snapshot->'tables'->'lingo_settings');
  insert into public.lingo_cards select * from jsonb_populate_recordset(null::public.lingo_cards,p_snapshot->'tables'->'lingo_cards');
  insert into public.lingo_review_batches select * from jsonb_populate_recordset(null::public.lingo_review_batches,p_snapshot->'tables'->'lingo_review_batches');
  insert into public.lingo_review_items select * from jsonb_populate_recordset(null::public.lingo_review_items,p_snapshot->'tables'->'lingo_review_items');
  insert into public.lingo_deliveries select * from jsonb_populate_recordset(null::public.lingo_deliveries,p_snapshot->'tables'->'lingo_deliveries');
  -- Imported work never resumes, bills a model, or sends a notification.
  update public.lingo_requests set status='interrupted' where status='processing';
  update public.lingo_records set payload=payload||jsonb_build_object('status','interrupted','error','RESTORED_REQUEST_NOT_RESUMED','revision',(payload->>'revision')::integer+1)
    where deleted_at is null and payload->>'status' in ('saved','processing');
  update public.lingo_settings set review_enabled=false,push_enabled=false,email_enabled=false,updated_at=now();
  update public.lingo_deliveries set status=case when status='accepted' then 'accepted' else 'disabled' end,claim_token=null,lease_until=null;
  -- Verify row ownership across foreign keys, beyond the ordinary FK constraint.
  if exists(select 1 from public.lingo_requests q join public.lingo_records r on r.id=q.record_id where q.user_id<>r.user_id)
    or exists(select 1 from public.lingo_cards c join public.lingo_records r on r.id=c.record_id where c.user_id<>r.user_id or r.deleted_at is not null)
    or exists(select 1 from public.lingo_review_items i join public.lingo_review_batches b on b.id=i.batch_id join public.lingo_cards c on c.id=i.card_id where i.user_id<>b.user_id or i.user_id<>c.user_id)
    or exists(select 1 from public.lingo_deliveries d join public.lingo_review_batches b on b.id=d.batch_id where d.user_id<>b.user_id)
    then raise exception 'BACKUP_OWNERSHIP_MISMATCH'; end if;
  return jsonb_build_object('restored',true,'record_count',(select count(*) from public.lingo_records),'review_disabled',true,'keys_restored',false,'subscriptions_restored',false);
end $$;
revoke all on function public.lingo_backup_snapshot() from public,anon,authenticated;
revoke all on function public.lingo_restore_check(uuid[]) from public,anon,authenticated;
revoke all on function public.lingo_restore_empty(jsonb) from public,anon,authenticated;
grant execute on function public.lingo_backup_snapshot() to service_role;
grant execute on function public.lingo_restore_check(uuid[]) to service_role;
grant execute on function public.lingo_restore_empty(jsonb) to service_role;
