-- Run ONLY after manual push and review verification. Prepare Vault secrets
-- lingo-cron-url and lingo-cron-secret without printing their values.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ declare job bigint; begin
  select jobid into job from cron.job where jobname='lingo-review-five-minutes';
  if job is not null then perform cron.unschedule(job); end if;
end $$;
select cron.schedule('lingo-review-five-minutes','*/5 * * * *',$job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='lingo-cron-url'),
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='lingo-cron-secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$job$);
