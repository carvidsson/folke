-- Folke MVP 0.2 – private conversations.
--
-- Conversations are private to their owner. There is deliberately NO policy
-- that lets administrators read other users' conversations. The annual
-- retention review works on aggregated metadata only (see operations
-- migration: app.conversation_retention_summary / purge).

create type public.message_role as enum ('user', 'assistant');

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  assistant_id uuid not null references public.assistants (id),
  title text not null default 'Ny konversation' check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index conversations_user_idx on public.conversations (user_id, last_message_at desc);
create index conversations_last_message_idx on public.conversations (last_message_at);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role public.message_role not null,
  content text not null check (char_length(content) <= 100000),
  -- [{ id, documentId, title, excerpt, location }]
  sources jsonb not null default '[]'::jsonb,
  -- [{ name, mimeType, sizeBytes }] – metadata only
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);

create trigger conversations_touch before update on public.conversations
  for each row execute function app.touch_updated_at();

create function app.owns_conversation(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and exists (
    select 1 from public.conversations
    where id = p_conversation_id and user_id = auth.uid()
  )
$$;
grant execute on function app.owns_conversation(uuid) to authenticated, service_role;

-- Keep last_message_at current.
create function app.bump_conversation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set last_message_at = new.created_at
  where id = new.conversation_id;
  return new;
end $$;

create trigger messages_bump after insert on public.messages
  for each row execute function app.bump_conversation();

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
revoke all on public.conversations, public.messages from anon;
-- Messages are immutable once written.
revoke update on public.messages from authenticated;

create policy conversations_owner_select on public.conversations for select to authenticated
  using (user_id = auth.uid() and app.authorized());
create policy conversations_owner_insert on public.conversations for insert to authenticated
  with check (user_id = auth.uid() and app.can_use_assistant(assistant_id));
create policy conversations_owner_update on public.conversations for update to authenticated
  using (user_id = auth.uid() and app.authorized())
  with check (user_id = auth.uid());
create policy conversations_owner_delete on public.conversations for delete to authenticated
  using (user_id = auth.uid() and app.authorized());

create policy messages_owner_select on public.messages for select to authenticated
  using (app.owns_conversation(conversation_id));
create policy messages_owner_insert on public.messages for insert to authenticated
  with check (app.owns_conversation(conversation_id));
create policy messages_owner_delete on public.messages for delete to authenticated
  using (app.owns_conversation(conversation_id));

-- The assistant of a conversation never changes.
create function app.protect_conversation_columns() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.user_id <> old.user_id or new.assistant_id <> old.assistant_id then
    raise exception 'Konversationens ägare och assistent kan inte ändras' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger conversations_protect before update on public.conversations
  for each row execute function app.protect_conversation_columns();
