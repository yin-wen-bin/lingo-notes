-- Account-scoped, explicitly completed spaced reviews. Selection and notification
-- never imply that the learner reviewed or mastered a learning point.
alter table public.lingo_settings add column review_daily_limit integer not null default 5
  constraint lingo_settings_review_daily_limit_check check (review_daily_limit between 1 and 100);

create table public.lingo_review_points (
  user_id uuid not null references auth.users(id) on delete cascade,
  point_key text not null check (point_key ~ '^[a-f0-9]{64}$'),
  first_learned_date date not null,
  review_round smallint not null default 0 check (review_round between 0 and 5),
  next_due_date date,
  mastered_at timestamptz,
  last_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(user_id,point_key),
  check ((review_round=5 and next_due_date is null) or (review_round<5 and next_due_date is not null))
);
create index lingo_review_points_due on public.lingo_review_points(user_id,next_due_date,point_key)
  where mastered_at is null and review_round<5;
alter table public.lingo_review_points enable row level security;
revoke all on public.lingo_review_points from anon,authenticated;
grant select on public.lingo_review_points to authenticated;
grant all on public.lingo_review_points to service_role;
create policy owner_read on public.lingo_review_points for select to authenticated using ((select auth.uid())=user_id);

create function public.lingo_point_text(value text) returns text
language sql immutable set search_path=public,pg_temp as $$
  select lower(regexp_replace(btrim(normalize(coalesce(value,''),NFKC)),'[[:space:]]+',' ','g'))
$$;
create function public.lingo_point_key(value jsonb) returns text
language sql immutable set search_path=public,pg_temp as $$
  select encode(sha256(convert_to(jsonb_build_array(
    coalesce(value->>'kind','vocabulary'),
    coalesce(value->>'language','en'),coalesce(value->>'explanation_language','zh'),
    public.lingo_point_text(value->>'term'),public.lingo_point_text(value->>'reading'),public.lingo_point_text(value->>'pos'),
    public.lingo_point_text(value->>'meaning')
  )::text,'UTF8')),'hex')
$$;

alter table public.lingo_cards add column point_key text;
create function public.lingo_sync_review_point() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare rec public.lingo_records; kind text; identity text;
begin
  select * into rec from public.lingo_records where id=new.record_id and user_id=new.user_id and deleted_at is null;
  if not found then raise exception 'BACKUP_OWNERSHIP_MISMATCH'; end if;
  kind:=case when new.payload->>'kind' in ('vocabulary','grammar') then new.payload->>'kind'
    when new.slot<coalesce(jsonb_array_length(rec.payload->'result'->'vocabulary'),1) then 'vocabulary' else 'grammar' end;
  new.payload:=new.payload||jsonb_build_object('id',new.id,'record_id',new.record_id,'kind',kind,
    'pos',case when kind='vocabulary' then coalesce(new.payload->>'pos',rec.payload->'result'->'vocabulary'->new.slot->>'pos','') else '' end);
  identity:=public.lingo_point_key(new.payload);
  if tg_op='INSERT' and new.point_key is not null and new.point_key<>identity then raise exception 'REVIEW_POINT_MISMATCH'; end if;
  new.point_key:=identity;
  insert into public.lingo_review_points(user_id,point_key,first_learned_date,next_due_date)
    values(new.user_id,identity,new.local_date,new.local_date+1)
    on conflict(user_id,point_key) do update set
      first_learned_date=least(lingo_review_points.first_learned_date,excluded.first_learned_date),
      next_due_date=case when lingo_review_points.review_round=0 and excluded.first_learned_date<lingo_review_points.first_learned_date
        then least(lingo_review_points.next_due_date,excluded.first_learned_date+1)
        else lingo_review_points.next_due_date end;
  return new;
end $$;
create trigger lingo_cards_review_point before insert or update of payload,local_date,user_id,record_id,slot
  on public.lingo_cards for each row execute function public.lingo_sync_review_point();
