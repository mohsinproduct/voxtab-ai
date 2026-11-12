/**
 * @file shortLinkStore.ts
 * @description Server-side storage backed by Supabase (persistent) with an in-memory fallback.
 *
 * Replaces the temporary filesystem / os.tmpdir() JSON files and in-memory Maps.
 * All operations are async and surface errors instead of swallowing them.
 *
 * PayPal-verified payment statuses are written to Supabase first. On success, they are
 * also mirrored to an in-memory fallback map on globalThis (__voxtabPaidFallbackMap)
 * for fast reads. If Supabase upsert fails, saveServerPaidStatus throws so the API
 * can report paid: false with a 503 — it never fails closed after PayPal has captured.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { TabLedger } from '@/types/tab';

export const PAYPAL_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'SGD', 'CHF']);

/**
 * In-memory fallback for PayPal-verified payment statuses.
 * Keyed by share_code, then participant_key, mapping to ServerPaidStatus.
 * Survives across hot reloads within the same server process but not across restarts.
 */
const getFallbackMap = (): Map<string, Map<string, ServerPaidStatus>> => {
  const fallback = (globalThis as { __voxtabPaidFallbackMap?: Map<string, Map<string, ServerPaidStatus>> }).__voxtabPaidFallbackMap;
  if (fallback) return fallback;
  const map = new Map<string, Map<string, ServerPaidStatus>>();
  (globalThis as { __voxtabPaidFallbackMap?: Map<string, Map<string, ServerPaidStatus>> }).__voxtabPaidFallbackMap = map;
  return map;
};

export interface ServerPaidStatus {
  isPaid: boolean;
  paidAt?: number;
  paypalTxId?: string;
  source: 'paypal';
}

export type ServerOrderRecord = {
  orderId: string;
  shareCode: string;
  tabId: string;
  participantName: string;
  amountCents: number;
  currencyCode: string;
  requestedPayeeEmail?: string;
  payeeMode: 'custom' | 'sandbox_fallback';
  createdAt: number;
};

export interface ServerShareRecord {
  code: string;
  encoded: string;
  ledgerSnapshot: TabLedger;
  currencyCode: string;
  createdAt: number;
}

export async function saveServerShare(record: ServerShareRecord): Promise<void> {
  const { error } = await supabaseAdmin
    .from('voxtab_shares')
    .insert({
      code: record.code,
      encoded: record.encoded,
      ledger_snapshot: record.ledgerSnapshot,
      currency_code: record.currencyCode,
      created_at: new Date(record.createdAt).toISOString(),
    });

  if (error) {
    throw new Error(`Could not save share record: ${error.message}`);
  }
}

export async function getServerShareByCode(code: string): Promise<ServerShareRecord | null> {
  const { data, error } = await supabaseAdmin
    .from('voxtab_shares')
    .select('code, encoded, ledger_snapshot, currency_code, created_at')
    .eq('code', code)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load share record: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  return {
    code: data.code,
    encoded: data.encoded,
    ledgerSnapshot: data.ledger_snapshot,
    currencyCode: data.currency_code,
    createdAt: new Date(data.created_at).getTime(),
  };
}

export async function saveServerOrder(record: ServerOrderRecord): Promise<void> {
  const { error } = await supabaseAdmin
    .from('voxtab_paypal_orders')
    .insert({
      order_id: record.orderId,
      share_code: record.shareCode,
      tab_id: record.tabId,
      participant_name: record.participantName,
      amount_cents: record.amountCents,
      currency_code: record.currencyCode,
      requested_payee_email: record.requestedPayeeEmail ?? null,
      payee_mode: record.payeeMode,
      created_at: new Date(record.createdAt).toISOString(),
    });

  if (error) {
    throw new Error(`Could not save PayPal order: ${error.message}`);
  }
}

