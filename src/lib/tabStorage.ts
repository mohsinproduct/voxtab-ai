/**
 * @file tabStorage.ts
 * @description Storage and stateless URL-sharing adapters for VoxTab.
 *
 * Design Pattern:
 * Implements the Adapter Pattern. Provides an abstract `TabStorageAdapter` interface
 * so that alternative persistence backends (e.g., Supabase, IndexedDB, PostgreSQL, Redis)
 * can be plugged in without changing frontend state management.
 *
 * Stateless Sharing:
 * Includes `ShareLinkAdapter` which serializes, minifies, and base64-encodes the entire
 * ledger state into the URL fragment (`/share#tab=...`), enabling zero-login peer-to-peer receipt
 * sharing. The fragment is never sent to the server, so large receipts cannot hit header-size limits.
 */

import { TabLedger, ReceiptItem, LedgerRow, Participant } from '@/types/tab';
import { APP_CONFIG, getPublicAppOrigin } from '@/config/appConfig';
import { ensureRows, normalizeLedger, LEDGER_SCHEMA_VERSION } from '@/lib/ledgerUtils';

/**
 * Record of participant payment status and settlement transaction metadata.
 */
export interface PaidStatusRecord {
  isPaid: boolean;
  paidAt?: number;
  paypalTxId?: string;
  source?: 'manual' | 'paypal';
}

/** Key for a participant's paid status: "Ali", "ali" and " Ali " are the same person. */
export function paidKey(name: string): string {
  return (name || '').trim().toLowerCase();
}

const MAX_SAVED_TABS = 30;
const ORDER_MAP_KEY = 'VOXTAB_ORDER_MAP';
const MAX_ORDER_ENTRIES = 100;
const ORDER_TTL_MS = 3 * 60 * 60 * 1000; // PayPal orders expire after ~3h unapproved

/** A PayPal order created by this browser, and which share it pays. */
export interface OrderEntry {
  tabId: string;
  person: string;
  amountCents?: number;
  approveUrl?: string;
  createdAt?: number;
  payeeMode?: 'custom' | 'sandbox_fallback';
  shareCode?: string | null;
}

