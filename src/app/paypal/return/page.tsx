/**
 * @file page.tsx
 * @description /paypal/return: where PayPal sends the payer after checkout.
 * Payment status is determined exclusively by the server verification route
 * (GET /api/paypal-order?orderId=). PayerID, the return URL and browser query
 * parameters are never trusted as proof of payment.
 */
'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import confetti from 'canvas-confetti';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { orderMap, tabStorage } from '@/lib/tabStorage';
import { Button } from '@/components/ui';

type Result =
  | { state: 'checking' }
  | {
      state: 'paid' | 'cancelled' | 'pending';
      text: string;
      tabId?: string | null;
      person?: string | null;
      shareCode?: string | null;
      hasLocalTab?: boolean;
    };

export default function PayPalReturnPage() {
  const [result, setResult] = useState<Result>({ state: 'checking' });
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const isCancel = params.get('paypal') === 'cancel';
    const entry = token ? orderMap.lookup(token) : null;
    const tabId = entry?.tabId ?? params.get('paid_tab');
    const person = entry?.person ?? params.get('paid_person');

    (async () => {
      const localTab = tabId ? await tabStorage.getTab(tabId) : null;
      const shareCode = entry?.shareCode ?? null;
      if (isCancel) {
        setResult({
          state: 'cancelled',
          text: 'PayPal checkout was cancelled. Nothing was charged.',
          tabId,
          person,
          shareCode,
          hasLocalTab: Boolean(localTab),
        });
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }

      if (!token) {
        setResult({
          state: 'pending',
          text: 'This payment cannot be verified automatically. Ask the host to mark your share as paid.',
          tabId,
          person,
          shareCode,
          hasLocalTab: Boolean(localTab),
        });
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }

      // The server verification response is the only proof of payment. PayerID and
      // return-URL parameters are never trusted as proof.
      let paid = false;
      let data: { paid?: boolean; tabId?: string; shareCode?: string; participantName?: string; txId?: string } | null = null;
      try {
        const res = await fetch(`/api/paypal-order?orderId=${encodeURIComponent(token)}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          data = await res.json();
          paid = data?.paid === true;
        }
      } catch {
        paid = false;
      }

      if (!paid) {
        setResult({
          state: 'pending',
          text: 'PayPal has not confirmed this payment yet. The settle screen updates automatically once it does.',
          tabId,
          person,
          shareCode,
          hasLocalTab: Boolean(localTab),
        });
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }

      orderMap.forget(token);

      const effectiveTabId = tabId || (data?.tabId ?? null);
      const effectiveShareCode = shareCode || (data?.shareCode ?? null);
      const effectivePerson = person || (data?.participantName ?? null);
      const verifiedLocalTab = localTab ?? (effectiveTabId ? await tabStorage.getTab(effectiveTabId) : null);

      // Persist the verified status locally too, so the Settle tab on this device flips
      // to Paid immediately even when the payment was opened from a QR scan on another device.
      if (effectiveTabId && effectiveShareCode && effectivePerson && data?.txId) {
        await tabStorage.savePaidStatus(effectiveTabId, effectiveShareCode, effectivePerson, {
          isPaid: true,
          paidAt: Date.now(),
          paypalTxId: data.txId,
          source: 'paypal',
        });
      }

      setResult({
        state: 'paid',
        text: 'PayPal confirmed your payment and your share has been marked as paid.',
        tabId: effectiveTabId,
        person: effectivePerson,
        shareCode: effectiveShareCode,
        hasLocalTab: Boolean(verifiedLocalTab),
      });
      confetti();
      window.history.replaceState({}, '', window.location.pathname);
    })();
  }, []);

  if (result.state === 'checking') {
    return (
      <div className="pt-16 flex flex-col items-center gap-3 text-sm text-[var(--fg-secondary)]">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--brand-light)]" />
        Confirming payment with PayPal…
      </div>
    );
  }

  const ok = result.state === 'paid';
  const backHref =
    result.hasLocalTab && result.tabId
      ? `/tab/${encodeURIComponent(result.tabId)}/settle?from=history${
          result.person ? `&person=${encodeURIComponent(result.person)}` : ''
        }`
      : result.shareCode
        ? `/share?s=${encodeURIComponent(result.shareCode)}${
            result.person ? `&person=${encodeURIComponent(result.person)}` : ''
          }`
        : null;

  return (
    <div className="max-w-lg mx-auto pt-10 animate-fade-up">
      <div className="spotlight-card p-6 text-center space-y-4">
        {ok ? (
          <CheckCircle2 className="w-12 h-12 mx-auto text-[var(--success)]" />
        ) : (
          <AlertCircle className="w-12 h-12 mx-auto text-amber-400" />
        )}
        <h1 className="text-lg font-extrabold text-[var(--fg-primary)]">
          {ok ? 'Payment confirmed!' : result.state === 'cancelled' ? 'Checkout cancelled' : 'Not confirmed yet'}
        </h1>
        <p className="text-sm text-[var(--fg-secondary)]">{result.text}</p>
        {backHref && (
          <Link href={backHref}>
            <Button className="w-full">Back to the bill</Button>
          </Link>
        )}
      </div>
    </div>
  );
}
