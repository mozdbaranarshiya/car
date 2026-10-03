-- All personal data and authentication state live outside exposed API schemas.
-- Only the server's service_role may invoke the public RPC. There are no anon
-- or authenticated policies, table grants, or client-side database credentials.
create schema if not exists radyabi_private;
revoke all on schema radyabi_private from public, anon, authenticated, service_role;

create table radyabi_private.admin (
  id smallint primary key check (id = 1), username text not null, password text not null,
  totp text not null, last_step bigint not null default -1
);
create table radyabi_private.setup_pending (
  id smallint primary key check (id = 1), hash text not null,
  username text not null, password text not null, secret text not null, expires bigint not null
);
create table radyabi_private.challenges (
  hash text primary key, expires bigint not null, attempts integer not null default 0
);
create table radyabi_private.sessions (hash text primary key, expires bigint not null);
create table radyabi_private.limits (category text primary key, count integer not null, resets bigint not null);
create table radyabi_private.devices (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{43}$'), token_hash text unique not null,
  name text not null check (length(name) between 2 and 80),
  phone text not null check (phone ~ '^09[0-9]{9}$'),
  consent boolean not null, disclosure_version integer not null check (disclosure_version = 1),
  consent_at bigint not null, created_at bigint not null,
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  accuracy double precision check (accuracy between 0 and 50000),
  captured_at bigint, received_at bigint, battery integer check (battery between 0 and 100)
);
create index devices_phone on radyabi_private.devices(phone, created_at desc);
create index devices_created on radyabi_private.devices(created_at desc);
alter table radyabi_private.admin enable row level security;
alter table radyabi_private.setup_pending enable row level security;
alter table radyabi_private.challenges enable row level security;
alter table radyabi_private.sessions enable row level security;
alter table radyabi_private.limits enable row level security;
alter table radyabi_private.devices enable row level security;
revoke all on all tables in schema radyabi_private from public, anon, authenticated, service_role;

create function radyabi_private.profile(d radyabi_private.devices) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'name', d.name, 'phone', d.phone, 'consent', d.consent,
    'latitude', d.latitude, 'longitude', d.longitude, 'accuracy', d.accuracy,
    'capturedAt', d.captured_at, 'receivedAt', d.received_at, 'battery', d.battery);
$$;
revoke all on function radyabi_private.profile(radyabi_private.devices) from public, anon, authenticated, service_role;

