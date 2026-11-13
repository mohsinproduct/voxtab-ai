/**
 * @file StepSettle.tsx
 * @description Step 3: Settle the bill screen.
 * - Classic horizontal scrollable participant status strip at the top (.no-scrollbar).
 * - All participant cards start collapsed by default in both List and Grid views.
 * - Grid View uses 2 independent vertical flex columns on desktop so collapsing a card leaves zero empty gap.
 * - Mobile-first card alignment: clean top row (Avatar + Name + Share + Status) and symmetrical action buttons.
 * - Supports deep-linking to ?filter=paid or ?filter=unpaid from Saved Bills (/history).
 */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import confetti from 'canvas-confetti';
import { TabLedger } from '@/types/tab';
import {
  buildRows,
  computeSplit,
  formatRuleSummary,
  isSelfParticipant,
  LEDGER_SCHEMA_VERSION,
  SplitResult,
} from '@/lib/ledgerUtils';
import {
  tabStorage,
  paidKey,
  orderMap,
  PaidStatusRecord,
  ShareLinkAdapter,
} from '@/lib/tabStorage';
import { shareOrCopy, copyText } from '@/lib/mediaSupport';
import { getPublicAppOrigin } from '@/config/appConfig';
import { useI18n } from '@/lib/i18n';
import { Button, AvatarPill, Skeleton } from '@/components/ui';
import {
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Grid,
  List,
  Pencil,
  QrCode,
  Share2,
  Copy,
  Check,
  Receipt,
  ExternalLink,
  X,
} from 'lucide-react';

export interface SettleParticipantInput {
  id: string;
  name: string;
  color: string;
  isHost?: boolean;
  shareCents?: number;
  paid?: boolean;
  txId?: string;
}

interface StepSettleProps {
  ledger: TabLedger | null;
  participants: SettleParticipantInput[];
  sharedPerson?: string | null;
  initialFilter?: 'all' | 'unpaid' | 'paid';
  isSharedView?: boolean;
  shareCode?: string | null;
  onSelectPerson?: (name: string | null) => void;
  onRenameSelf?: (oldName: string, newName: string) => void;
  onStartOver?: () => void;
  onBack?: () => void;
}