-- A historical push or page-open is not evidence of completing a review.
update public.lingo_cards set payload=payload;
alter table public.lingo_cards alter column point_key set not null;
alter table public.lingo_cards add constraint lingo_cards_review_point_fk
  foreign key(user_id,point_key) references public.lingo_review_points(user_id,point_key);
create index lingo_cards_point on public.lingo_cards(user_id,point_key);

create or replace function public.lingo_finish(p_user uuid,p_id uuid,p_status text,p_patch jsonb,p_cards jsonb default '[]') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare request public.lingo_requests; value jsonb; card jsonb; card_index integer:=0; existing_card uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,2));
  if p_status not in ('complete','failed','interrupted') then raise exception 'INVALID_REQUEST_STATE'; end if;
  select * into request from public.lingo_requests where user_id=p_user and id=p_id for update;
  if not found or request.status<>'processing' or request.deadline<=now() then raise exception 'REQUEST_NOT_ACTIVE'; end if;
  update public.lingo_records set payload=payload||p_patch||jsonb_build_object('revision',(payload->>'revision')::int+1),updated_at=now()
    where id=request.record_id and user_id=p_user and deleted_at is null and payload->>'request_id'=p_id::text returning payload into value;
  if value is null then raise exception 'REQUEST_NOT_ACTIVE'; end if;
  update public.lingo_requests set status=p_status where user_id=p_user and id=p_id;
  if p_patch->>'status'='complete' then
    for card in select * from jsonb_array_elements(p_cards) loop
      select id into existing_card from public.lingo_cards where record_id=request.record_id and user_id=p_user and slot=card_index;
      if existing_card is null then
        insert into public.lingo_cards(id,user_id,record_id,slot,local_date,payload)
          values((card->>'id')::uuid,p_user,request.record_id,card_index,(value->>'local_date')::date,card);
      else
        -- The trigger retains progress only for the same exact normalized point.
        -- A changed slot gets a new point identity and old batch items cannot act on it.
        update public.lingo_cards set payload=card||jsonb_build_object('id',existing_card) where id=existing_card and user_id=p_user;
      end if;
      card_index:=card_index+1;
    end loop;
    delete from public.lingo_cards where record_id=request.record_id and user_id=p_user and slot>=card_index;
  end if;
  return value;
end $$;

alter table public.lingo_review_items add column point_key text;
alter table public.lingo_review_items add column scheduled_round smallint not null default 1 check(scheduled_round between 1 and 5);
alter table public.lingo_review_items add column completed_at timestamptz;
update public.lingo_review_items i set point_key=c.point_key from public.lingo_cards c where c.id=i.card_id and c.user_id=i.user_id;
alter table public.lingo_review_items alter column point_key set not null;
alter table public.lingo_review_items add constraint lingo_review_items_point_fk
  foreign key(user_id,point_key) references public.lingo_review_points(user_id,point_key);

