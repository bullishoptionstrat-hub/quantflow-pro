-- QuantFlow Pro — Supabase Schema + RLS Policies
-- Run this in the Supabase SQL editor for your project.

-- ─── Extensions ──────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ─── Tables ──────────────────────────────────────────────────────────────────

-- User profiles (extends Supabase auth.users)
create table if not exists public.user_profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  avatar_url    text,
  tier          text not null default 'free' check (tier in ('free', 'pro', 'elite')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- API key storage (encrypted at rest via Supabase vault in production)
create table if not exists public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider      text not null,   -- 'tradier' | 'polygon' | 'alpaca' | 'finnhub' | etc.
  key_name      text not null,   -- display label
  key_value     text not null,   -- should be encrypted in production
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, provider)
);

-- Personal watchlist
create table if not exists public.watchlist (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  symbol        text not null,
  label         text,
  alert_premium numeric(12, 2),   -- alert when premium exceeds this
  alert_heat    int,              -- alert when heat score exceeds this
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  unique (user_id, symbol)
);

-- Saved flow filters/screens
create table if not exists public.saved_filters (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  filter_json   jsonb not null default '{}',
  is_default    boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Power alerts log (persisted for history)
create table if not exists public.power_alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  symbol        text not null,
  type          text not null,   -- 'SWEEP' | 'BLOCK' | 'UNUSUAL'
  premium       numeric(16, 2),
  heat_score    int,
  unusual_score int,
  event_json    jsonb,
  read          boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Cached price history (populated by backend worker)
create table if not exists public.price_history (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null,
  interval      text not null default '1d',  -- '1m' | '5m' | '1h' | '1d'
  open          numeric(12, 4),
  high          numeric(12, 4),
  low           numeric(12, 4),
  close         numeric(12, 4),
  volume        bigint,
  timestamp     timestamptz not null,
  unique (symbol, interval, timestamp)
);

-- Flow events archive (for backtesting and ML training)
create table if not exists public.flow_archive (
  id            text primary key,  -- from ingestion pipeline
  symbol        text not null,
  expiration    date,
  strike        numeric(12, 4),
  call_put      char(1) check (call_put in ('C', 'P')),
  flow_type     text check (flow_type in ('SWEEP', 'BLOCK', 'SPLIT')),
  size          int,
  premium       numeric(16, 2),
  heat_score    int,
  unusual_score int,
  sentiment     text check (sentiment in ('bullish', 'bearish', 'neutral')),
  source        text,
  bid           numeric(12, 4),
  ask           numeric(12, 4),
  iv            numeric(8, 4),
  event_at      timestamptz not null,
  created_at    timestamptz not null default now()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

create index if not exists idx_api_keys_user_id on public.api_keys(user_id);
create index if not exists idx_watchlist_user_id on public.watchlist(user_id);
create index if not exists idx_watchlist_symbol on public.watchlist(symbol);
create index if not exists idx_power_alerts_user_id on public.power_alerts(user_id);
create index if not exists idx_power_alerts_created_at on public.power_alerts(created_at desc);
create index if not exists idx_price_history_symbol on public.price_history(symbol, interval, timestamp desc);
create index if not exists idx_flow_archive_symbol on public.flow_archive(symbol, event_at desc);
create index if not exists idx_flow_archive_event_at on public.flow_archive(event_at desc);

-- ─── Row Level Security ───────────────────────────────────────────────────────

alter table public.user_profiles enable row level security;
alter table public.api_keys enable row level security;
alter table public.watchlist enable row level security;
alter table public.saved_filters enable row level security;
alter table public.power_alerts enable row level security;
alter table public.price_history enable row level security;
alter table public.flow_archive enable row level security;

-- user_profiles: users see/edit only their own
create policy "user_profiles_select_own" on public.user_profiles
  for select using (auth.uid() = id);

create policy "user_profiles_insert_own" on public.user_profiles
  for insert with check (auth.uid() = id);

create policy "user_profiles_update_own" on public.user_profiles
  for update using (auth.uid() = id);

-- api_keys: users manage only their own keys
create policy "api_keys_select_own" on public.api_keys
  for select using (auth.uid() = user_id);

create policy "api_keys_insert_own" on public.api_keys
  for insert with check (auth.uid() = user_id);

create policy "api_keys_update_own" on public.api_keys
  for update using (auth.uid() = user_id);

create policy "api_keys_delete_own" on public.api_keys
  for delete using (auth.uid() = user_id);

-- watchlist: users manage only their own
create policy "watchlist_select_own" on public.watchlist
  for select using (auth.uid() = user_id);

create policy "watchlist_insert_own" on public.watchlist
  for insert with check (auth.uid() = user_id);

create policy "watchlist_update_own" on public.watchlist
  for update using (auth.uid() = user_id);

create policy "watchlist_delete_own" on public.watchlist
  for delete using (auth.uid() = user_id);

-- saved_filters: users manage only their own
create policy "saved_filters_select_own" on public.saved_filters
  for select using (auth.uid() = user_id);

create policy "saved_filters_insert_own" on public.saved_filters
  for insert with check (auth.uid() = user_id);

create policy "saved_filters_update_own" on public.saved_filters
  for update using (auth.uid() = user_id);

create policy "saved_filters_delete_own" on public.saved_filters
  for delete using (auth.uid() = user_id);

-- power_alerts: users see their own OR global (user_id is null)
create policy "power_alerts_select" on public.power_alerts
  for select using (auth.uid() = user_id or user_id is null);

create policy "power_alerts_update_own" on public.power_alerts
  for update using (auth.uid() = user_id);

-- price_history: public read, service role writes
create policy "price_history_public_read" on public.price_history
  for select using (true);

-- flow_archive: public read, service role writes
create policy "flow_archive_public_read" on public.flow_archive
  for select using (true);

-- ─── Functions ───────────────────────────────────────────────────────────────

-- Auto-update updated_at
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.handle_updated_at();

create trigger set_api_keys_updated_at
  before update on public.api_keys
  for each row execute function public.handle_updated_at();

-- Auto-create user profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