function readOrderMap(): Record<string, OrderEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_MAP_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeOrderMap(map: Record<string, OrderEntry>) {
  try {
    // Keep only the newest entries so the map cannot grow without bound.
    const entries = Object.entries(map)
      .sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0))
      .slice(0, MAX_ORDER_ENTRIES);
    localStorage.setItem(ORDER_MAP_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

/** Order bookkeeping shared by the settle screen, the PayPal return page and deleteTab. */
export const orderMap = {
  remember(orderId: string, entry: OrderEntry) {
    if (typeof window === 'undefined') return;
    writeOrderMap({ ...readOrderMap(), [orderId]: { ...entry, createdAt: Date.now() } });
  },
  lookup(orderId: string): OrderEntry | null {
    if (typeof window === 'undefined') return null;
    return readOrderMap()[orderId] || null;
  },
  forget(orderId: string) {
    if (typeof window === 'undefined') return;
    const map = readOrderMap();
    if (!(orderId in map)) return;
    delete map[orderId];
    writeOrderMap(map);
  },
  /** An unexpired order this browser already created for the same tab, person, amount and share code. */
  findOpen(tabId: string, person: string, amountCents: number, shareCode?: string | null): { orderId: string; approveUrl: string; payeeMode?: 'custom' | 'sandbox_fallback'; shareCode?: string | null } | null {
    if (typeof window === 'undefined') return null;
    const now = Date.now();
    for (const [orderId, e] of Object.entries(readOrderMap())) {
      // Ignore legacy cached entries that carry no payeeMode: do not assume they are custom.
      if (!e?.payeeMode) continue;
      if (
        e?.tabId === tabId &&
        paidKey(e.person) === paidKey(person) &&
        e.amountCents === amountCents &&
        (!shareCode || e.shareCode === shareCode) &&
        e.approveUrl &&
        now - (e.createdAt || 0) < ORDER_TTL_MS
      ) {
        return { orderId, approveUrl: e.approveUrl, payeeMode: e.payeeMode, shareCode: e.shareCode ?? null };
      }
    }
    return null;
  },
  forgetTab(tabId: string) {
    if (typeof window === 'undefined') return;
    const map = readOrderMap();
    for (const [orderId, e] of Object.entries(map)) if (e?.tabId === tabId) delete map[orderId];
    writeOrderMap(map);
  },
};

const toNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Turns one stored entry into a usable ledger, or null when it is unusable (it is skipped, not fatal). */
function sanitizeStoredTab(value: unknown): TabLedger | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as Partial<TabLedger> & Record<string, unknown>;
  if (typeof t.id !== 'string' || !t.id) return null;
  try {
    const rows: LedgerRow[] = (Array.isArray(t.rows) ? t.rows : [])
      .filter((r): r is LedgerRow => !!r && typeof r === 'object')
      .map((r) => ({
        ...r,
        id: String(r.id ?? ''),
        description: String(r.description ?? 'Item'),
        quantity: toNumber(r.quantity, 1) || 1,
        amountCents: Math.round(toNumber(r.amountCents)),
        assignedTo: typeof r.assignedTo === 'string' ? r.assignedTo : 'split',
        taxPct: toNumber(r.taxPct),
      }));
    const items: ReceiptItem[] = (Array.isArray(t.items) ? t.items : [])
      .filter((it): it is ReceiptItem => !!it && typeof it === 'object')
      .map((it) => ({
        ...it,
        name: String(it.name ?? 'Item'),
        priceCents: Math.round(toNumber(it.priceCents)),
        quantity: toNumber(it.quantity, 1) || 1,
        assignedTo: Array.isArray(it.assignedTo) ? it.assignedTo.map(String) : [],
      }));
    const participants: Participant[] = (Array.isArray(t.participants) ? t.participants : []).filter(
      (p): p is Participant => !!p && typeof p.name === 'string' && p.name.trim().length > 0
    );

    return normalizeLedger({
      ...(t as TabLedger),
      title: String(t.title ?? t.merchant ?? 'Receipt'),
      merchant: String(t.merchant ?? ''),
      date: String(t.date ?? ''),
      payeeEmail: typeof t.payeeEmail === 'string' && t.payeeEmail.trim() ? t.payeeEmail.trim() : undefined,
      items,
      rows,
      participants,
      taxCents: toNumber(t.taxCents),
      tipCents: toNumber(t.tipCents),
      subtotalCents: toNumber(t.subtotalCents),
      totalCents: toNumber(t.totalCents),
      createdAt: toNumber(t.createdAt),
      updatedAt: toNumber(t.updatedAt),
    });
  } catch {
    return null;
  }
}

/**
 * Abstract storage adapter interface for tab persistence.
 */
export interface TabStorageAdapter {
  /** Saves or updates a tab ledger in the vault */
  saveTab(ledger: TabLedger): Promise<void>;
  /** Retrieves a tab ledger by identifier */
  getTab(id: string): Promise<TabLedger | null>;
  /** Lists all saved tab ledgers */
  listTabs(): Promise<TabLedger[]>;
  /** Deletes a saved tab ledger */
  deleteTab(id: string): Promise<void>;
  /** Deletes all saved tab ledgers and their payment statuses while keeping user login email */
  clearAllTabs(): Promise<void>;
  /** Updates payment status for a participant (matched by name, case-insensitive) within a tab and bill version */
  savePaidStatus(tabId: string, shareCode: string, participantName: string, status: PaidStatusRecord): Promise<void>;
  /** Retrieves all payment statuses for a tab and bill version, keyed by paidKey(name) */
  getPaidStatuses(tabId: string, shareCode: string): Promise<Record<string, PaidStatusRecord>>;
  /** Saves the latest share code associated with a locally owned bill */
  saveLatestShareCode(tabId: string, shareCode: string | null): Promise<void>;
  /** Retrieves the latest share code for a tab, or null when none is stored */
  getLatestShareCode(tabId: string): Promise<string | null>;
}