create function public.lingo_review_card(p_user uuid,p_card uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select c.payload||jsonb_build_object('id',c.id,'record_id',c.record_id,'slot',c.slot,'local_date',c.local_date,'point_key',c.point_key,
    'review_round',p.review_round,'next_due_date',p.next_due_date,'mastered',p.mastered_at is not null,
    'mastered_at',p.mastered_at,'last_completed_at',p.last_completed_at,'completed',p.review_round=5)
  from public.lingo_cards c join public.lingo_review_points p on p.user_id=c.user_id and p.point_key=c.point_key
    join public.lingo_records r on r.id=c.record_id and r.user_id=c.user_id
  where c.id=p_card and c.user_id=p_user and r.deleted_at is null
$$;
create function public.lingo_review_cards(p_user uuid,p_record uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare cards jsonb;
begin
  if not exists(select 1 from public.lingo_records where id=p_record and user_id=p_user and deleted_at is null) then raise exception 'RECORD_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(public.lingo_review_card(p_user,id) order by slot),'[]'::jsonb) into cards
    from public.lingo_cards where record_id=p_record and user_id=p_user;
  return jsonb_build_object('cards',cards);
end $$;
create function public.lingo_batch_has_pending(p_user uuid,p_batch uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(
    select 1 from public.lingo_review_items i
      join public.lingo_review_batches b on b.id=i.batch_id and b.user_id=i.user_id
      join public.lingo_cards c on c.id=i.card_id and c.user_id=i.user_id and c.point_key=i.point_key
      join public.lingo_records r on r.id=c.record_id and r.user_id=c.user_id
      join public.lingo_review_points p on p.user_id=i.user_id and p.point_key=i.point_key
    where i.user_id=p_user and i.batch_id=p_batch and r.deleted_at is null and r.payload->>'status'='complete'
      and p.mastered_at is null and p.review_round<i.scheduled_round and i.completed_at is null
  )
$$;
create function public.lingo_review_batch(p_user uuid,p_batch uuid default null,p_date date default null) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare b public.lingo_review_batches; cards jsonb; deliveries jsonb;
begin
  select * into b from public.lingo_review_batches where user_id=p_user
    and ((p_batch is not null and id=p_batch) or (p_batch is null and local_date=p_date));
  if not found then return jsonb_build_object('batch',null); end if;
  select coalesce(jsonb_agg(value order by position),'[]'::jsonb) into cards from (
    select distinct on(i.point_key) i.position,
      public.lingo_review_card(p_user,c.id)||jsonb_build_object('scheduled_round',i.scheduled_round,
        'reviewed',p.review_round>=i.scheduled_round or i.completed_at is not null,
        'completed_at',coalesce(i.completed_at,case when p.review_round>=i.scheduled_round then p.last_completed_at end)) as value
    from public.lingo_review_items i
      join public.lingo_cards c on c.id=i.card_id and c.user_id=i.user_id and c.point_key=i.point_key
      join public.lingo_records r on r.id=c.record_id and r.user_id=c.user_id
      join public.lingo_review_points p on p.user_id=i.user_id and p.point_key=i.point_key
    where i.batch_id=b.id and i.user_id=p_user and r.deleted_at is null and p.mastered_at is null
    order by i.point_key,i.position
  ) ordered;
  select coalesce(jsonb_agg(jsonb_build_object('channel',channel,'status',status,'attempts',attempts,
    'accepted_at',accepted_at,'last_error',last_error)),'[]'::jsonb) into deliveries
    from public.lingo_deliveries where batch_id=b.id and user_id=p_user;
  return jsonb_build_object('batch',jsonb_build_object('id',b.id,'local_date',b.local_date,
    'created_at',b.created_at,'opened_at',b.opened_at,'cards',cards,'deliveries',deliveries));
end $$;
create function public.lingo_review_complete(p_user uuid,p_batch uuid,p_card uuid,p_point text,p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.lingo_review_items; progress public.lingo_review_points; day date:=(p_now at time zone 'Asia/Shanghai')::date; next_round integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,2));
  select i.* into item from public.lingo_review_items i
    join public.lingo_review_batches b on b.id=i.batch_id and b.user_id=i.user_id
    join public.lingo_cards c on c.id=i.card_id and c.user_id=i.user_id and c.point_key=i.point_key
    join public.lingo_records r on r.id=c.record_id and r.user_id=c.user_id
    where i.user_id=p_user and i.batch_id=p_batch and i.card_id=p_card and i.point_key=p_point and r.deleted_at is null;
  if not found then raise exception 'REVIEW_ITEM_NOT_FOUND'; end if;
  select * into progress from public.lingo_review_points where user_id=p_user and point_key=item.point_key for update;
  if progress.mastered_at is null and progress.review_round=item.scheduled_round-1 and item.completed_at is null then
    next_round:=progress.review_round+1;
    update public.lingo_review_points set review_round=next_round,last_completed_at=p_now,updated_at=p_now,
      next_due_date=case next_round when 1 then day+2 when 2 then day+4 when 3 then day+7 when 4 then day+16 else null end
      where user_id=p_user and point_key=item.point_key;
    update public.lingo_review_items set completed_at=p_now
      where user_id=p_user and point_key=item.point_key and scheduled_round=next_round and completed_at is null;
  end if;
  return jsonb_build_object('card',public.lingo_review_card(p_user,p_card)||jsonb_build_object('reviewed',true),'reviewed',true);
end $$;
create function public.lingo_review_mastery(p_user uuid,p_card uuid,p_point text,p_mastered boolean,p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare progress public.lingo_review_points; day date:=(p_now at time zone 'Asia/Shanghai')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,2));
  if p_mastered is null then raise exception 'INVALID_REVIEW_STATE'; end if;
  if not exists(select 1 from public.lingo_cards c join public.lingo_records r on r.id=c.record_id and r.user_id=c.user_id
    where c.id=p_card and c.user_id=p_user and c.point_key=p_point and r.deleted_at is null) then raise exception 'CARD_CHANGED'; end if;
  select * into progress from public.lingo_review_points where user_id=p_user and point_key=p_point for update;
  if p_mastered then
    update public.lingo_review_points set mastered_at=coalesce(mastered_at,p_now),updated_at=p_now where user_id=p_user and point_key=p_point;
  elsif progress.mastered_at is not null then
    update public.lingo_review_points set mastered_at=null,updated_at=p_now,
      review_round=case when progress.review_round=5 then 0 else review_round end,
      next_due_date=case when progress.review_round=5 then day+1 else next_due_date end,
      last_completed_at=case when progress.review_round=5 then null else last_completed_at end
      where user_id=p_user and point_key=p_point;
  end if;
  return jsonb_build_object('card',public.lingo_review_card(p_user,p_card));
end $$;

create or replace function public.lingo_make_batch(p_user uuid,p_now timestamptz default now()) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare day date:=(p_now at time zone 'Asia/Shanghai')::date; bid uuid; selected uuid[]; card_limit integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,2));
  select review_daily_limit into card_limit from public.lingo_settings where user_id=p_user and review_enabled;
  if not found then return null; end if;
  select id into bid from public.lingo_review_batches where user_id=p_user and local_date=day;
  if found then
    if public.lingo_batch_has_pending(p_user,bid) then
      insert into public.lingo_deliveries(batch_id,user_id,channel)
        select bid,p_user,'push' from public.lingo_settings where user_id=p_user and push_enabled
        on conflict(batch_id,channel) do nothing;
    end if;
    return bid;
  end if;
  select coalesce(array_agg(id order by next_due_date,first_learned_date,point_key),'{}'::uuid[]) into selected from (
    select candidate.id,p.next_due_date,p.first_learned_date,p.point_key
    from public.lingo_review_points p
      cross join lateral (
        select c.id from public.lingo_cards c join public.lingo_records r on r.id=c.record_id and r.user_id=c.user_id
        where c.user_id=p.user_id and c.point_key=p.point_key and c.local_date<day and r.deleted_at is null
          and r.payload->>'status'='complete'
        order by c.local_date,c.id limit 1
      ) candidate
    where p.user_id=p_user and p.mastered_at is null and p.review_round<5 and p.next_due_date<=day
    order by p.next_due_date,p.first_learned_date,p.point_key limit card_limit
  ) due;
  if cardinality(selected)=0 then return null; end if;
  insert into public.lingo_review_batches(user_id,local_date) values(p_user,day) returning id into bid;
  insert into public.lingo_review_items(batch_id,card_id,user_id,position,point_key,scheduled_round)
    select bid,c.id,p_user,n,c.point_key,p.review_round+1 from unnest(selected) with ordinality as chosen(id,n)
      join public.lingo_cards c on c.id=chosen.id and c.user_id=p_user
      join public.lingo_review_points p on p.user_id=c.user_id and p.point_key=c.point_key;
  -- Kept as selection telemetry only. Progress advances exclusively in review_complete.
  update public.lingo_cards set last_selected_at=p_now where user_id=p_user and id=any(selected);
  insert into public.lingo_deliveries(batch_id,user_id,channel)
    select bid,p_user,'push' from public.lingo_settings where user_id=p_user and push_enabled;
  return bid;
