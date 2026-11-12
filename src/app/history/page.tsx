/**
 * @file page.tsx
 * @description /history: saved bills on this device, featuring:
 * - Clickable "paid" and "unpaid" badges that deep-link directly to &filter=paid or &filter=unpaid
 * - Compact "6 paid · 9 unpaid" pills when > 3 participants (and names when <= 3)
 * - "Clear All" button (shown only when > 0 receipts) with confirmation modal that clears history
 *   without logging the user out or deleting their Sandbox recipient.
 */
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { History, Trash2, ArrowRight } from 'lucide-react';
import { TabLedger } from '@/types/tab';
import { isSelfParticipant } from '@/lib/ledgerUtils';
import { tabStorage, paidKey, PaidStatusRecord } from '@/lib/tabStorage';
import { PayPalEmailGate, PAYEE_STORAGE_KEY } from '@/components/PayPalEmailGate';
import { useI18n } from '@/lib/i18n';
import { Modal, Button, Skeleton } from '@/components/ui';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function HistoryPage() {
  const router = useRouter();
  const { fmtMoney } = useI18n();
  const [tabs, setTabs] = useState<TabLedger[] | null>(null);
  const [paidByTab, setPaidByTab] = useState<Record<string, Record<string, PaidStatusRecord>>>({});
  const [savedEmail, setSavedEmail] = useState<string>('');
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [clearAllOpen, setClearAllOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        setSavedEmail((localStorage.getItem(PAYEE_STORAGE_KEY) || '').trim());
      } catch {}
      const list = await tabStorage.listTabs();
      const entries = await Promise.all(
        list.map(async (t) => {
          const shareCode = await tabStorage.getLatestShareCode(t.id);
          const paid = shareCode ? await tabStorage.getPaidStatuses(t.id, shareCode) : {};
          return [t.id, paid] as const;
        })
      );
      setTabs(list);
      setPaidByTab(Object.fromEntries(entries));
    };
    load();
    window.addEventListener('storage', load);
    window.addEventListener('focus', load);
    return () => {
      window.removeEventListener('storage', load);
      window.removeEventListener('focus', load);
    };
  }, []);

  const confirmRemoveSingle = async () => {
    if (!deleteTargetId) return;
    await tabStorage.deleteTab(deleteTargetId);
    setDeleteTargetId(null);
    setTabs(await tabStorage.listTabs());
  };

  const confirmClearAllHistory = async () => {
    await tabStorage.clearAllTabs();
    setClearAllOpen(false);
    setTabs([]);
    setPaidByTab({});
  };

  return (
    <div className="w-full">
      {/* Header Row with Conditional "Clear All" Button when tabs.length > 0 */}
      <div className="pt-4 pb-4 sm:pt-7 sm:pb-6 flex items-end justify-between gap-3 animate-fade-up">
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--fg-primary)]">
            Saved bills
          </h1>
          <p className="text-xs sm:text-sm text-[var(--fg-muted)]">
            Stored in this browser only. Tap any bill to view status or share.
          </p>
        </div>

        {tabs && tabs.length > 0 && (
          <Button icon={<Trash2/>}
            onClick={() => setClearAllOpen(true)}
            size="sm"
            variant="danger"
          >
            Clear All
          </Button>
        )}
      </div>

      {tabs === null ? (
        <div className="space-y-2.5 pt-2">
          <Skeleton className="h-16 w-full"/>
          <Skeleton className="h-16 w-full"/>
          <Skeleton className="h-16 w-full"/>
        </div>
      ) : tabs.length === 0 ? (
        <div className="space-y-5 animate-fade-up">
          <div className="spotlight-card py-8 px-4 text-center space-y-3">
            <History className="w-9 h-9 text-[var(--brand)] mx-auto opacity-75"/>
            <div className="space-y-1">
              <p className="text-sm font-bold text-white">No saved bills yet</p>
              <p className="text-xs text-[var(--fg-muted)] max-w-sm mx-auto">
              {savedEmail && EMAIL_REGEX.test(savedEmail)
                ? `Signed in with ${savedEmail}. Scan a receipt to split a new bill.`
                : 'Enter your PayPal email below to scan your first receipt. Every bill you split is saved here automatically.'}
              </p>
            </div>
            {savedEmail && EMAIL_REGEX.test(savedEmail) && (
              <div className="pt-1">
                <Link href="/?scan=1">
                  <Button icon={<ArrowRight/>} size="md" variant="primary">
                    Scan a Receipt
                  </Button>
                </Link>
              </div>
            )}
          </div>

          {!(savedEmail && EMAIL_REGEX.test(savedEmail)) && (
            <PayPalEmailGate inputId="history-paypal-email"/>
          )}
        </div>
      ) : (
        <div className="space-y-2.5 animate-fade-up">
          {tabs.map((tab) => {
            const merchant = tab.merchant?.trim() || tab.title?.trim() || 'Receipt';
            const date =
              tab.date?.trim() ||
              (tab.createdAt ? new Date(tab.createdAt).toLocaleDateString() : 'Recent');
            const allPeople = tab.participants || [];
            const friends = allPeople.filter((p) => !isSelfParticipant(p.name));
            const targetList = friends.length > 0 ? friends : allPeople;
            const unpaid = targetList.filter((p) => !paidByTab[tab.id]?.[paidKey(p.name)]?.isPaid);
            const paidList = targetList.filter((p) => paidByTab[tab.id]?.[paidKey(p.name)]?.isPaid);
            const itemCount = tab.rows?.length || tab.items?.length || 0;
            const useCompactCounts = targetList.length > 3;
            const assignUrl = `/tab/${encodeURIComponent(tab.id)}/assign`;
            const settleBaseUrl = `/tab/${encodeURIComponent(tab.id)}/settle?from=history`;
            const defaultRowUrl = allPeople.length === 0 ? assignUrl : settleBaseUrl;

            return (
              <div
                key={tab.id}
                className={`spotlight-card flex items-center gap-3 p-3.5 transition-colors ${
                  unpaid.length || allPeople.length === 0 ? 'border-[var(--brand)]/30' : 'border-white/10'
                }`}
              >
                {/* Merchant name + date area: deep-links to assign if unsplit, or settle if split */}
                <div
                  onClick={() => router.push(defaultRowUrl)}
                  role="button"
                  tabIndex={0}
                  className="flex-1 min-w-0 cursor-pointer"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm text-[var(--fg-primary)] truncate">
                        {merchant}
                      </span>

                      {allPeople.length === 0 ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--brand)]/15 text-[var(--brand)] border border-[var(--brand)]/30">
                          Ready to split
                        </span>
                      ) : null}

                      {/* Status pills inline with merchant */}
                      {targetList.length > 0 && unpaid.length === 0 ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`${settleBaseUrl}&filter=paid`);
                          }}
                          className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#009cde]/18 hover:bg-[#009cde]/28 text-[#38bdf8] border border-[#38bdf8]/40 transition-colors cursor-pointer shrink-0"
                          title="View paid shares"
                        >
                          All Paid
                        </button>
                      ) : useCompactCounts ? (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              router.push(`${settleBaseUrl}&filter=paid`);
                            }}
                            className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#009cde]/18 hover:bg-[#009cde]/28 text-[#38bdf8] border border-[#38bdf8]/40 transition-colors cursor-pointer shrink-0"
                            title="Open Paid tab"
                          >
                            {paidList.length} paid
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              router.push(`${settleBaseUrl}&filter=unpaid`);
                            }}
                            className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--brand)]/15 hover:bg-[var(--brand)]/25 text-[var(--brand-light)] border border-[var(--brand)]/30 transition-colors cursor-pointer shrink-0"
                            title="Open Unpaid tab"
                          >
                            {unpaid.length} unpaid
                          </button>
                        </>
                      ) : (
                        <>
                          {paidList.length > 0 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                router.push(`${settleBaseUrl}&filter=paid`);
                              }}
                              className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#009cde]/18 hover:bg-[#009cde]/28 text-[#38bdf8] border border-[#38bdf8]/40 transition-colors cursor-pointer shrink-0"
                              title="Open Paid tab"
                            >
                              Paid: {paidList.map((p) => p.name).join(', ')}
                            </button>
                          )}
                          {unpaid.length > 0 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                router.push(`${settleBaseUrl}&filter=unpaid`);
                              }}
                              className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--brand)]/15 hover:bg-[var(--brand)]/25 text-[var(--brand-light)] border border-[var(--brand)]/30 transition-colors cursor-pointer shrink-0"
                              title="Open Unpaid tab"
                            >
                              Unpaid: {unpaid.map((p) => p.name).join(', ')}
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    <div className="text-xs text-[var(--fg-muted)] mt-0.5 sm:mt-0">
                      {date} · {itemCount} {itemCount === 1 ? 'item' : 'items'}
                      {allPeople.length
                        ? ` · ${allPeople.length} ${allPeople.length === 1 ? 'person' : 'people'}`
                        : ''}
                    </div>
                  </div>
                </div>

                <span className="mono font-bold text-sm text-white shrink-0">
                  {fmtMoney(tab.totalCents || 0)}
                </span>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTargetId(tab.id);
                  }}
                  className="p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors cursor-pointer"
                  aria-label={`Delete ${merchant}`}
                >
                  <Trash2 className="w-4 h-4"/>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Single Receipt Delete Modal */}
      <Modal isOpen={!!deleteTargetId} onClose={() => setDeleteTargetId(null)} title="Delete receipt?">
        <p className="text-sm text-[var(--fg-primary)] mb-4">
          Delete this receipt and its payment status? This cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setDeleteTargetId(null)} variant="ghost">
            Cancel
          </Button>
          <Button onClick={confirmRemoveSingle} variant="danger">
            Delete
          </Button>
        </div>
      </Modal>

      {/* Bulk Clear All History Modal (Preserves PayPal Email Login) */}
      <Modal isOpen={clearAllOpen} onClose={() => setClearAllOpen(false)} title="Clear all saved bills?">
        <p className="text-sm text-[var(--fg-secondary)] leading-relaxed mb-5">
          This will delete all saved receipts and their payment statuses from this browser. Your PayPal payout email will stay saved so you can keep splitting right away.
        </p>
        <div className="flex justify-end gap-2.5">
          <Button onClick={() => setClearAllOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button icon={<Trash2/>} onClick={confirmClearAllHistory} variant="danger">
            Delete All Bills
          </Button>
        </div>
      </Modal>
    </div>
  );
}
