-- supabase/migrations/001_create_payment_status_v2.sql
-- Migration: Add version-specific PayPal payment status table (Approach A).
--
-- Rationale:
--   The legacy voxtab_payment_status table is keyed by (tab_id, participant_key).
--   Different versions of the same bill can share a tab ID but have different
--   share codes, so a payment made against an older snapshot could wrongly
--   appear as paid for a newer snapshot.
--
--   This migration creates voxtab_payment_status_v2, keyed by
--   (share_code, participant_key), so each bill snapshot has its own payment
--   statuses. It does not touch the legacy table, does not copy historical
--   records, and does not guess which share code an old payment belongs to.
--
--   New server-verified PayPal payments should be written to v2. Manual
--   payment marks remain local to the browser.

-- Ensure the shares table exists before creating the foreign key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'voxtab_shares'
  ) THEN
    RAISE EXCEPTION
      'public.voxtab_shares table does not exist. Create it before running this migration.';
  END IF;
END $$;

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

alter table public.voxtab_payment_status_v2 enable row level security;