end $$;
create or replace function public.lingo_claim_delivery(p_batch uuid,p_channel text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare value public.lingo_deliveries;
begin
  if p_channel<>'push' then return null; end if;
  update public.lingo_deliveries d set status='sending',attempts=attempts+1,claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
    where batch_id=p_batch and channel=p_channel and attempts<3
      and (status in ('pending','failed') or (status='sending' and lease_until<now()))
      and exists(select 1 from public.lingo_settings s where s.user_id=d.user_id and s.review_enabled and s.push_enabled)
      and public.lingo_batch_has_pending(d.user_id,d.batch_id)
    returning * into value;
  if not found then return null; end if;
  return to_jsonb(value);
end $$;

-- These functions are service-only even though browser roles can read their own
-- rows. p_user is always derived from the verified JWT by app-api.
revoke all on function public.lingo_point_text(text),public.lingo_point_key(jsonb),public.lingo_sync_review_point(),
  public.lingo_review_card(uuid,uuid),public.lingo_review_cards(uuid,uuid),public.lingo_batch_has_pending(uuid,uuid),
  public.lingo_review_batch(uuid,uuid,date),public.lingo_review_complete(uuid,uuid,uuid,text,timestamptz),
  public.lingo_review_mastery(uuid,uuid,text,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.lingo_point_text(text),public.lingo_point_key(jsonb),public.lingo_sync_review_point(),
  public.lingo_review_card(uuid,uuid),public.lingo_review_cards(uuid,uuid),public.lingo_batch_has_pending(uuid,uuid),
  public.lingo_review_batch(uuid,uuid,date),public.lingo_review_complete(uuid,uuid,uuid,text,timestamptz),
  public.lingo_review_mastery(uuid,uuid,text,boolean,timestamptz) to service_role;

create or replace function public.lingo_backup_snapshot() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('format','lingo-cloud/1','captured_at',statement_timestamp(),'tables',jsonb_build_object(
    'lingo_records',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('image_path',case when r.deleted_at is null then r.image_path else null end,'payload',case when r.deleted_at is null then r.payload else jsonb_build_object('record_id',r.id,'revision',r.payload->'revision','deleted',true) end) order by r.id) from public.lingo_records r),'[]'::jsonb),
    'lingo_requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.user_id,r.id) from public.lingo_requests r),'[]'::jsonb),
    'lingo_settings',coalesce((select jsonb_agg(to_jsonb(r) order by r.user_id) from public.lingo_settings r),'[]'::jsonb),
    'lingo_cards',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.lingo_cards r),'[]'::jsonb),
    'lingo_review_points',coalesce((select jsonb_agg(to_jsonb(r) order by r.user_id,r.point_key) from public.lingo_review_points r),'[]'::jsonb),
    'lingo_review_batches',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.lingo_review_batches r),'[]'::jsonb),
    'lingo_review_items',coalesce((select jsonb_agg(to_jsonb(r) order by r.batch_id,r.position) from public.lingo_review_items r),'[]'::jsonb),
    'lingo_deliveries',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('claim_token',null,'lease_until',null) order by r.batch_id,r.channel) from public.lingo_deliveries r),'[]'::jsonb)
  ))
