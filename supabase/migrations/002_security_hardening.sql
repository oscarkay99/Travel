-- Server-side abuse controls. Raw IP addresses and contact details are never
-- stored here; the API sends keyed SHA-256 digests only.
create table if not exists rogernort.security_rate_limits (
  scope text not null,
  subject_hash text not null check (length(subject_hash) = 64),
  bucket_start timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  expires_at timestamptz not null,
  primary key (scope, subject_hash, bucket_start)
);

create index if not exists security_rate_limits_expiry_idx
  on rogernort.security_rate_limits (expires_at);

create table if not exists rogernort.submission_fingerprints (
  kind text not null check (kind in ('application', 'enquiry')),
  fingerprint text not null check (length(fingerprint) = 64),
  created_at timestamptz not null default now(),
  primary key (kind, fingerprint)
);

create index if not exists submission_fingerprints_created_idx
  on rogernort.submission_fingerprints (created_at);

alter table rogernort.security_rate_limits enable row level security;
alter table rogernort.submission_fingerprints enable row level security;

create or replace function rogernort.security_check_rate_limit(
  p_scope text,
  p_subject_hash text,
  p_window_seconds integer,
  p_limit integer
)
returns table (allowed boolean, remaining integer, retry_after integer)
language plpgsql
security definer
set search_path = rogernort, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_bucket timestamptz;
  v_count integer;
begin
  if p_scope !~ '^[a-z_]{3,40}$'
     or p_subject_hash !~ '^[0-9a-f]{64}$'
     or p_window_seconds < 1 or p_window_seconds > 86400
     or p_limit < 1 or p_limit > 10000 then
    raise exception 'invalid rate-limit parameters';
  end if;

  v_bucket := to_timestamp(
    floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds
  );

  delete from rogernort.security_rate_limits
    where expires_at < v_now - interval '1 day';

  insert into rogernort.security_rate_limits
    (scope, subject_hash, bucket_start, request_count, expires_at)
  values
    (p_scope, p_subject_hash, v_bucket, 1, v_bucket + make_interval(secs => p_window_seconds))
  on conflict (scope, subject_hash, bucket_start)
  do update set request_count = rogernort.security_rate_limits.request_count + 1
  returning request_count into v_count;

  allowed := v_count <= p_limit;
  remaining := greatest(p_limit - v_count, 0);
  retry_after := greatest(1, ceil(extract(epoch from ((v_bucket + make_interval(secs => p_window_seconds)) - v_now)))::integer);
  return next;
end;
$$;

create or replace function rogernort.security_register_submission(
  p_kind text,
  p_fingerprint text,
  p_ttl_seconds integer default 86400
)
returns table (accepted boolean)
language plpgsql
security definer
set search_path = rogernort, pg_temp
as $$
declare
  v_rows integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_kind not in ('application', 'enquiry')
     or p_fingerprint !~ '^[0-9a-f]{64}$'
     or p_ttl_seconds < 60 or p_ttl_seconds > 604800 then
    raise exception 'invalid submission parameters';
  end if;

  delete from rogernort.submission_fingerprints
    where created_at < v_now - interval '7 days';

  insert into rogernort.submission_fingerprints (kind, fingerprint, created_at)
  values (p_kind, p_fingerprint, v_now)
  on conflict (kind, fingerprint)
  do update set created_at = excluded.created_at
    where rogernort.submission_fingerprints.created_at
      <= v_now - make_interval(secs => p_ttl_seconds);

  get diagnostics v_rows = row_count;
  accepted := v_rows = 1;
  return next;
end;
$$;

create or replace function rogernort.security_forget_submission(
  p_kind text,
  p_fingerprint text
)
returns void
language plpgsql
security definer
set search_path = rogernort, pg_temp
as $$
begin
  if p_kind not in ('application', 'enquiry')
     or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid submission parameters';
  end if;
  delete from rogernort.submission_fingerprints
    where kind = p_kind and fingerprint = p_fingerprint;
end;
$$;

revoke all on table rogernort.security_rate_limits from public;
revoke all on table rogernort.submission_fingerprints from public;
revoke all on function rogernort.security_check_rate_limit(text, text, integer, integer) from public;
revoke all on function rogernort.security_register_submission(text, text, integer) from public;
revoke all on function rogernort.security_forget_submission(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table rogernort.security_rate_limits from anon';
    execute 'revoke all on table rogernort.submission_fingerprints from anon';
    if to_regclass('rogernort.applications') is not null then
      execute 'alter table rogernort.applications enable row level security';
      execute 'revoke all on table rogernort.applications from anon';
    end if;
    if to_regclass('rogernort.enquiries') is not null then
      execute 'alter table rogernort.enquiries enable row level security';
      execute 'revoke all on table rogernort.enquiries from anon';
    end if;
    if to_regclass('rogernort.agent_conversations') is not null then
      execute 'revoke all on table rogernort.agent_conversations from anon';
    end if;
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table rogernort.security_rate_limits from authenticated';
    execute 'revoke all on table rogernort.submission_fingerprints from authenticated';
    if to_regclass('rogernort.applications') is not null then
      execute 'revoke all on table rogernort.applications from authenticated';
    end if;
    if to_regclass('rogernort.enquiries') is not null then
      execute 'revoke all on table rogernort.enquiries from authenticated';
    end if;
    if to_regclass('rogernort.agent_conversations') is not null then
      execute 'revoke all on table rogernort.agent_conversations from authenticated';
    end if;
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema rogernort to service_role';
    execute 'grant select, insert, update, delete on table rogernort.security_rate_limits to service_role';
    execute 'grant select, insert, update, delete on table rogernort.submission_fingerprints to service_role';
    execute 'grant execute on function rogernort.security_check_rate_limit(text, text, integer, integer) to service_role';
    execute 'grant execute on function rogernort.security_register_submission(text, text, integer) to service_role';
    execute 'grant execute on function rogernort.security_forget_submission(text, text) to service_role';
  end if;
end
$$;

comment on table rogernort.security_rate_limits is
  'Fixed-window abuse counters keyed by HMAC digests; no raw IP addresses.';
comment on table rogernort.submission_fingerprints is
  'Short-lived HMAC fingerprints used to suppress duplicate public form submissions.';

notify pgrst, 'reload schema';