export function StepSettle({
  ledger,
  participants,
  sharedPerson,
  initialFilter = 'all',
  isSharedView = false,
  shareCode: propShareCode = null,
  onSelectPerson,
  onRenameSelf,
  onStartOver,
  onBack,
}: StepSettleProps) {
  const { fmtMoney, currency } = useI18n();
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unpaid' | 'paid'>(initialFilter);
  const [editingSelfId, setEditingSelfId] = useState<string | null>(null);
  const [selfNameDraft, setSelfNameDraft] = useState<string>('');
  const [paidMap, setPaidMap] = useState<Record<string, PaidStatusRecord>>({});
  const [ordersByPerson, setOrdersByPerson] = useState<
    Record<
      string,
      {
        orderId: string;
        approveUrl: string;
        amountCents: number;
        payeeMode: 'custom' | 'sandbox_fallback';
        shareCode: string;
      }
    >
  >({});
  // Details start closed by default in both List and Grid views
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const [shareLink, setShareLink] = useState<string>('');
  const [shareCode, setShareCode] = useState<string | null>(propShareCode ?? null);
  const [sharePreparationState, setSharePreparationState] = useState<'preparing' | 'ready' | 'fallback'>(
    propShareCode ? 'ready' : 'preparing'
  );
  const [copyFeedback, setCopyFeedback] = useState<'idle' | 'copied' | 'shared'>('idle');
  const [personCopiedKey, setPersonCopiedKey] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState<boolean>(false);
  const [orderErrors, setOrderErrors] = useState<Record<string, string>>({});
  // Canonical serialization of the current bill state used to detect edits.
  const billGen = useMemo(() => {
    if (!ledger) return '';
    // Compute effective rows the same way encodeLedger does: use ledger.rows
    // when non-empty, otherwise fall back to rows built from ledger.items.
    const activeRows = ledger.rows && ledger.rows.length > 0
      ? ledger.rows
      : buildRows(ledger);
    return JSON.stringify({
      v: ledger.schemaVersion ?? LEDGER_SCHEMA_VERSION,
      i: ledger.id,
      t: ledger.title,
      m: ledger.merchant,
      d: ledger.date,
      pe: ledger.payeeEmail,
      // Use the participants prop (generateShareUrl overwrites ledger.participants with it).
      p: (participants || []).map((p) => ({
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
      currency,
    });
  }, [ledger, participants, currency]);

  // Sequence counter to ignore out-of-order status responses.
  const statusRequestSeq = useRef(0);
  // Tracks the latest committed bill identity for async callbacks.
  const currentBillRef = useRef<{
    tabId: string | null;
    shareCode: string | null;
    billGen: string;
  }>({
    tabId: ledger?.id ?? null,
    shareCode,
    billGen,
  });
  // Mirrors ordersByPerson so callbacks can read current orders without re-binding.
  const ordersRef = useRef(ordersByPerson);
  // Guards against concurrent POST /api/paypal-order calls for the same participant.
  const inFlightOrdersRef = useRef<Set<string>>(new Set());
  // Tracks which bill generation the current shareLink/shareCode belong to,
  // so ensureShareUrl() can detect and reject stale links after an edit.
  const currentShareGen = useRef<string>('');

  // Keeps the committed bill identity in sync with the latest render so that
  // asynchronous checkout guards (share-link generation, order creation, paid-status
  // refresh, mark-as-paid) never act on a stale bill generation.
  useEffect(() => {
    currentBillRef.current = {
      tabId: ledger?.id ?? null,
      shareCode,
      billGen,
    };
  }, [ledger, shareCode, billGen]);

  // Keeps the committed orders map in sync with the latest ordersByPerson state so
  // ensureOrderForPerson and checkOpenOrdersAndRefresh read current orders without
  // taking ordersByPerson into their callback dependency arrays.
  useEffect(() => {
    ordersRef.current = ordersByPerson;
  }, [ordersByPerson]);

  useEffect(() => {
    setStatusFilter(initialFilter);
  }, [initialFilter]);

  useEffect(() => {
    if (sharedPerson) {
      const k = paidKey(sharedPerson);
      setExpandedCards((prev) => ({ ...prev, [k]: true }));
    }
  }, [sharedPerson]);

  const participantNames = useMemo(
    () => (participants.length ? participants.map((p) => p.name) : ['Me']),
    [participants]
  );

  const splits: SplitResult[] = useMemo(() => {
    if (!ledger) return [];
    return computeSplit(ledger, participantNames);
  }, [ledger, participantNames]);

  // Generate stateless compressed share link
  useEffect(() => {
    // Immediately invalidate stale share data when the bill generation changes.
    // Do not retain a previous share code or link while preparing a new one.
    if (!isSharedView || !propShareCode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShareLink('');
      setShareCode(null);
      currentShareGen.current = '';
    }
    // Reset readiness when the bill version or relevant dependencies change.
    // Do not retain a stale share code or readiness state.
    setSharePreparationState('preparing');

    // When viewing an existing shared bill, preserve the original share code.
    // Do not create another server share record or replace the original link.
    if (isSharedView && propShareCode) {
      setShareCode(propShareCode);
      currentShareGen.current = billGen;
      setSharePreparationState('ready');
      return;
    }
    if (!ledger) {
      setSharePreparationState('fallback');
      return;
    }
    const requestGen = billGen;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const runGenerate = async (attempt: number) => {
      try {
        const url = await ShareLinkAdapter.generateShareUrl(ledger, participants, currency);
        if (cancelled) return;
        const match = new URL(url).pathname.match(/^\/s\/([^/]+)$/);
        const code = match?.[1] ?? null;
        if (!code && attempt < 4) {
          retryTimer = setTimeout(() => {
            void runGenerate(attempt + 1);
          }, 1000);
          return;
        }
        setShareLink(url);
        setShareCode(code);
        currentShareGen.current = requestGen;
        if (!isSharedView && code) {
          await tabStorage.saveLatestShareCode(ledger.id, code);
          if (cancelled) return;
        }
        setSharePreparationState(code ? 'ready' : 'fallback');
      } catch {
        if (cancelled) return;
        if (attempt < 4) {
          retryTimer = setTimeout(() => {
            void runGenerate(attempt + 1);
          }, 1000);
          return;
        }
        setSharePreparationState('fallback');
      }
    };

    void runGenerate(1);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [ledger, participants, currency, isSharedView, propShareCode, billGen]);

  // Invalidate stale PayPal orders when the bill generation changes.
  // Old approval URLs and QR codes must not be displayed or reused for a new bill.
  useEffect(() => {
    setOrdersByPerson({});
    ordersRef.current = {};
  }, [billGen]);

  // Load paid statuses from local storage + server state for the current bill version.
  const refreshPaidStatuses = useCallback(async () => {
    // No valid ledger or share code: invalidate outstanding requests and clear the map.
    if (!ledger?.id || !shareCode) {
      statusRequestSeq.current += 1;
      setPaidMap({});
      return;
    }
    const requestSeq = ++statusRequestSeq.current;
    const activeLedgerId = ledger.id;
    const activeShareCode = shareCode;
    const localStatuses = await tabStorage.getPaidStatuses(activeLedgerId, activeShareCode);
    if (requestSeq !== statusRequestSeq.current) return;
    // The active bill version may have changed while the local read was pending.
    if (
      currentBillRef.current.tabId !== activeLedgerId ||
      currentBillRef.current.shareCode !== activeShareCode
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/shortlink?shareCode=${encodeURIComponent(activeShareCode)}`, {
        cache: 'no-store',
      });
      if (requestSeq !== statusRequestSeq.current) return;
      if (
        currentBillRef.current.tabId !== activeLedgerId ||
        currentBillRef.current.shareCode !== activeShareCode
      ) {
        return;
      }
      if (res.ok) {
        const serverState = await res.json();
        if (requestSeq !== statusRequestSeq.current) return;
        if (
          currentBillRef.current.tabId !== activeLedgerId ||
          currentBillRef.current.shareCode !== activeShareCode
        ) {
          return;
        }
        if (serverState?.paid && typeof serverState.paid === 'object') {
          for (const [k, rec] of Object.entries(serverState.paid as Record<string, PaidStatusRecord>)) {
            if (!rec?.isPaid || rec.source !== 'paypal') {
              continue;
            }
            // Server-verified PayPal statuses take precedence over stale local
            // statuses for this same bill version. Manual statuses are local-only
            // and are never accepted from the server.
            localStatuses[k] = rec;
            if (requestSeq !== statusRequestSeq.current) return;
            if (
              currentBillRef.current.tabId !== activeLedgerId ||
              currentBillRef.current.shareCode !== activeShareCode
            ) {
              return;
            }
            await tabStorage.savePaidStatus(activeLedgerId, activeShareCode, k, rec);
          }
        }
      }
    } catch {}
    // Only update the visible map if this request is still the active one and the
    // bill version has not changed.
    if (requestSeq !== statusRequestSeq.current) return;
    if (
      currentBillRef.current.tabId !== activeLedgerId ||
      currentBillRef.current.shareCode !== activeShareCode
    ) {
      return;
    }
    setPaidMap({ ...localStatuses });
  }, [ledger, shareCode]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshPaidStatuses();
  }, [refreshPaidStatuses]);

  const markPersonPaid = useCallback(
    async (personName: string, isPaid: boolean, txId?: string, source: 'manual' | 'paypal' = 'manual') => {
      if (!ledger?.id || !shareCode) return;
      const ledgerId = ledger.id;
      const versionShareCode = shareCode;
      const key = paidKey(personName);
      const current = paidMap[key];
      // A server-verified PayPal payment cannot be erased or overridden by a manual action.
      if (current?.source === 'paypal') return;

      const record: PaidStatusRecord = {
        isPaid,
        paidAt: isPaid ? Date.now() : undefined,
        paypalTxId: isPaid ? txId : undefined,
        source,
      };
      await tabStorage.savePaidStatus(ledgerId, versionShareCode, personName, record);
      // Manual payment statuses are stored locally only. No server synchronization is attempted.
      // If the active bill version changed while the write was pending, do not
      // update the visible payment map for the new version.
      if (currentBillRef.current.tabId !== ledgerId || currentBillRef.current.shareCode !== versionShareCode) {
        return;
      }
      setPaidMap((prev) => ({ ...prev, [key]: record }));

      if (isPaid) {
        try {
          confetti({ particleCount: 55, spread: 60, origin: { y: 0.7 } });
        } catch {}
      }
    },
    [ledger, shareCode, paidMap]
  );

  // Create or reuse a PayPal order for a participant's share
  const ensureOrderForPerson = useCallback(
    async (split: SplitResult): Promise<{ orderId: string; approveUrl: string; payeeMode: 'custom' | 'sandbox_fallback' } | null> => {
      if (!ledger || split.amountCents <= 0 || !shareCode) return null;
      // Require server share code to be confirmed for the current bill generation.
      if (sharePreparationState !== 'ready') return null;
      const orderGen = billGen;
      const key = paidKey(split.participantName);
      const existing = ordersRef.current[key];
      if (
        existing &&
        existing.amountCents === split.amountCents &&
        existing.shareCode === shareCode
      ) {
        return existing;
      }

      const cached = orderMap.findOpen(ledger.id, split.participantName, split.amountCents, shareCode);
      if (cached) {
        // Verify cached order belongs to current generation and share code.
        if (cached.shareCode !== shareCode) return null;
        const payeeMode: 'custom' | 'sandbox_fallback' = cached.payeeMode === 'sandbox_fallback' ? 'sandbox_fallback' : 'custom';
        const entry: {
          orderId: string;
          approveUrl: string;
          amountCents: number;
          payeeMode: 'custom' | 'sandbox_fallback';
          shareCode: string;
        } = {
          orderId: cached.orderId,
          approveUrl: cached.approveUrl,
          amountCents: split.amountCents,
          payeeMode,
          shareCode: cached.shareCode ?? shareCode,
        };
        ordersRef.current = { ...ordersRef.current, [key]: entry };
        setOrdersByPerson((prev) => ({ ...prev, [key]: entry }));
        return entry;
      }

      const origin = getPublicAppOrigin();
      const returnUrl = `${origin}/paypal/return`;
      const cancelUrl = `${origin}/paypal/return?paypal=cancel`;

      const requestKey = `${shareCode}:${key}:${split.amountCents}`;
      if (inFlightOrdersRef.current.has(requestKey)) {
        return null;
      }
      inFlightOrdersRef.current.add(requestKey);

      try {
        const res = await fetch('/api/paypal-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shareCode,
            participantName: split.participantName,
            returnUrl,
            cancelUrl,
          }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data?.orderId || !data?.approveUrl) return null;

        // Verify generation has not changed after the async request.
        if (currentBillRef.current.billGen !== orderGen) return null;

        orderMap.remember(data.orderId, {
          tabId: ledger.id,
          person: split.participantName,
          amountCents: split.amountCents,
          approveUrl: data.approveUrl,
          payeeMode: data.payeeMode === 'sandbox_fallback' ? 'sandbox_fallback' : 'custom',
          shareCode,
        });

        const payeeMode: 'custom' | 'sandbox_fallback' = data.payeeMode === 'sandbox_fallback' ? 'sandbox_fallback' : 'custom';
        const nextOrder = {
          orderId: data.orderId,
          approveUrl: data.approveUrl,
          amountCents: split.amountCents,
          payeeMode,
          shareCode,
        };
        ordersRef.current = { ...ordersRef.current, [key]: nextOrder };
        setOrdersByPerson((prev) => ({ ...prev, [key]: nextOrder }));
        return nextOrder;
      } catch {
        setOrderErrors((prev) => ({ ...prev, [key]: 'Failed to prepare checkout. Please retry.' }));
        return null;
      } finally {
        inFlightOrdersRef.current.delete(requestKey);
      }
    },
    [ledger, shareCode, sharePreparationState, billGen]
  );

  // Pre-create orders for unpaid shares so QR codes and PayPal links are ready immediately
  useEffect(() => {
    if (!ledger) return;
    // Do not create orders while the share link is still being prepared or if the
    // generation does not match the current bill.
    if (sharePreparationState !== 'ready' || !shareCode) return;
    splits.forEach((sp) => {
      const isPaid = Boolean(paidMap[paidKey(sp.participantName)]?.isPaid);
      if (!isPaid && sp.amountCents > 0) {
        ensureOrderForPerson(sp);
      }
    });
  }, [ledger, splits, paidMap, ensureOrderForPerson, sharePreparationState, billGen, shareCode]);

  // Refresh paid statuses and verify any open PayPal orders for unpaid participants.
  // Runs on the poll interval and when the user returns to the Settle tab so a payment
  // made in another tab or device flips to Paid immediately.
  const checkOpenOrdersAndRefresh = useCallback(async () => {
    if (!ledger || !shareCode) return;
    await refreshPaidStatuses();
    const unpaidSplits = splits.filter((sp) => {
      const k = paidKey(sp.participantName);
      return !Boolean(paidMap[k]?.isPaid) && sp.amountCents > 0;
    });
    for (const sp of unpaidSplits) {
      const k = paidKey(sp.participantName);
      let ord = ordersRef.current[k];
      if (!ord) {
        const found = orderMap.findOpen(ledger.id, sp.participantName, sp.amountCents, shareCode);
        if (!found?.orderId) continue;
        ord = {
          orderId: found.orderId,
          approveUrl: found.approveUrl,
          amountCents: sp.amountCents,
          payeeMode: found.payeeMode === 'sandbox_fallback' ? 'sandbox_fallback' : 'custom',
          shareCode: found.shareCode ?? shareCode,
        };
      }
      if (!ord?.orderId) continue;
      // Confirm the order belongs to the current bill generation and share code.
      if (ord.shareCode !== shareCode) continue;
      if (ord.amountCents !== sp.amountCents) continue;
      if (currentShareGen.current !== billGen) continue;
      try {
        const res = await fetch(`/api/paypal-order?orderId=${encodeURIComponent(ord.orderId)}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.paid === true) {
            await refreshPaidStatuses();
            try {
              confetti({ particleCount: 55, spread: 60, origin: { y: 0.7 } });
            } catch {}
          }
        }
      } catch {}
    }
  }, [ledger, splits, paidMap, refreshPaidStatuses, shareCode, billGen]);

  // Poll active PayPal orders every 4.5s so QR scans on a friend's phone flip status to Paid live
  useEffect(() => {
    if (!ledger?.id) return;
    const timer = setInterval(async () => {
      await checkOpenOrdersAndRefresh();
    }, 4500);

    return () => clearInterval(timer);
  }, [ledger?.id, checkOpenOrdersAndRefresh]);

  // Re-check open orders when the user refocuses the tab or the page becomes visible,
  // so a payment completed in another tab or device updates the Settle screen immediately.
  useEffect(() => {
    if (!ledger?.id) return;
    const handleFocus = () => {
      void checkOpenOrdersAndRefresh();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkOpenOrdersAndRefresh();
      }
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [ledger?.id, checkOpenOrdersAndRefresh]);

  const shareReady = sharePreparationState === 'ready' && Boolean(shareCode);

  if (!ledger) return null;

  const totalCents = ledger.totalCents || 0;
  const subtotalCents =
    ledger.subtotalCents ||
    (ledger.rows || []).reduce((s, r) => s + (Number(r.amountCents) || 0), 0);
  const canEditSelf = Boolean(onRenameSelf);

  const enrichedParticipants = participants.map((p) => {
    const split = splits.find(
      (s) => s.participantName.toLowerCase() === p.name.toLowerCase()
    ) || {
      participantName: p.name,
      foodCents: 0,
      discountCents: 0,
      serviceChargeCents: 0,
      taxCents: 0,
      tipCents: 0,
      amountCents: 0,
      taxRatePct: 0,
      items: [],
    };
    const key = paidKey(p.name);
    const paidRec = paidMap[key];
    return {
      ...p,
      split,
      shareCents: split.amountCents,
      paid: Boolean(paidRec?.isPaid),
      paymentSource: paidRec?.source,
      txId: paidRec?.paypalTxId,
      order: ordersByPerson[key],
    };
  });

  const paidCount = enrichedParticipants.filter((p) => p.paid).length;
  const unpaidCount = enrichedParticipants.length - paidCount;
  const settledCents = enrichedParticipants.reduce((sum, p) => sum + (p.paid ? p.shareCents : 0), 0);
  const settledPct = totalCents > 0 ? Math.min(100, Math.round((settledCents / totalCents) * 100)) : 0;

  const filtered = enrichedParticipants.filter((p) => {
    if (sharedPerson && p.name.toLowerCase() !== sharedPerson.toLowerCase()) return false;
    if (statusFilter === 'paid') return p.paid;
    if (statusFilter === 'unpaid') return !p.paid;
    return true;
  });

  const allExpanded = filtered.length > 0 && filtered.every((p) => Boolean(expandedCards[paidKey(p.name)]));

  const toggleCard = (key: string) => {
    setExpandedCards((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const expandAllCards = () => {
    setExpandedCards((prev) => {
      const next = { ...prev };
      for (const p of filtered) {
        next[paidKey(p.name)] = true;
      }
      return next;
    });
  };

  const collapseAllCards = () => {
    setExpandedCards((prev) => {
      const next = { ...prev };
      for (const p of filtered) {
        next[paidKey(p.name)] = false;
      }
      return next;
    });
  };

  const handleRenameSubmit = (oldName: string) => {
    const trimmed = selfNameDraft.trim();
    if (trimmed && trimmed !== oldName && onRenameSelf) {
      onRenameSelf(oldName, trimmed);
    }
    setEditingSelfId(null);
  };

  const ensureShareUrl = async (): Promise<string> => {
    // Only reuse an existing share link if it belongs to the current bill generation.
    // Otherwise regenerate from the current ledger, participants, and currency.
    if (
      shareLink &&
      currentShareGen.current === billGen &&
      currentBillRef.current.billGen === billGen
    ) {
      return shareLink;
    }
    setSharePreparationState('preparing');
    // Tag this request with the current bill generation to reject stale results.
    const requestGen = billGen;
    const requestLedgerId = ledger?.id ?? null;
    const generated = await ShareLinkAdapter.generateShareUrl(ledger, participants, currency);
    // Reject results from an obsolete generation using the live reference.
    if (currentBillRef.current.billGen !== requestGen) {
      return '';
    }
    // Also verify the ledger ID still matches.
    if (requestLedgerId !== null && ledger?.id !== requestLedgerId) {
      return '';
    }
    setShareLink(generated);
    const match = new URL(generated).pathname.match(/^\/s\/([^/]+)$/);
    const code = match?.[1] ?? null;
    // Fragment-only fallback URLs carry no server share code; never preserve a stale code.
    setShareCode(code);
    currentShareGen.current = billGen;
    if (!isSharedView) {
      await tabStorage.saveLatestShareCode(ledger.id, code);
      // Re-verify generation after async storage before marking ready.
      if (currentBillRef.current.billGen !== requestGen) {
        return '';
      }
    }
    setSharePreparationState(code ? 'ready' : 'fallback');
    return generated;
  };

  const handleShareBillLink = async () => {
    const requestGen = billGen;
    const targetUrl = await ensureShareUrl();
    if (!targetUrl) return;
    // Verify generation still matches before sharing.
    if (currentBillRef.current.billGen !== requestGen) return;
    const outcome = await shareOrCopy(
      targetUrl,
      `${ledger.merchant || 'VoxTab'}: Split ${fmtMoney(totalCents)}`
    );
    if (outcome === 'shared') {
      setCopyFeedback('shared');
      setTimeout(() => setCopyFeedback('idle'), 2200);
    } else if (outcome === 'copied') {
      setCopyFeedback('copied');
      setTimeout(() => setCopyFeedback('idle'), 2200);
    }
  };

  const handleCopyBillLink = async () => {
    const requestGen = billGen;
    const targetUrl = await ensureShareUrl();
    if (!targetUrl) return;
    // Verify generation still matches before copying.
    if (currentBillRef.current.billGen !== requestGen) return;
    const ok = await copyText(targetUrl);
    if (ok) {
      setCopyFeedback('copied');
      setTimeout(() => setCopyFeedback('idle'), 2200);
    }
  };

  const handleCopyPersonLink = async (personName: string) => {
    const requestGen = billGen;
    const base = await ensureShareUrl();
    if (!base) return;
    if (currentBillRef.current.billGen !== requestGen) return;
    const isShortLink = /\/s\/[^/?#]+$/.test(base);
    const personUrl = isShortLink
      ? `${base}?p=${encodeURIComponent(personName)}`
      : base.includes('#')
        ? `${base}&person=${encodeURIComponent(personName)}`
        : `${base}#person=${encodeURIComponent(personName)}`;
    const ok = await copyText(personUrl);
    if (ok) {
      const k = paidKey(personName);
      setPersonCopiedKey(k);
      setTimeout(() => setPersonCopiedKey((curr) => (curr === k ? null : curr)), 2000);
    }
  };

  const handlePayViaPayPal = async (p: (typeof enrichedParticipants)[number]) => {
    // Guard: only open orders from the current bill generation.
    if (p.order?.approveUrl && p.order.shareCode === shareCode) {
      const win = window.open(p.order.approveUrl, '_blank', 'noopener,noreferrer');
      if (!win) window.location.assign(p.order.approveUrl);
      return;
    }
    const created = await ensureOrderForPerson(p.split);
    if (created?.approveUrl) {
      const win = window.open(created.approveUrl, '_blank', 'noopener,noreferrer');
      if (!win) window.location.assign(created.approveUrl);
    }
  };

  const retryOrderForPerson = async (split: SplitResult) => {
    const key = paidKey(split.participantName);
    setOrderErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    await ensureOrderForPerson(split);
  };

  const renderParticipantCard = (p: (typeof enrichedParticipants)[number]) => {
    const isSelf = p.isHost ?? isSelfParticipant(p.name);
    const isEditing = editingSelfId === p.id && isSelf && canEditSelf;
    const key = paidKey(p.name);
    const isExpanded = Boolean(expandedCards[key]);
    const isGrid = viewMode === 'grid';
    const { split, order } = p;

    return (
      <div
        key={p.id}
        id={`settle-card-${key}`}
        className={`spotlight-card transition-all duration-200 ${
          p.paid ? 'border-[#38bdf8]/35 bg-[#151a24]/90' : 'border-white/10 hover:border-[var(--brand)]/35'
        }`}
      >
        {/* Main Card Header Row (Click anywhere to expand/collapse) */}
        <div
          onClick={() => {
            if (isEditing) return;
            toggleCard(key);
          }}
          className="p-3.5 sm:p-4 flex items-center justify-between gap-2.5 cursor-pointer select-none"
        >
          {/* Left: Avatar + Name + Status + Item Count */}
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <AvatarPill color={p.color} name={p.name} size="md"/>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                {isEditing ? (
                  <input
                    autoFocus
                    value={selfNameDraft}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setSelfNameDraft(e.target.value)}
                    onBlur={() => handleRenameSubmit(p.name)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleRenameSubmit(p.name);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingSelfId(null);
                      }
                    }}
                    className="text-sm font-bold text-white bg-[var(--bg-muted)] border border-[var(--brand)] rounded-lg px-2 py-0.5 outline-none w-28"
                  />
                ) : (
                  <span className="font-bold text-sm text-white truncate max-w-[120px] sm:max-w-[160px]">
                    {p.name}
                  </span>
                )}

                {!isEditing && canEditSelf && isSelf && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingSelfId(p.id);
                      setSelfNameDraft(p.name);
                    }}
                    className="p-1 text-[var(--fg-muted)] hover:text-[var(--brand)] hover:bg-white/10 rounded-full transition-colors cursor-pointer"
                    title="Rename yourself"
                  >
                    <Pencil className="w-3 h-3"/>
                  </button>
                )}

                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${
                    p.paid
                    ? 'bg-[#009cde]/18 text-[var(--success)] border-[#38bdf8]/40'
                    : 'bg-[var(--brand)]/15 text-[var(--brand-light)] border-[var(--brand)]/30'
                  }`}
                >
                  {p.paid ? (
                    <>
                      <CheckCircle2 className="w-2.5 h-2.5"/>
                      <span>
                        {p.paymentSource === 'paypal'
                          ? 'Paid · PayPal'
                          : p.paymentSource === 'manual'
                            ? 'Paid · Manual'
                            : 'Paid'}
                      </span>
                    </>
                  ) : (
                    <span>Unpaid</span>
                  )}
                </span>
              </div>

              <p className="text-[11px] text-[var(--fg-muted)] mt-0.5 truncate">
                {split.items.length} {split.items.length === 1 ? 'item' : 'items'}
                {split.tipCents > 0 ? ` · incl. ${fmtMoney(split.tipCents)} extras` : ''}
              </p>
            </div>
          </div>

          {/* Right: Share Amount + Wide List-View Inline Actions + Expand Trigger */}
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`mono text-sm sm:text-base font-bold ${
                p.paid ? 'text-[var(--success)]' : 'text-[var(--brand)]'
              }`}
            >
              {fmtMoney(p.shareCents)}
            </span>

            {/* Inline Action Buttons ONLY in wide List View (md:flex when not in 2-col Grid) */}
            {!isGrid && (
              <div
                className="hidden md:flex items-center gap-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                {!p.paid && p.shareCents > 0 && shareReady && (
                  <>
                    <button
                      type="button"
                      onClick={() => handlePayViaPayPal(p)}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#0070ba] hover:bg-[#005ea6] text-white text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap"
                      title="Pay this share via PayPal"
                    >
                      <span>Pay via PayPal</span>
                      <ExternalLink className="w-2.5 h-2.5 shrink-0"/>
                    </button>
                  </>
                )}

                {!isSharedView && !p.paid && (
                  <button
                    type="button"
                    onClick={() => markPersonPaid(p.name, !p.paid)}
                    disabled={!shareCode}
                    title={!shareCode ? 'Share link is still being prepared' : undefined}
                    className="px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors cursor-pointer whitespace-nowrap bg-[#009cde]/18 text-[var(--success)] border-[#38bdf8]/35 hover:bg-[#009cde]/28"
                  >
                    Mark as paid
                  </button>
                )}
                {!isSharedView && p.paid && p.paymentSource === 'paypal' && (
                  <button
                    type="button"
                    disabled
                    title="PayPal-verified payments cannot be undone"
                    className="px-3 py-1 rounded-full text-[11px] font-semibold bg-[var(--bg-muted)]/60 text-[var(--fg-muted)]/50 border border-white/8 cursor-not-allowed whitespace-nowrap select-none"
                  >
                    Undo
                  </button>
                )}
                {!isSharedView && p.paid && p.paymentSource !== 'paypal' && (
                  <button
                    type="button"
                    onClick={() => markPersonPaid(p.name, !p.paid)}
                    disabled={!shareCode}
                    title={!shareCode ? 'Share link is still being prepared' : undefined}
                    className="px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors cursor-pointer whitespace-nowrap bg-[var(--bg-muted)] text-[var(--fg-muted)] border-white/10 hover:text-white"
                  >
                    Undo
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              aria-expanded={isExpanded}
              aria-controls={`settle-panel-${key}`}
              onClick={(e) => {
                e.stopPropagation();
                if (isEditing) return;
                toggleCard(key);
              }}
              className={`p-1 rounded-full text-[var(--fg-muted)] transition-transform duration-200 shrink-0 cursor-pointer ${isExpanded ? 'rotate-180 text-[var(--brand)]' : ''}`}
            >
              <ChevronDown className="w-4 h-4"/>
            </button>
          </div>
        </div>

        {/* Mobile/Tablet & Grid Action Bar Alignment */}
        <div
          className={`${
            isGrid ? 'flex' : 'flex md:hidden'
          } px-3.5 sm:px-4 pb-3 pt-0 flex-wrap items-center justify-between gap-2`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1.5 ml-auto flex-wrap">
            {!p.paid && p.shareCents > 0 && shareReady && (
              <button
                type="button"
                onClick={() => handlePayViaPayPal(p)}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[#0070ba] hover:bg-[#005ea6] text-white text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap"
              >
                <span>Pay via PayPal</span>
                <ExternalLink className="w-2.5 h-2.5 shrink-0"/>
              </button>
            )}

            {!isSharedView && !p.paid && (
              <button
                type="button"
                onClick={() => markPersonPaid(p.name, !p.paid)}
                disabled={!shareCode}
                title={!shareCode ? 'Share link is still being prepared' : undefined}
                className="px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors cursor-pointer whitespace-nowrap bg-[#009cde]/18 text-[var(--success)] border-[#38bdf8]/35 hover:bg-[#009cde]/28"
              >
                Mark as paid
              </button>
            )}
            {!isSharedView && p.paid && p.paymentSource === 'paypal' && (
              <button
                type="button"
                disabled
                title="PayPal-verified payments cannot be undone"
                className="px-3 py-1 rounded-full text-[11px] font-semibold bg-[var(--bg-muted)]/60 text-[var(--fg-muted)]/50 border border-white/8 cursor-not-allowed whitespace-nowrap select-none"
              >
                Undo
              </button>
            )}
            {!isSharedView && p.paid && p.paymentSource !== 'paypal' && (
              <button
                type="button"
                onClick={() => markPersonPaid(p.name, !p.paid)}
                disabled={!shareCode}
                title={!shareCode ? 'Share link is still being prepared' : undefined}
                className="px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors cursor-pointer whitespace-nowrap bg-[var(--bg-muted)] text-[var(--fg-muted)] border-white/10 hover:text-white"
              >
                Undo
              </button>
            )}
          </div>
        </div>

        {/* Collapsible Details Panel (Works in both List & Grid views) */}
        {isExpanded && (
          <div id={`settle-panel-${key}`} className="px-3.5 pb-3.5 sm:px-4 sm:pb-4 pt-2 border-t border-white/8 space-y-3 animate-fade-in">
            {/* Itemized Breakdown */}
            <div className="rounded-xl bg-[var(--bg-muted)]/90 border border-white/8 p-3 space-y-1.5 text-xs">
              {split.items.map((item, idx) => (
                <div key={idx} className="flex items-center justify-between gap-2">
                  <span className="text-[var(--fg-secondary)] truncate">
                    <strong className="mono text-[var(--brand-light)] mr-1.5">
                      {item.qtyLabel || `${item.qty}×`}
                    </strong>
                    {item.description}
                  </span>
                  <span className="mono text-[var(--fg-primary)] shrink-0">
                    {fmtMoney(item.amountCents)}
                  </span>
                </div>
              ))}

              {split.discountCents > 0 && (
                <div className="flex items-center justify-between text-[11px] text-[var(--success)] pt-1 border-t border-white/5">
                  <span>Discount share</span>
                  <span className="mono">-{fmtMoney(split.discountCents)}</span>
                </div>
              )}

              {split.serviceChargeCents !== 0 && (
                <div className="flex items-center justify-between text-[11px] text-[var(--fg-muted)]">
                  <span>Service / Adjustment</span>
                  <span className="mono">{fmtMoney(split.serviceChargeCents)}</span>
                </div>
              )}

              {split.taxCents > 0 && (
                <div className="flex items-center justify-between text-[11px] text-[var(--fg-muted)]">
                  <span>Tax share {ledger.isTaxInclusive ? '(included)' : ''}</span>
                  <span className="mono">{fmtMoney(split.taxCents)}</span>
                </div>
              )}

              {split.tipCents > 0 && (
                <div className="flex items-center justify-between text-[11px] text-[var(--fg-muted)]">
                  <span>Extras share</span>
                  <span className="mono">{fmtMoney(split.tipCents)}</span>
                </div>
              )}
            </div>

            {/* Scannable QR Code + Individual Share Link Copy */}
{!p.paid && p.shareCents > 0 ? (
  shareReady ? (
    <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[var(--bg-surface)] border border-white/10">
      <div className="flex items-center gap-3 min-w-0">
        <div className="p-1.5 rounded-lg bg-white shrink-0 shadow">
          {order?.approveUrl ? (
            <QRCodeSVG includeMargin={false} level="M" size={72} value={order.approveUrl}/>
          ) : orderErrors[key] ? (
            <div className="w-[72px] h-[72px] rounded flex items-center justify-center bg-[var(--bg-muted)]">
              <X className="w-6 h-6 text-[var(--danger)]"/>
            </div>
          ) : (
            <Skeleton className="w-[72px] h-[72px] rounded"/>
          )}
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-bold text-white">Scan PayPal QR</p>
          {orderErrors[key] ? (
            <p className="text-[10px] text-[var(--danger)] leading-snug">
              {orderErrors[key]}
            </p>
          ) : (
            <p className="text-[11px] text-[var(--fg-muted)] leading-snug">
              Scan with phone camera to pay {fmtMoney(p.shareCents)}
            </p>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleCopyPersonLink(p.name)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--brand)] hover:underline cursor-pointer"
            >
              {personCopiedKey === key ? (
                <>
                  <Check className="w-3 h-3 text-[var(--success)]"/>
                  <span className="text-[var(--success)]">Copied {p.name}&apos;s link</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3"/>
                  <span>Copy {p.name}&apos;s link</span>
                </>
              )}
            </button>
            {orderErrors[key] && (
              <button
                type="button"
                onClick={() => retryOrderForPerson(p.split)}
                className="text-[10px] font-semibold text-[var(--brand)] hover:underline cursor-pointer"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  ) : (
    <div className="flex flex-col gap-1 min-w-0">
      <p className="text-xs font-bold text-[var(--fg-primary)] leading-snug">
        Share link preparing
      </p>
      <p className="text-[11px] text-[var(--fg-muted)] leading-snug">
        Checkout will be ready once the share link is created.
      </p>
    </div>
  )
) : null}
          </div>
        )}
      </div>
    );
  };

  // Split filtered cards into 2 independent vertical flex columns for Grid View so collapsing a card leaves zero gap
  const leftColCards = filtered.filter((_, idx) => idx % 2 === 0);
  const rightColCards = filtered.filter((_, idx) => idx % 2 === 1);

  return (
    <div className="animate-fade-up space-y-4">
      {/* 1. CLASSIC HORIZONTAL SCROLLABLE PARTICIPANT STATUS STRIP */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 pt-0.5">
        {isSharedView && participants.length > 1 && (
          <button
            type="button"
            onClick={() => onSelectPerson?.(null)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border shrink-0 transition-all cursor-pointer ${
              !sharedPerson
                ? 'bg-[var(--brand)] text-[#1b1418] border-[var(--brand)]'
                : 'bg-[var(--bg-surface)] text-[var(--fg-secondary)] border-white/10'
            }`}
          >
            All ({participants.length})
          </button>
        )}

        {enrichedParticipants.map((p) => {
          const key = paidKey(p.name);
          const isFocused = sharedPerson?.toLowerCase() === p.name.toLowerCase();
          const isOpen = Boolean(expandedCards[key]);
          return (
            <button
              key={p.id}
              type="button"
            onClick={() => {
              if (isSharedView && onSelectPerson) {
                onSelectPerson(isFocused ? null : p.name);
              } else {
                // Locally owned bill: scroll to the card without toggling its
                // expanded/collapsed state or changing payment status.
                const el = document.getElementById(`settle-card-${key}`);
                el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }
            }}
              className={`inline-flex items-center gap-2 pl-1.5 pr-3 py-1 rounded-full text-xs font-semibold border shrink-0 transition-all cursor-pointer ${
                isFocused || isOpen
                  ? 'bg-[var(--bg-surface)] border-[var(--brand)]/60 text-white shadow-[0_0_14px_rgba(255,217,180,0.16)]'
                  : p.paid
                  ? 'bg-[#009cde]/12 border-[#38bdf8]/35 text-[var(--fg-secondary)]'
                  : 'bg-[var(--bg-surface)] border-white/10 text-[var(--fg-secondary)] hover:border-[var(--brand)]/40'
              }`}
            >
              <AvatarPill color={p.color} name={p.name} size="sm"/>
              <span>{p.name}</span>
              <span className={`mono font-bold ${p.paid ? 'text-[var(--success)]' : 'text-[var(--brand)]'}`}>
                {fmtMoney(p.shareCents)}
              </span>
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  p.paid ? 'bg-[var(--success)]' : 'bg-[var(--brand)]'
                }`}
                title={p.paid ? 'Paid' : 'Unpaid'}
              />
            </button>
          );
        })}
      </div>

      {/* 2. TOP SHARE BAR & FILTER/VIEW CONTROLS */}
      <div className="spotlight-card w-full min-w-0 p-3.5 sm:p-5 space-y-3.5 sm:space-y-4">
        {/* Merchant and total summary row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {/* Icon and merchant name */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="w-7 h-7 rounded-full bg-[var(--brand-dim)] flex items-center justify-center border border-[var(--brand)]/25 shrink-0">
                <QrCode className="w-3.5 h-3.5 text-[var(--brand)]"/>
              </div>
              <span className="font-bold text-sm sm:text-base text-[var(--fg-primary)] truncate">
                {ledger.merchant || 'Receipt'}
              </span>
            </div>

            {/* Date, item count and participant count */}
            <p className="text-[11px] text-[var(--fg-muted)] mt-1">
              {ledger.date || 'Recent'} · {ledger.rows.length}{' '}
              {ledger.rows.length === 1 ? 'item' : 'items'} · {enrichedParticipants.length}{' '}
              {enrichedParticipants.length === 1 ? 'person' : 'people'}
            </p>
          </div>

          {/* Total bill */}
          <div className="text-right shrink-0">
            <span className="text-[10px] uppercase tracking-wider text-[var(--fg-muted)] block">
              Total Bill
            </span>
            <span className="mono text-base sm:text-xl font-bold text-[var(--brand)]">
              {fmtMoney(totalCents)}
            </span>
          </div>
        </div>

        {/* Settlement progress: a separate full-width sibling */}
        <div className="w-full min-w-0">
          <div className="mt-2">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[11px]">
                <span className="mono font-semibold text-[var(--success)]">{fmtMoney(settledCents)}</span> of{' '}
                <span className="mono text-[var(--fg-secondary)]">{fmtMoney(totalCents)}</span> settled
              </span>
              <span className="text-[11px] text-[var(--fg-muted)] text-right">
                {paidCount} of {enrichedParticipants.length} paid ({settledPct}%)
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-[var(--bg-muted)] overflow-hidden">
              <div className="h-full bg-[var(--success)] transition-all duration-500" style={{ width: `${settledPct}%` }} />
            </div>
          </div>
        </div>

        {/* Share link: a separate full-width sibling */}
        {!isSharedView && (
          <div className="w-full min-w-0">
            <div className="p-3 rounded-xl bg-[var(--bg-muted)] border border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs font-bold text-white">
                  <Share2 className="w-3.5 h-3.5 text-[var(--brand)] shrink-0"/>
                  <span>Send bill link to group chat</span>
                </div>
                <p className="text-[11px] text-[var(--fg-muted)] leading-snug mt-0.5">
                  Friends tap their name and pay you on PayPal — no app download needed.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:flex items-center gap-2 w-full sm:w-auto shrink-0">
                <button
                  type="button"
                  onClick={handleCopyBillLink}
                  className="pill-btn-glow inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold cursor-pointer"
                >
                  {copyFeedback === 'copied' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-[var(--success)]"/>
                      <span className="text-[var(--success)]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-[var(--brand)]"/>
                      <span>Copy Link</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleShareBillLink}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-full bg-[var(--brand)] hover:bg-[var(--brand-light)] text-[#1b1418] text-xs font-bold shadow-[0_0_16px_var(--brand-glow)] transition-all cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5"/>
                  <span>{copyFeedback === 'shared' ? 'Shared!' : 'Share'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Filter and view controls: another full-width sibling */}
        <div className="w-full min-w-0">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-1 border-t border-white/8">
            <div className="grid grid-cols-3 sm:inline-flex items-center p-1 rounded-full bg-[var(--bg-muted)] border border-white/10 w-full sm:w-auto">
              {(
                [
                  { id: 'all', label: `All (${enrichedParticipants.length})` },
                  { id: 'unpaid', label: `Unpaid (${unpaidCount})` },
                  { id: 'paid', label: `Paid (${paidCount})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    if (!isSharedView && sharedPerson) {
                      onSelectPerson?.(null);
                    }
                    setStatusFilter(tab.id);
                  }}
                  className={`rounded-full px-3 py-1 text-[11px] font-semibold text-center transition-all cursor-pointer ${
                    statusFilter === tab.id
                      ? 'bg-[var(--brand)] text-[#1b1418] shadow-[0_0_12px_rgba(255,217,180,0.3)]'
                      : 'text-[var(--fg-muted)] hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Single Expand / Collapse toggle (mobile row, beside the filter pills) */}
            <div className="sm:hidden w-full flex items-center justify-center gap-2 px-1 pt-1 border-t border-white/8">
              <button
                type="button"
                onClick={() => (allExpanded ? collapseAllCards() : expandAllCards())}
                className="flex-1 inline-flex items-center justify-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all cursor-pointer text-[var(--fg-muted)] hover:text-white border border-white/10"
                title={allExpanded ? 'Collapse all visible cards' : 'Expand all visible cards'}
              >
                <span>{allExpanded ? 'Collapse All' : 'Expand All'}</span>
              </button>
            </div>

            <div className="hidden sm:flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => (allExpanded ? collapseAllCards() : expandAllCards())}
                className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[11px] font-semibold bg-[var(--bg-muted)] border border-white/10 text-[var(--fg-secondary)] hover:text-white hover:border-[var(--brand)]/40 transition-all cursor-pointer"
                title={allExpanded ? 'Collapse all visible cards' : 'Expand all visible cards'}
              >
                <span>{allExpanded ? 'Collapse All' : 'Expand All'}</span>
              </button>

              <div className="inline-flex items-center gap-1 p-1 rounded-full bg-[var(--bg-muted)] border border-white/10">
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all cursor-pointer ${
                    viewMode === 'list'
                      ? 'bg-[var(--brand)] text-[#1b1418] shadow-[0_0_12px_rgba(255,217,180,0.3)]'
                      : 'text-[var(--fg-muted)] hover:text-white'
                  }`}
                >
                  <List className="w-3 h-3"/>
                  <span>List</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all cursor-pointer ${
                    viewMode === 'grid'
                      ? 'bg-[var(--brand)] text-[#1b1418] shadow-[0_0_12px_rgba(255,217,180,0.3)]'
                      : 'text-[var(--fg-muted)] hover:text-white'
                  }`}
                >
                  <Grid className="w-3 h-3"/>
                  <span>Grid</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 3. PARTICIPANT SETTLEMENT CARDS (List View or 2-Column Independent Masonry Grid View) */}
      {filtered.length === 0 ? (
        <div className="spotlight-card p-6 text-center text-xs text-[var(--fg-muted)]">
          No {statusFilter === 'paid' ? 'paid' : statusFilter === 'unpaid' ? 'unpaid' : ''} shares to show.
        </div>
      ) : viewMode === 'grid' ? (
        <>
          {/* Mobile single stack */}
          <div className="flex flex-col gap-3 sm:hidden">
            {filtered.map((p) => renderParticipantCard(p))}
          </div>
          {/* Desktop 2 independent flex columns so collapsing a card never leaves a vertical gap */}
          <div className="hidden sm:flex sm:flex-row gap-3.5 items-start">
            <div className="flex-1 flex flex-col gap-3.5 min-w-0">
              {leftColCards.map((p) => renderParticipantCard(p))}
            </div>
            <div className="flex-1 flex flex-col gap-3.5 min-w-0">
              {rightColCards.map((p) => renderParticipantCard(p))}
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((p) => renderParticipantCard(p))}
        </div>
      )}

      {/* 4. BOTTOM FULL RECEIPT SUMMARY CARD */}
      <div className="spotlight-card p-4 sm:p-5 space-y-3">
        <button
          type="button"
          onClick={() => setSummaryOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-2 text-left cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-[var(--brand-dim)] border border-[var(--brand)]/25 flex items-center justify-center text-[var(--brand)]">
              <Receipt className="w-3.5 h-3.5"/>
            </div>
            <div>
              <h3 className="text-xs sm:text-sm font-bold text-white">
                Full Receipt Summary
              </h3>
              <p className="text-[11px] text-[var(--fg-muted)]">
                {ledger.rows.length} {ledger.rows.length === 1 ? 'item' : 'items'} · Total{' '}
                <span className="mono text-[var(--fg-secondary)]">{fmtMoney(totalCents)}</span>
              </p>
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-[var(--fg-muted)] transition-transform ${summaryOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {summaryOpen && (
          <div className="pt-2 border-t border-white/8 space-y-2 text-xs animate-fade-in">
            <div className="space-y-1.5">
              {ledger.rows.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="mono font-bold text-[var(--brand-light)] shrink-0">
                      {row.quantity || 1}×
                    </span>
                    <span className="text-[var(--fg-secondary)] truncate">{row.description}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--bg-surface)] border border-white/8 text-[var(--fg-muted)] shrink-0">
                      {row.ruleSummary || (row.assignedTo !== 'split' ? row.assignedTo : 'Shared')}
                    </span>
                  </div>
                  <span className="mono font-semibold text-white shrink-0">
                    {fmtMoney(row.amountCents)}
                  </span>
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-white/8 space-y-1 text-xs">
              <div className="flex justify-between text-[var(--fg-muted)]">
                <span>Subtotal</span>
                <span className="mono text-[var(--fg-secondary)]">{fmtMoney(subtotalCents)}</span>
              </div>
              {ledger.discountCents !== undefined && ledger.discountCents > 0 && (
                <div className="flex justify-between text-[var(--success)]">
                  <span>Discount</span>
                  <span className="mono">-{fmtMoney(ledger.discountCents)}</span>
                </div>
              )}
              {ledger.taxCents > 0 && (
                <div className="flex justify-between text-[var(--fg-muted)]">
                  <span>Tax {ledger.isTaxInclusive ? '(Included)' : ''}</span>
                  <span className="mono text-[var(--fg-secondary)]">
                    {fmtMoney(ledger.taxCents)}
                  </span>
                </div>
              )}
                {ledger.tipCents > 0 && (
                <div className="flex justify-between text-[var(--fg-muted)]">
                  <span>
                    Extras{' '}
                    {ledger.tipAllocationRule
                      ? `(${formatRuleSummary(ledger.tipAllocationRule)})`
                      : '(By Item Share)'}
                  </span>
                  <span className="mono text-[var(--fg-secondary)]">
                    {fmtMoney(ledger.tipCents)}
                  </span>
                </div>
              )}
              <div className="flex justify-between font-bold text-sm text-white pt-1 border-t border-white/8">
                <span>Total</span>
                <span className="mono text-[var(--brand)]">{fmtMoney(totalCents)}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Navigation Footer */}
      <div className="flex gap-3 pt-1">
        {onBack && (
          <Button
            icon={<ChevronRight className="w-4 h-4 rotate-180"/>}
            onClick={onBack}
            size="lg"
            variant="secondary"
            className="w-24 sm:w-28 h-12"
          >
            Back
          </Button>
        )}
        {onStartOver && (
          <Button
            icon={<ChevronRight className="w-4 h-4"/>}
            size="lg"
            variant="primary"
            onClick={onStartOver}
            className="flex-1 h-12"
          >
            {isSharedView ? 'Scan Your Own Receipt' : 'Scan Another Receipt'}
          </Button>
        )}
      </div>
    </div>
  );
}