/**
 * Client-Side Local Storage Vault
 * Provides offline-first, private persistence in browser local storage.
 */
export class LocalStorageVault implements TabStorageAdapter {
  private getStorageKey(): string {
    return APP_CONFIG.storageKey;
  }

  private getPaidKey(tabId: string): string {
    return `${APP_CONFIG.storageKey}_paid_${tabId}`;
  }

  private getPaidVersionKey(tabId: string, shareCode: string): string {
    return `${APP_CONFIG.storageKey}_paid_v2_${encodeURIComponent(tabId)}_${encodeURIComponent(shareCode)}`;
  }

  /** Removes every version-specific payment-status key belonging to one tab. */
  private removePaidStatusesForTab(tabId: string): void {
    const prefix = `${APP_CONFIG.storageKey}_paid_v2_${encodeURIComponent(tabId)}_`;
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  }

  /** Removes every version-specific payment-status key and latest-share-code pointer. */
  private removeAllPaidStatusesAndPointers(): void {
    const paidPrefix = `${APP_CONFIG.storageKey}_paid_v2_`;
    const pointerPrefix = `${APP_CONFIG.storageKey}_latest_share_`;
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(paidPrefix) || key.startsWith(pointerPrefix))) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  }

  private getLatestShareCodeKey(tabId: string): string {
    return `${APP_CONFIG.storageKey}_latest_share_${encodeURIComponent(tabId)}`;
  }

  /**
   * Reads the vault. Each entry is checked on its own, so one damaged entry no longer empties the
   * whole history. Tabs are only ever matched by id: two receipts that look alike are both kept.
   */
  private readVault(): { tabs: TabLedger[]; damaged: boolean } {
    const raw = localStorage.getItem(this.getStorageKey());
    if (!raw) return { tabs: [], damaged: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { tabs: [], damaged: true };
    }
    if (!Array.isArray(parsed)) return { tabs: [], damaged: true };

    const seen = new Set<string>();
    const tabs: TabLedger[] = [];
    let damaged = false;
    for (const entry of parsed) {
      const tab = sanitizeStoredTab(entry);
      if (!tab) {
        damaged = true;
        continue;
      }
      if (seen.has(tab.id)) continue;
      seen.add(tab.id);
      tabs.push(tab);
    }
    return { tabs, damaged };
  }

  /** Keeps a copy of a vault that could not be fully read before it is overwritten. */
  private backupVault(): void {
    const raw = localStorage.getItem(this.getStorageKey());
    if (raw) localStorage.setItem(`${this.getStorageKey()}_backup`, raw);
  }

  async saveTab(ledger: TabLedger): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      const { tabs, damaged } = this.readVault();
      if (damaged) this.backupVault();

      const next = [{ ...ledger, updatedAt: Date.now() }, ...tabs.filter((t) => t.id !== ledger.id)];
      // Tabs pushed out by the size limit take their paid statuses with them.
      for (const evicted of next.slice(MAX_SAVED_TABS)) {
        localStorage.removeItem(this.getPaidKey(evicted.id));
        this.removePaidStatusesForTab(evicted.id);
        localStorage.removeItem(this.getLatestShareCodeKey(evicted.id));
      }
      localStorage.setItem(this.getStorageKey(), JSON.stringify(next.slice(0, MAX_SAVED_TABS)));
    } catch (e) {
      console.error('Failed to save tab to LocalStorageVault:', e);
    }
  }

  async getTab(id: string): Promise<TabLedger | null> {
    const tabs = await this.listTabs();
    return tabs.find((t) => t.id === id) || null;
  }

  async listTabs(): Promise<TabLedger[]> {
    if (typeof window === 'undefined') return [];
    try {
      return this.readVault().tabs;
    } catch {
      return [];
    }
  }

  async deleteTab(id: string): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      const { tabs, damaged } = this.readVault();
      if (damaged) this.backupVault();
      localStorage.setItem(this.getStorageKey(), JSON.stringify(tabs.filter((t) => t.id !== id)));
      localStorage.removeItem(this.getPaidKey(id));
      this.removePaidStatusesForTab(id);
      localStorage.removeItem(this.getLatestShareCodeKey(id));

      // Forget the PayPal orders that belonged to this tab.
      orderMap.forgetTab(id);
    } catch (e) {
      console.error('Failed to delete tab:', e);
    }
  }

  async clearAllTabs(): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      const { tabs } = this.readVault();
      // Remove all version-specific paid-status keys and latest-share-code pointers.
      this.removeAllPaidStatusesAndPointers();
      // Remove legacy tab-only keys (never migrated, never read as current status).
      for (const t of tabs) {
        localStorage.removeItem(this.getPaidKey(t.id));
        orderMap.forgetTab(t.id);
      }
      localStorage.removeItem(this.getStorageKey());
      localStorage.removeItem(`${this.getStorageKey()}_backup`);
    } catch (e) {
      console.error('Failed to clear all tabs:', e);
    }
  }

  async savePaidStatus(tabId: string, shareCode: string, participantName: string, status: PaidStatusRecord): Promise<void> {
    if (typeof window === 'undefined') return;
    if (!shareCode || !shareCode.trim()) return;
    if (!participantName || !participantName.trim()) return;
    try {
      const current = await this.getPaidStatuses(tabId, shareCode);
      current[paidKey(participantName)] = status;
      localStorage.setItem(this.getPaidVersionKey(tabId, shareCode), JSON.stringify(current));
    } catch (e) {
      console.error('Failed to save paid status:', e);
    }
  }

  async getPaidStatuses(tabId: string, shareCode: string): Promise<Record<string, PaidStatusRecord>> {
    if (typeof window === 'undefined') return {};
    if (!shareCode || !shareCode.trim()) return {};
    try {
      const raw = localStorage.getItem(this.getPaidVersionKey(tabId, shareCode));
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object') return {};

      const statuses: Record<string, PaidStatusRecord> = {};
      for (const [name, record] of Object.entries(parsed as Record<string, PaidStatusRecord>)) {
        if (!record || typeof record !== 'object') continue;
        const key = paidKey(name);
        const existing = statuses[key];
        if (!existing || (record.paidAt || 0) >= (existing.paidAt || 0)) {
          statuses[key] = { ...record, isPaid: record.isPaid === true };
        }
      }
      return statuses;
    } catch {
      return {};
    }
  }

  async saveLatestShareCode(tabId: string, shareCode: string | null): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      if (!shareCode || shareCode === '') {
        localStorage.removeItem(this.getLatestShareCodeKey(tabId));
      } else {
        localStorage.setItem(this.getLatestShareCodeKey(tabId), shareCode);
      }
    } catch (e) {
      console.error('Failed to save latest share code:', e);
    }
  }

  async getLatestShareCode(tabId: string): Promise<string | null> {
    if (typeof window === 'undefined') return null;
    try {
      const code = localStorage.getItem(this.getLatestShareCodeKey(tabId));
      return code || null;
    } catch {
      return null;
    }
  }
}

