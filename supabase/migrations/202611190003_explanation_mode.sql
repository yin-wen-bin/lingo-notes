-- Explanation preference applies to new requests only. OCR stays fast.
alter table public.lingo_settings add column explanation_mode text not null default 'fast'
  check(explanation_mode in ('fast','thinking'));

create or replace function public.lingo_begin(p_user uuid,p_id uuid,p_record uuid,p_action text,p_hash text,p_material jsonb,p_revision integer default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare request public.lingo_requests; rec public.lingo_records; initial boolean; body jsonb; rev integer; selected_mode text;
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
  body:=body||jsonb_build_object('request_id',p_id,'revision',rev,'status','processing','error',null,'error_details',null,'usage',null,'explanation_mode',selected_mode,'provider','deepseek','model','deepseek-flash','template_version','lingo-cloud-3');
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