$$;
create or replace function public.lingo_restore_check(p_users uuid[]) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.lingo_records) or exists(select 1 from public.lingo_requests)
    or exists(select 1 from public.lingo_settings) or exists(select 1 from public.lingo_cards)
    or exists(select 1 from public.lingo_review_points) or exists(select 1 from public.lingo_review_batches)
    or exists(select 1 from public.lingo_review_items) or exists(select 1 from public.lingo_deliveries)
    or exists(select 1 from public.lingo_push_subscriptions) or exists(select 1 from lingo_private.user_keys)
    then raise exception 'RESTORE_TARGET_NOT_EMPTY'; end if;
  if exists(select 1 from storage.objects where bucket_id='lingo-images') then raise exception 'RESTORE_BUCKET_NOT_EMPTY'; end if;
  if exists(select 1 from unnest(p_users) u where not exists(select 1 from auth.users a where a.id=u)) then raise exception 'RESTORE_AUTH_USER_MISSING'; end if;
  return jsonb_build_object('empty',true,'users_verified',cardinality(p_users));
end $$;
create or replace function public.lingo_restore_empty(p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t text; row jsonb; owner uuid; occupied boolean; columns_expected text[]; settings_rows jsonb;
begin
  if p_snapshot->>'format'<>'lingo-cloud/1' or jsonb_typeof(p_snapshot->'tables')<>'object' then raise exception 'INVALID_BACKUP_FORMAT'; end if;
  columns_expected:=array['lingo_records','lingo_requests','lingo_settings','lingo_cards','lingo_review_batches','lingo_review_items','lingo_deliveries'];
  if p_snapshot->'tables' ? 'lingo_review_points' then columns_expected:=columns_expected||'lingo_review_points'::text; end if;
  if (select array_agg(key order by key) from jsonb_object_keys(p_snapshot->'tables') key)
    is distinct from (select array_agg(value order by value) from unnest(columns_expected) value) then raise exception 'INVALID_BACKUP_TABLES'; end if;
  lock table public.lingo_records,public.lingo_requests,public.lingo_settings,public.lingo_push_subscriptions,public.lingo_cards,
    public.lingo_review_points,public.lingo_review_batches,public.lingo_review_items,public.lingo_deliveries,lingo_private.user_keys in access exclusive mode;
  if exists(select 1 from public.lingo_push_subscriptions) or exists(select 1 from lingo_private.user_keys)
    or exists(select 1 from public.lingo_review_points) then raise exception 'RESTORE_TARGET_NOT_EMPTY'; end if;
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
  select coalesce(jsonb_agg(value||jsonb_build_object('font_theme',coalesce(value->>'font_theme','refined'),
    'explanation_language',coalesce(value->>'explanation_language','zh'),'email_enabled',false,
    'review_daily_limit',coalesce((value->>'review_daily_limit')::integer,5))),'[]'::jsonb)
    into settings_rows from jsonb_array_elements(p_snapshot->'tables'->'lingo_settings');
  insert into public.lingo_records select * from jsonb_populate_recordset(null::public.lingo_records,p_snapshot->'tables'->'lingo_records');
  insert into public.lingo_requests select * from jsonb_populate_recordset(null::public.lingo_requests,p_snapshot->'tables'->'lingo_requests');
  insert into public.lingo_settings select * from jsonb_populate_recordset(null::public.lingo_settings,settings_rows);
  if p_snapshot->'tables' ? 'lingo_review_points' then
    insert into public.lingo_review_points select * from jsonb_populate_recordset(null::public.lingo_review_points,p_snapshot->'tables'->'lingo_review_points');
  end if;
  -- The card trigger derives missing legacy identities. It never treats old
  -- last_selected_at or opened_at as completed reviews.
  insert into public.lingo_cards select * from jsonb_populate_recordset(null::public.lingo_cards,p_snapshot->'tables'->'lingo_cards');
  insert into public.lingo_review_batches select * from jsonb_populate_recordset(null::public.lingo_review_batches,p_snapshot->'tables'->'lingo_review_batches');
  insert into public.lingo_review_items(batch_id,card_id,user_id,position,point_key,scheduled_round,completed_at)
    select (value->>'batch_id')::uuid,(value->>'card_id')::uuid,(value->>'user_id')::uuid,(value->>'position')::integer,
      coalesce(value->>'point_key',c.point_key),coalesce((value->>'scheduled_round')::smallint,1),(value->>'completed_at')::timestamptz
    from jsonb_array_elements(p_snapshot->'tables'->'lingo_review_items') item
      left join public.lingo_cards c on c.id=(item.value->>'card_id')::uuid;
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
revoke all on function public.lingo_backup_snapshot(),public.lingo_restore_check(uuid[]),public.lingo_restore_empty(jsonb) from public,anon,authenticated;
grant execute on function public.lingo_backup_snapshot(),public.lingo_restore_check(uuid[]),public.lingo_restore_empty(jsonb) to service_role;
