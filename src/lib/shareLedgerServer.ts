/**
 * @file shareLedgerServer.ts
 * @description Server-only helper to decode a ShareLinkAdapter-encoded ledger.
 * Uses Node's zlib for gzip decompression. Do not import into browser components.
 */

import { gunzipSync } from 'node:zlib';
import { TabLedger, AllocationRule, ItemCategory } from '@/types/tab';
import { normalizeLedger } from '@/lib/ledgerUtils';

type RawParticipant = { i?: unknown; n?: unknown; c?: unknown; h?: unknown };
type RawLedger = {
  i?: unknown;
  t?: unknown;
  m?: unknown;
  d?: unknown;
  pe?: unknown;
  p?: RawParticipant[];
  tx?: unknown;
  tp?: unknown;
  tr?: unknown;
  st?: unknown;
  tt?: unknown;
  dc?: unknown;
  sc?: unknown;
  ro?: unknown;
  ti?: unknown;
  ty?: unknown;
  tpct?: unknown;
  v?: unknown;
  rw?: Array<Record<string, unknown>>;
};

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function decodeShareLedger(encoded: string): TabLedger | null {
  try {
    let json = '';
    if (encoded.startsWith('g:')) {
      const base64Url = encoded.slice(2);
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      json = gunzipSync(Buffer.from(padded, 'base64')).toString('utf8');
    } else {
      const cleanB64 = decodeURIComponent(encoded).replace(/ /g, '+');
      json = Buffer.from(cleanB64, 'base64').toString('utf8');
      if (json.startsWith('%7B') || json.startsWith('%25') || json.includes('%22')) {
        try {
          json = decodeURIComponent(json);
        } catch {}
      }
    }

    const data: RawLedger = JSON.parse(json);
    if (!data || typeof data !== 'object') return null;

    const decodedParticipants: Array<{
      id: string;
      name: string;
      color?: string;
      isHost?: boolean;
    }> = (Array.isArray(data.p) ? data.p : [])
      .filter((p) => p && typeof p.n === 'string' && p.n.trim())
      .map((p) => ({
        id: typeof p.i === 'string' && p.i ? p.i : `p_${String(p.n).trim().toLowerCase().replace(/\s+/g, '_')}`,
        name: String(p.n).trim(),
        color: typeof p.c === 'string' ? p.c : undefined,
        isHost: p.h === true,
      }));

    const subtotalCents = toNumber(data.st);
    const taxRate = subtotalCents > 0 ? toNumber(data.tx) / subtotalCents : 0;

    let decodedRows: Array<{
      id: string;
      description: string;
      quantity: number;
      amountCents: number;
      assignedTo: string;
      taxPct: number;
      isTaxInclusive: boolean;
      allocationRule?: AllocationRule | undefined;
      ruleSummary?: string;
    }> = [];
    let decodedItems: Array<{
      id: string;
      name: string;
      priceCents: number;
      quantity: number;
      assignedTo: string[];
      category: ItemCategory;
      isTaxInclusive: boolean;
      allocationRule?: AllocationRule | undefined;
      ruleSummary?: string;
    }> = [];

    if (data.rw && Array.isArray(data.rw) && data.rw.length > 0) {
      decodedRows = data.rw
        .filter((r) => r && typeof r === 'object')
        .map((r, idx) => ({
          id: r.i ? String(r.i) : `item_${idx + 1}`,
          description: String(r.d ?? 'Item'),
          quantity: toNumber(r.q, 1) || 1,
          amountCents: Math.round(toNumber(r.a)),
          assignedTo: typeof r.as === 'string' ? r.as : (Array.isArray(r.as) ? (r.as.length === 1 ? String(r.as[0]) : 'split') : 'split'),
          taxPct: toNumber(r.tx, taxRate),
          isTaxInclusive: Boolean(r.ti ?? data.ti ?? false),
          allocationRule: (r.ar && typeof r.ar === 'object' ? r.ar : undefined) as AllocationRule | undefined,
          ruleSummary: typeof r.rs === 'string' ? r.rs : undefined,
        }));

      decodedItems = decodedRows.map((r) => {
        let assignedList: string[] = [];
        if (r.assignedTo && r.assignedTo !== 'split' && r.assignedTo !== 'everyone') {
          const found = decodedParticipants.find(
            (pp) => pp.name.toLowerCase() === r.assignedTo.toLowerCase() || pp.id === r.assignedTo
          );
          assignedList = [found ? found.id : r.assignedTo];
        }
        return {
          id: r.id,
          name: r.description,
          priceCents: r.amountCents,
          quantity: r.quantity || 1,
          assignedTo: assignedList,
          category: 'general' as ItemCategory,
          isTaxInclusive: r.isTaxInclusive,
          allocationRule: r.allocationRule as AllocationRule | undefined,
          ruleSummary: r.ruleSummary,
        };
      });
    }

    if (decodedRows.length === 0) return null;

    return normalizeLedger({
      id: data.i ? String(data.i) : `tab_${Date.now()}`,
      title: String(data.t || data.m || 'Shared Tab'),
      merchant: String(data.m ?? ''),
      date: String(data.d || new Date().toISOString().split('T')[0]),
      payeeEmail: typeof data.pe === 'string' && data.pe.trim() ? data.pe.trim() : undefined,
      items: decodedItems,
      participants: decodedParticipants,
      taxCents: toNumber(data.tx),
      tipCents: toNumber(data.tp),
      tipAllocationRule: (data.tr && typeof data.tr === 'object' ? data.tr : undefined) as unknown as AllocationRule | undefined,
      subtotalCents,
      totalCents: toNumber(data.tt),
      discountCents: toNumber(data.dc),
      serviceChargeCents: toNumber(data.sc),
      roundOffCents: toNumber(data.ro),
      isTaxInclusive: Boolean(data.ti ?? false),
      taxType: data.ty === 'inclusive' || data.ty === 'exclusive' || data.ty === 'none' ? data.ty : undefined,
      taxPercentage: data.tpct === undefined ? undefined : toNumber(data.tpct),
      schemaVersion: toNumber(data.v, 1) || 1,
      rows: decodedRows,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } catch {
    return null;
  }
}