export async function findServerOrderById(orderId: string): Promise<ServerOrderRecord | null> {
  const { data, error } = await supabaseAdmin
    .from('voxtab_paypal_orders')
    .select('order_id, share_code, tab_id, participant_name, amount_cents, currency_code, requested_payee_email, payee_mode, created_at')
    .eq('order_id', orderId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load PayPal order: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  return {
    orderId: data.order_id,
    shareCode: data.share_code,
    tabId: data.tab_id,
    participantName: data.participant_name,
    amountCents: data.amount_cents,
    currencyCode: data.currency_code,
    requestedPayeeEmail: data.requested_payee_email ?? undefined,
    payeeMode: data.payee_mode,
    createdAt: new Date(data.created_at).getTime(),
  };
}

export async function saveServerPaidStatus(
  shareCode: string,
  participantName: string,
  status: ServerPaidStatus
): Promise<void> {
  if (!shareCode || !shareCode.trim()) {
    throw new Error('shareCode is required');
  }
  if (!participantName || !participantName.trim()) {
    throw new Error('participantName is required');
  }

  const participantKey = participantName.trim().toLowerCase();

  // Server table stores PayPal-verified statuses only (CHECK source = 'paypal').
  // Manual payment statuses must remain local-only; only PayPal-verified records are
  // stored server-side, here and in the in-memory fallback map.
  if (status.source !== 'paypal') {
    throw new Error('Only PayPal-verified payment records may be stored server-side');
  }

  // Supabase upsert is required before the status is considered persisted.
  // If the upsert returns an error or throws, propagate the failure so the API
  // can report paid: false with a 503. The in-memory fallback must never make
  // a failed database write appear successfully persisted.
  const { error } = await supabaseAdmin
    .from('voxtab_payment_status_v2')
    .upsert(
      {
        share_code: shareCode,
        participant_key: participantKey,
        is_paid: status.isPaid,
        paid_at: status.paidAt ? new Date(status.paidAt).toISOString() : null,
        paypal_tx_id: status.paypalTxId ?? null,
        source: status.source ?? 'paypal',
      },
      { onConflict: 'share_code,participant_key' }
    );

  if (error) {
    throw new Error(`Could not save payment status: ${error.message}`);
  }

  // Only write to the in-memory fallback map after Supabase succeeds, so a verified
  // PayPal status is available for fast reads even after a server restart.
  try {
    const fallback = getFallbackMap();
    const shareKey = shareCode.trim();
    let byParticipant = fallback.get(shareKey);
    if (!byParticipant) {
      byParticipant = new Map();
      fallback.set(shareKey, byParticipant);
    }
    byParticipant.set(participantKey, {
      isPaid: status.isPaid,
      paidAt: status.paidAt,
      paypalTxId: status.paypalTxId,
      source: status.source,
    });
  } catch (fallbackError) {
    console.warn('[shortLinkStore] In-memory fallback write failed:', fallbackError);
  }
}

export async function getServerPaidStatusesByShareCode(
  shareCode: string
): Promise<Record<string, ServerPaidStatus>> {
  if (!shareCode || !shareCode.trim()) {
    throw new Error('shareCode is required');
  }

  const { data, error } = await supabaseAdmin
    .from('voxtab_payment_status_v2')
    .select('participant_key, is_paid, paid_at, paypal_tx_id, source')
    .eq('share_code', shareCode);

  if (error) {
    throw new Error(`Could not load payment statuses for share ${shareCode}: ${error.message}`);
  }

  const paid: Record<string, ServerPaidStatus> = {};

  // Merge in-memory fallback entries so statuses written before the Supabase migration
  // are still visible to clients.
  const fallback = getFallbackMap().get(shareCode.trim());
  if (fallback) {
    for (const [key, rec] of fallback) {
      paid[key] = {
        isPaid: rec.isPaid,
        paidAt: rec.paidAt,
        paypalTxId: rec.paypalTxId,
        source: rec.source,
      };
    }
  }

  for (const row of (data ?? [])) {
    paid[row.participant_key] = {
      isPaid: row.is_paid,
      paidAt: row.paid_at ? new Date(row.paid_at).getTime() : undefined,
      paypalTxId: row.paypal_tx_id ?? undefined,
      source: row.source ?? 'paypal',
    };
  }

  return paid;
}
