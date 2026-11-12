-- VoxTab persistent storage schema (Supabase Postgres)
-- Run this in the Supabase SQL Editor.
--
-- NOTE: Do not add public/anonymous access policies here. Server-side routes access
-- these tables using the service-role key via src/lib/supabaseAdmin.ts.

create table if not exists public.voxtab_shares (
  code text primary key,
  encoded text not null,
  ledger_snapshot jsonb not null,
  currency_code text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.voxtab_paypal_orders (
  order_id text primary key,
  share_code text not null references public.voxtab_shares(code),
  tab_id text not null,
  participant_name text not null,
  amount_cents bigint not null check (amount_cents > 0),
  currency_code text not null,
  requested_payee_email text,
  payee_mode text not null
    check (payee_mode in ('custom', 'sandbox_fallback')),
  capture_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_voxtab_paypal_orders_tab_id
  on public.voxtab_paypal_orders(tab_id);

-- Legacy payment-status table. Kept unchanged for historical records.
-- It is keyed by (tab_id, participant_key) and does not record which
-- share code a payment belongs to. Historical rows are NOT migrated,
-- copied, or assigned a share code, because that mapping is unknown.
create table if not exists public.voxtab_payment_status (
  tab_id text not null,
  participant_key text not null,
  is_paid boolean not null default false,
  paid_at timestamptz,
  paypal_tx_id text,
  source text check (source in ('manual', 'paypal')),
  primary key (tab_id, participant_key)
);

-- Version-specific PayPal payment statuses.
-- Keyed by (share_code, participant_key) so that payments made against
-- one bill snapshot never leak into a different snapshot of the same tab.
-- Only server-verified PayPal payments are stored here. Manual marks stay
-- local to the browser and are never written to this table.
create table if not exists public.voxtab_payment_status_v2 (
  share_code text not null,
  participant_key text not null,
  is_paid boolean not null default false,
  paid_at timestamptz,
  paypal_tx_id text,
  source text not null default 'paypal' check (source = 'paypal'),
  created_at timestamptz not null default now(),
  primary key (share_code, participant_key),
  foreign key (share_code) references public.voxtab_shares(code)
);

alter table public.voxtab_shares enable row level security;
alter table public.voxtab_paypal_orders enable row level security;
alter table public.voxtab_payment_status enable row level security;
alter table public.voxtab_payment_status_v2 enable row level security;