create function public.radyabi_store(operation text, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  pending radyabi_private.setup_pending;
  manager radyabi_private.admin;
  challenge radyabi_private.challenges;
  device radyabi_private.devices;
  allowed boolean;
  counter integer;
  values_json jsonb;
begin
  case operation
  when 'rate' then
    delete from radyabi_private.limits where resets <= now_ms;
    insert into radyabi_private.limits(category, count, resets)
      values (args->>'category', 1, now_ms + (args->>'interval')::bigint)
      on conflict (category) do update set count = radyabi_private.limits.count + 1
      returning count into counter;
    return to_jsonb(counter <= (args->>'maximum')::integer);
  when 'status' then
    return to_jsonb(exists(select 1 from radyabi_private.admin where id = 1));
  when 'admin' then
    select * into manager from radyabi_private.admin where id = 1;
    if not found then return null; end if;
    return to_jsonb(manager);
  when 'setup-start' then
    perform pg_advisory_xact_lock(1770716001);
    if exists(select 1 from radyabi_private.admin where id = 1) then return 'false'::jsonb; end if;
    insert into radyabi_private.setup_pending values
      (1, args->>'hash', args->>'username', args->>'password', args->>'secret', now_ms + 600000)
      on conflict (id) do update set hash=excluded.hash, username=excluded.username,
        password=excluded.password, secret=excluded.secret, expires=excluded.expires;
    return 'true'::jsonb;
  when 'setup-pending' then
    select * into pending from radyabi_private.setup_pending
      where id = 1 and hash = args->>'hash' and expires > now_ms;
    if not found or exists(select 1 from radyabi_private.admin) then return null; end if;
    return to_jsonb(pending);
  when 'setup-confirm' then
    perform pg_advisory_xact_lock(1770716001);
    if exists(select 1 from radyabi_private.admin) then return 'false'::jsonb; end if;
    select * into pending from radyabi_private.setup_pending
      where id = 1 and hash = args->>'hash' and expires > now_ms for update;
    if not found then return 'false'::jsonb; end if;
    insert into radyabi_private.admin values
      (1, pending.username, pending.password, pending.secret, (args->>'step')::bigint);
    delete from radyabi_private.setup_pending where id = 1;
    return 'true'::jsonb;
  when 'challenge-create' then
    delete from radyabi_private.challenges where expires <= now_ms or attempts > 5;
    if (select count(*) from radyabi_private.challenges) >= 1000 then return 'false'::jsonb; end if;
    insert into radyabi_private.challenges(hash, expires) values(args->>'hash', now_ms + 300000);
    return 'true'::jsonb;
  when 'challenge-attempt' then
    update radyabi_private.challenges set attempts = attempts + 1
      where hash = args->>'hash' and expires > now_ms and attempts < 5 returning * into challenge;
    return to_jsonb(found);
  when 'verify' then
    select * into manager from radyabi_private.admin where id = 1 for update;
    if not found or (args->>'step')::bigint <= manager.last_step then return 'false'::jsonb; end if;
    select * into challenge from radyabi_private.challenges
      where hash = args->>'hash' and expires > now_ms and attempts between 1 and 5 for update;
    if not found then return 'false'::jsonb; end if;
    update radyabi_private.admin set last_step = (args->>'step')::bigint where id = 1;
    delete from radyabi_private.challenges where hash = args->>'hash';
    delete from radyabi_private.sessions where expires <= now_ms;
    insert into radyabi_private.sessions values(args->>'sessionHash', now_ms + 28800000);
    return 'true'::jsonb;
  when 'session' then
    return to_jsonb(exists(select 1 from radyabi_private.sessions where hash=args->>'hash' and expires > now_ms));
  when 'logout' then
    delete from radyabi_private.sessions where hash=args->>'hash'; return 'true'::jsonb;
  when 'register' then
    if not exists(select 1 from radyabi_private.admin) then raise exception 'Manager not configured'; end if;
    insert into radyabi_private.devices(id,token_hash,name,phone,consent,disclosure_version,consent_at,created_at)
      values(args->>'id',args->>'hash',args->>'name',args->>'phone',true,1,now_ms,now_ms);
    return 'true'::jsonb;
  when 'device' then
    select * into device from radyabi_private.devices where token_hash=args->>'hash';
    if not found then return null; end if;
    return radyabi_private.profile(device);
  when 'consent' then
    select * into device from radyabi_private.devices where token_hash=args->>'hash' for update;
    if not found then return 'false'::jsonb; end if;
    if (args->>'consent')::boolean then
      update radyabi_private.devices set consent=true, consent_at=now_ms, disclosure_version=1 where id=device.id;
    else
      update radyabi_private.devices set consent=false, latitude=null, longitude=null,
        accuracy=null, captured_at=null, received_at=null, battery=null where id=device.id;
    end if;
    return 'true'::jsonb;
  when 'location' then
    select * into device from radyabi_private.devices where token_hash=args->>'hash' for update;
    if not found then return '"unauthorized"'::jsonb; end if;
    if not device.consent then return '"revoked"'::jsonb; end if;
    if device.captured_at is not null and (args->>'capturedAt')::bigint < device.captured_at then return '"ignored"'::jsonb; end if;
    if (args->>'capturedAt')::bigint > now_ms+60000 or (args->>'capturedAt')::bigint < now_ms-172800000 then
      raise exception 'Invalid sample time';
    end if;
    update radyabi_private.devices set latitude=(args->>'latitude')::double precision,
      longitude=(args->>'longitude')::double precision, accuracy=(args->>'accuracy')::double precision,
      captured_at=(args->>'capturedAt')::bigint, received_at=now_ms, battery=(args->>'battery')::integer
      where id=device.id;
    return '"saved"'::jsonb;
  when 'people' then
    if not exists(select 1 from radyabi_private.sessions where hash=args->>'hash' and expires > now_ms) then return null; end if;
    select coalesce(jsonb_agg(radyabi_private.profile(d)), '[]'::jsonb) into values_json from
      (select * from radyabi_private.devices where args->>'phone' is null or phone=args->>'phone'
        order by created_at desc, id limit 1000) d;
    return values_json;
  else
    raise exception 'Unknown tracker operation';
  end case;
end;
$$;
revoke all on function public.radyabi_store(text, jsonb) from public, anon, authenticated;
grant execute on function public.radyabi_store(text, jsonb) to service_role;
comment on function public.radyabi_store(text, jsonb) is 'Server-only tracker RPC; credentials and location never available through the public client API.';
