-- Ask Prana database schema.
-- Exported from the live "Ask_Prana_Generic_Assistant" Supabase project.
-- Run once in a NEW project: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- Safe to re-run (uses IF NOT EXISTS / ON CONFLICT).

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------- functions
create or replace function public.ask_prana_phone_canonical(raw text)
returns text
language plpgsql
immutable
as $function$
declare
  trimmed text;
  digits text;
begin
  if raw is null then
    return null;
  end if;
  trimmed := btrim(raw);
  if trimmed = '' then
    return null;
  end if;
  digits := regexp_replace(trimmed, '\D', '', 'g');
  if trimmed ~ '^\+' and digits ~ '^91[6-9][0-9]{9}$' then
    return '+' || digits;
  end if;
  if digits ~ '^0[6-9][0-9]{9}$' then
    return '+91' || substring(digits from 2);
  end if;
  if digits ~ '^[6-9][0-9]{9}$' then
    return '+91' || digits;
  end if;
  if digits ~ '^91[6-9][0-9]{9}$' then
    return '+' || digits;
  end if;
  if trimmed ~ '^\+' and digits ~ '^[1-9][0-9]{7,14}$' then
    return '+' || digits;
  end if;
  return null;
end;
$function$;

create or replace function public.ask_prana_normalize_user_identity()
returns trigger
language plpgsql
as $function$
begin
  if new.email is not null then
    new.email := lower(btrim(new.email));
    if new.email = '' then
      new.email := null;
    end if;
  end if;
  if new.phone is not null then
    new.phone := public.ask_prana_phone_canonical(new.phone);
  end if;
  return new;
end;
$function$;

-- ------------------------------------------------------------------- tables
create table if not exists public.users (
  id uuid default gen_random_uuid() not null,
  phone text,
  name text,
  state text,
  district text,
  language text default 'English'::text,
  avatar_url text,
  avatar_updated_at timestamp with time zone,
  is_deleted boolean default false not null,
  deleted_at timestamp with time zone,
  is_active boolean default true not null,
  email text,
  constraint users_pkey primary key (id),
  constraint users_email_normalized check (((email is null) or (email = lower(btrim(email)))))
);

create table if not exists public.user_sessions (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  token_hash text not null,
  expires_at timestamp with time zone not null,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  constraint user_sessions_pkey primary key (id),
  constraint user_sessions_token_hash_key unique (token_hash),
  constraint user_sessions_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade
);

create table if not exists public.chat_sessions (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  title text default 'New conversation'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint chat_sessions_pkey primary key (id),
  constraint chat_sessions_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade
);

create table if not exists public.chat_messages (
  id uuid default gen_random_uuid() not null,
  session_id uuid not null,
  user_id uuid not null,
  role text not null,
  content text not null,
  created_at timestamp with time zone default now() not null,
  message_type text default 'text'::text not null,
  file_path text,
  file_name text,
  mime_type text,
  constraint chat_messages_pkey primary key (id),
  constraint chat_messages_session_id_fkey foreign key (session_id) references public.chat_sessions(id) on delete cascade,
  constraint chat_messages_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade,
  constraint chat_messages_message_type_check check ((message_type = any (array['text'::text, 'image'::text, 'document'::text, 'audio'::text]))),
  constraint chat_messages_role_check check ((role = any (array['user'::text, 'assistant'::text])))
);

-- ------------------------------------------------------------------ indexes
create unique index if not exists users_phone_uidx on public.users using btree (phone) where ((phone is not null) and (btrim(phone) <> ''::text));
create unique index if not exists users_email_uidx on public.users using btree (email) where (email is not null);
create index if not exists user_sessions_active_user_idx on public.user_sessions using btree (user_id, expires_at) where (revoked_at is null);
create index if not exists chat_sessions_user_updated_idx on public.chat_sessions using btree (user_id, updated_at desc);
create index if not exists chat_messages_session_created_idx on public.chat_messages using btree (session_id, created_at);

-- ----------------------------------------------------------------- triggers
drop trigger if exists users_normalize_identity on public.users;
create trigger users_normalize_identity
  before insert or update of email, phone on public.users
  for each row execute function public.ask_prana_normalize_user_identity();

-- ----------------------------------------------------- row level security
-- The app never reads these tables with the anon key: every read/write goes
-- through the Edge Functions using the service role.
alter table public.users enable row level security;
alter table public.user_sessions enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "Users can read own row" on public.users;
create policy "Users can read own row" on public.users
  as permissive for select to authenticated using ((auth.uid() = id));
drop policy if exists "Users can insert own row" on public.users;
create policy "Users can insert own row" on public.users
  as permissive for insert to authenticated with check ((auth.uid() = id));
drop policy if exists "Users can update own row" on public.users;
create policy "Users can update own row" on public.users
  as permissive for update to authenticated using ((auth.uid() = id)) with check ((auth.uid() = id));

-- ------------------------------------------------------------------- grants
grant select, insert, update, delete on public.users to service_role;
grant select, insert, update, delete on public.user_sessions to service_role;
grant select, insert, update, delete on public.chat_sessions to service_role;
grant select, insert, update, delete on public.chat_messages to service_role;
grant select, insert, update on public.users to authenticated;

-- ------------------------------------------------------------------ storage
-- Public buckets: profile photos and chat attachments (uploaded by Edge Functions).
insert into storage.buckets (id, name, public) values ('profile-photos', 'profile-photos', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('ask-prana-files', 'ask-prana-files', true)
  on conflict (id) do nothing;
