/**
 * @file page.tsx
  * @description /privacy: Zero-login privacy overview and browser data management tool.
 */
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Modal } from '@/components/ui';
import { APP_CONFIG } from '@/config/appConfig';
import { ShieldCheck, Lock, Trash2, ArrowRight, QrCode } from 'lucide-react';

export default function PrivacyPage() {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [highlightManage, setHighlightManage] = useState(false);

  useEffect(() => {
    const checkHash = () => {
      if (typeof window !== 'undefined' && window.location.hash === '#manage-data') {
        const el = document.getElementById('manage-data');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightManage(true);
          setTimeout(() => setHighlightManage(false), 2200);
        }
      }
    };
    checkHash();
    window.addEventListener('hashchange', checkHash);
    return () => window.removeEventListener('hashchange', checkHash);
  }, []);

  const handleConfirmClearAll = () => {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (
          k &&
          (k.startsWith(APP_CONFIG.storageKey) ||
            k.startsWith('voxtab_') ||
            k === 'VOXTAB_ORDER_MAP')
        ) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
      // Clear the app's currency preference stored in sessionStorage for this browser.
      sessionStorage.removeItem('voxtab_currency');
    } catch {}
    setConfirmOpen(false);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('voxtab:reset-home'));
    }
    router.push('/?landing=1');
  };

  return (
    <div className="w-full pt-6 sm:pt-9 space-y-8 animate-fade-up">
      <div className="space-y-2.5">
        <span className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--success)]">
          Privacy &amp; Security
        </span>
          <h1 className="text-2xl sm:text-4xl font-bold text-white tracking-tight">
            Zero accounts. Total transparency.
          </h1>
<p className="text-xs sm:text-sm text-[var(--fg-muted)] max-w-2xl leading-relaxed">
  VoxTab is designed for zero-login simplicity. You never have to create an account or share financial passwords. Your working bills are saved in your browser. Receipt photos and voice instructions are processed by Google Gemini to read line items and apply your split instructions. When you share a bill link, a snapshot of the bill and your PayPal payout email are stored so friends with the link can open the bill and pay their share from their own phone.
</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="spotlight-card p-5 space-y-2">
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <ShieldCheck className="w-4 h-4 text-[var(--success)]"/>
              <h2>Browser History</h2>
            </div>
            <p className="text-xs text-[var(--fg-muted)] leading-relaxed">
              Your scanned bills and manual payment notes are saved in your browser so you can reopen or clear them anytime.
            </p>
        </div>

        <div className="spotlight-card p-5 space-y-2">
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <Lock className="w-4 h-4 text-[var(--brand)]"/>
              <h2>Shared Bill Links</h2>
            </div>
            <p className="text-xs text-[var(--fg-muted)] leading-relaxed">
              When you share a bill link, a snapshot of the bill and its PayPal payout email are stored on the server so friends can open the link and pay their share from their own phone. Anyone with the link can access the shared bill.
            </p>
        </div>

        <div className="spotlight-card p-5 space-y-2">
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <QrCode className="w-4 h-4 text-[var(--brand)]"/>
              <h2>Smart Receipt &amp; Voice Reading</h2>
            </div>
            <p className="text-xs text-[var(--fg-muted)] leading-relaxed">
              Receipt photos and voice recordings are sent to Google Gemini, our AI service, solely to read line items and understand your spoken split instructions.
            </p>
        </div>

        <div className="spotlight-card p-5 space-y-2">
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <ShieldCheck className="w-4 h-4 text-[var(--success)]"/>
              <h2>PayPal Checkout</h2>
            </div>
            <p className="text-xs text-[var(--fg-muted)] leading-relaxed">
              Friends pay you directly through PayPal QR codes and checkout links. VoxTab never sees or stores your card numbers or PayPal password.
            </p>
        </div>
      </div>

      {/* Interactive Data Wipe Control */}
      <div
        id="manage-data"
        className={`scroll-mt-24 spotlight-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all duration-500 ${
          highlightManage
            ? 'border-[var(--brand)]/65 shadow-[0_0_28px_rgba(255,217,180,0.22)]'
            : ''
        }`}
      >
        <div className="space-y-1">
          <h3 className="text-sm font-bold text-white">Manage Your Local Data</h3>
          <p className="text-xs text-[var(--fg-muted)]">
            Clear all saved receipts, payment statuses, and your stored PayPal payout email from this browser. Clearing local data does not delete shared-bill snapshots or PayPal-verified payment statuses stored on the server.
          </p>
        </div>

        <Button className="shrink-0" icon={<Trash2/>}
          onClick={() => setConfirmOpen(true)}
          size="sm"
          variant="danger"
        >
          Clear Browser Data
        </Button>
      </div>

      <div className="pt-2">
        <Link href="/">
          <Button icon={<ArrowRight/>} size="md" variant="secondary">
            Back to Bill Splitter
          </Button>
        </Link>
      </div>

      <Modal isOpen={confirmOpen} onClose={() => setConfirmOpen(false)}
        title="Clear all browser data?"
      >
        <p className="text-sm text-[var(--fg-secondary)] leading-relaxed mb-5">
          This will permanently delete all saved receipts, payment statuses, your stored PayPal payout email, and your currency preference from this browser. It does not delete shared-bill snapshots or PayPal-verified payment statuses stored on the server.
        </p>
        <div className="flex justify-end gap-2.5">
          <Button onClick={() => setConfirmOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button icon={<Trash2/>} onClick={handleConfirmClearAll} variant="danger">
            Yes, Clear Everything
          </Button>
        </div>
      </Modal>
    </div>
  );
}