/**
 * Stateless URL Share Adapter
 * Encodes full tab ledger state into a compressed base64 URI component.
 */
export class ShareLinkAdapter {
  /**
   * Compresses ledger into base64 URL safe string (75% smaller, zero duplication)
   */
  static async encodeLedger(ledger: TabLedger): Promise<string> {
    try {
      // ensureRows maps item assignments (participant ids) to names, which is what the decoder expects.
      const activeRows = ensureRows(ledger).rows;

      const minified = {
        v: ledger.schemaVersion ?? LEDGER_SCHEMA_VERSION,
        i: ledger.id,
        t: ledger.title,
        m: ledger.merchant,
        d: ledger.date,
        pe: ledger.payeeEmail,
        p: (ledger.participants || []).map((p) => ({
          i: p.id,
          n: p.name,
          c: p.color,
          h: p.isHost,
        })),
        tx: ledger.taxCents,
        tp: ledger.tipCents,
        tr: ledger.tipAllocationRule,
        st: ledger.subtotalCents,
        tt: ledger.totalCents,
        dc: ledger.discountCents,
        sc: ledger.serviceChargeCents,
        ro: ledger.roundOffCents,
        ti: ledger.isTaxInclusive,
        ty: ledger.taxType,
        tpct: ledger.taxPercentage,
        rw: activeRows.map((r) => ({
          i: r.id,
          d: r.description,
          q: r.quantity || 1,
          a: r.amountCents,
          as: r.assignedTo || 'split',
          tx: r.taxPct,
          ti: r.isTaxInclusive,
          ar: r.allocationRule,
          rs: r.ruleSummary,
        })),
      };

      const json = JSON.stringify(minified);
      // Compress with gzip when available to shorten the shared link.
      if (typeof window !== 'undefined' && typeof CompressionStream !== 'undefined') {
        try {
          const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
          const buf = await new Response(stream).arrayBuffer();
          const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          return 'g:' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch {}
      }
      if (typeof window !== 'undefined') {
        return btoa(unescape(encodeURIComponent(json)));
      }
      return Buffer.from(json, 'utf-8').toString('base64');
    } catch (e) {
      console.error('Failed to encode ledger:', e);
      return '';
    }
  }

  /**
   * Decodes a base64 string back into a TabLedger
   */
  static async decodeLedger(encoded: string): Promise<TabLedger | null> {
    try {
      let json = '';
      // Decompress gzip-compressed payloads (prefixed with "g:").
      if (typeof window !== 'undefined' && encoded.startsWith('g:')) {
        try {
          const b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
          const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
          const bytes = Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
          const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
          json = await new Response(stream).text();
        } catch {
          json = '';
        }
      }

      if (!json) {
        const cleanB64 = decodeURIComponent(encoded).replace(/ /g, '+');
        if (typeof window !== 'undefined') {
          try {
            json = decodeURIComponent(escape(atob(cleanB64)));
          } catch {
            json = atob(cleanB64);
          }
        } else {
          json = Buffer.from(cleanB64, 'base64').toString('utf-8');
        }
        // Handle legacy links encoded with encodeURIComponent before base64
        if (json.startsWith('%7B') || json.startsWith('%25') || json.includes('%22')) {
          try {
            json = decodeURIComponent(json);
          } catch (_) {}
        }
      }

      const data = JSON.parse(json);
      if (!data || typeof data !== 'object') return null;

      const decodedParticipants: Participant[] = (Array.isArray(data.p) ? data.p : [])
        .filter((p: any) => p && typeof p.n === 'string' && p.n.trim())
        .map((p: any) => ({
          id: typeof p.i === 'string' && p.i ? p.i : `p_${p.n.trim().toLowerCase().replace(/\s+/g, '_')}`,
          name: p.n.trim(),
          color: typeof p.c === 'string' ? p.c : undefined,
          isHost: p.h === true,
        }));

      const subtotalCents = toNumber(data.st);
      const taxRate = subtotalCents > 0 ? toNumber(data.tx) / subtotalCents : 0;

      let decodedRows: LedgerRow[] = [];
      let decodedItems: ReceiptItem[] = [];

      if (data.rw && Array.isArray(data.rw) && data.rw.length > 0) {
        decodedRows = data.rw
          .filter((r: any) => r && typeof r === 'object')
          .map((r: any, idx: number) => ({
            id: r.i ? String(r.i) : `item_${idx + 1}`,
            description: String(r.d ?? 'Item'),
            quantity: toNumber(r.q, 1) || 1,
            amountCents: Math.round(toNumber(r.a)),
            assignedTo: typeof r.as === 'string' ? r.as : (Array.isArray(r.as) ? (r.as.length === 1 ? String(r.as[0]) : 'split') : 'split'),
            taxPct: toNumber(r.tx, taxRate),
            isTaxInclusive: r.ti ?? data.ti ?? false,
            allocationRule: r.ar && typeof r.ar === 'object' ? r.ar : undefined,
            ruleSummary: typeof r.rs === 'string' ? r.rs : undefined,
          }));

        decodedItems = decodedRows.map((r) => {
          let assignedList: string[] = [];
          if (r.assignedTo && r.assignedTo !== 'split' && r.assignedTo !== 'everyone') {
            const found = decodedParticipants.find(
              (p) => p.name.toLowerCase() === r.assignedTo.toLowerCase() || p.id === r.assignedTo
            );
            assignedList = [found ? found.id : r.assignedTo];
          }
          return {
            id: r.id,
            name: r.description,
            priceCents: r.amountCents,
            quantity: r.quantity || 1,
            assignedTo: assignedList,
            category: 'general',
            isTaxInclusive: r.isTaxInclusive,
            allocationRule: r.allocationRule,
            ruleSummary: r.ruleSummary,
          };
        });
      }

      if (decodedRows.length === 0) return null;

      // Links without a version ("v") were created before the round-off fix; normalizeLedger upgrades them.
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
        tipAllocationRule: data.tr && typeof data.tr === 'object' ? data.tr : undefined,
        subtotalCents,
        totalCents: toNumber(data.tt),
        discountCents: toNumber(data.dc),
        serviceChargeCents: toNumber(data.sc),
        roundOffCents: toNumber(data.ro),
        isTaxInclusive: data.ti ?? false,
        taxType: data.ty === 'inclusive' || data.ty === 'exclusive' || data.ty === 'none' ? data.ty : undefined,
        taxPercentage: data.tpct === undefined ? undefined : toNumber(data.tpct),
        schemaVersion: toNumber(data.v, 1) || 1,
        rows: decodedRows,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (e) {
      console.error('Failed to decode shared tab:', e);
      return null;
    }
  }

  /**
   * Generates a full shareable URL. The ledger travels in the fragment (`/share#tab=...`), which the
   * browser never sends to the server. Append `&person=<name>` to open it for one person.
   */
  static async generateShareUrl(
    ledger: TabLedger,
    participants?: Participant[],
    currencyCode?: string
  ): Promise<string> {
    const targetLedger: TabLedger = { ...ledger };
    if (participants && participants.length > 0) {
      targetLedger.participants = participants.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isHost: p.isHost,
      }));
    }
    const encoded = await this.encodeLedger(targetLedger);
    try {
      const res = await fetch('/api/shortlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encoded, currencyCode }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.code) {
          return `${getPublicAppOrigin()}/s/${data.code}#tab=${encodeURIComponent(encoded)}`;
        }
      }
    } catch {}
    return `${getPublicAppOrigin()}/share#tab=${encodeURIComponent(encoded)}`;
  }

  /**
   * Reads `tab` and `person` from the current URL: the fragment (`#tab=...&person=...`) or, for links
   * created by older versions, the query string (`?tab=...&person=...`).
   */
  static readShareParams(): { encoded: string | null; person: string | null } {
    if (typeof window === 'undefined') return { encoded: null, person: null };
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(window.location.search);
    return {
      encoded: hash.get('tab') || query.get('tab'),
      person: hash.get('person') || query.get('person'),
    };
  }
}

export const tabStorage = new LocalStorageVault();
