-- Stored display translations for Ask Prana chat history.
--
-- chat_messages.content is never modified: these tables hold the English /
-- Hindi / Telugu display copies so switching language is a database read
-- instead of a live OpenAI call. Like chat_messages, they are only accessed
-- by the Edge Functions with the service role.

create table if not exists public.chat_message_translations (
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  lang text not null check (lang in ('en', 'hi', 'te')),
  content text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, lang)
);

create table if not exists public.chat_session_translations (
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  lang text not null check (lang in ('en', 'hi', 'te')),
  title text,
  preview text,
  updated_at timestamptz not null default now(),
  primary key (session_id, lang)
);

-- Content-addressed cache: identical text is translated once per language.
create table if not exists public.translation_cache (
  text_hash text not null, -- sha256 hex of the trimmed source text
  lang text not null check (lang in ('en', 'hi', 'te')),
  content text not null,
  created_at timestamptz not null default now(),
  primary key (text_hash, lang)
);

alter table public.chat_message_translations enable row level security;
alter table public.chat_session_translations enable row level security;
alter table public.translation_cache enable row level security;

grant select, insert, update, delete on public.chat_message_translations to service_role;
grant select, insert, update, delete on public.chat_session_translations to service_role;
grant select, insert, update, delete on public.translation_cache to service_role;
