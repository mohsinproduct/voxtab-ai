/**
 * @file PayPalEmailGate.tsx
 * @description Reusable PayPal payout email capture card that preserves saved bills when updating the payout email.
 */
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui';

export const PAYEE_STORAGE_KEY = 'voxtab_payee_email';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface PayPalEmailGateProps {
  onUnlock?: (email: string) => void;
  title?: string;
  subtitle?: React.ReactNode;
  inputId?: string;
  initialEmail?: string;
}

export function PayPalEmailGate({
  onUnlock,
  title = 'Where should friends send your money?',
  subtitle = 'Enter your PayPal email to generate your personal QR codes and share links.',
  inputId = 'hero-paypal-email',
  initialEmail = '',
}: PayPalEmailGateProps) {
  const router = useRouter();
  const [emailDraft, setEmailDraft] = useState(initialEmail);
  const [emailError, setEmailError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (initialEmail) {
      setEmailDraft(initialEmail);
    } else {
      try {
        const stored = (localStorage.getItem(PAYEE_STORAGE_KEY) || '').trim();
        if (stored && EMAIL_REGEX.test(stored)) setEmailDraft(stored);
      } catch {}
    }
  }, [initialEmail]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = emailDraft.trim();
    if (!EMAIL_REGEX.test(clean)) {
      setEmailError('Please enter a valid email address (for example, name@example.com).');
      inputRef.current?.focus();
      return;
    }
    setEmailError(null);
    try {
      // Only updates the PayPal payout email; all saved bills in voxtab_ledger_vault_v1 stay untouched
      localStorage.setItem(PAYEE_STORAGE_KEY, clean);
    } catch {}
    if (onUnlock) {
      onUnlock(clean);
    } else {
      router.push('/?scan=1');
    }
  };

  return (
    <div className="spotlight-card p-4 sm:p-5 space-y-3.5 border border-[var(--brand)]/25 shadow-[0_0_40px_rgba(255,217,180,0.08)] text-left">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-9 h-9 rounded-full bg-[var(--brand-dim)] border border-[var(--brand)]/30 flex items-center justify-center text-[var(--brand)] shrink-0 shadow-[0_0_16px_var(--brand-glow)]">
          <Mail className="w-4 h-4"/>
        </div>
        <div className="min-w-0">
          <label
            htmlFor={inputId}
            className="block text-sm sm:text-base font-bold text-white cursor-pointer"
          >
            {title}
          </label>
          <p className="text-[11px] text-[var(--fg-muted)] leading-snug">
            {subtitle}</p>
      </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-row items-center gap-2">
        <div className="relative flex-1 min-w-[65%] sm:min-w-0">
          <Mail className="w-4 h-4 text-[var(--fg-muted)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"/>
          <input
            ref={inputRef}
            id={inputId}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="Enter your PayPal email"
            value={emailDraft}
            onChange={(e) => {
              setEmailDraft(e.target.value);
              if (emailError) setEmailError(null);
            }}
            className="w-full h-11 pl-9 pr-3 rounded-full bg-[var(--bg-muted)] border border-white/10 focus:border-[var(--brand)] text-xs sm:text-sm text-[var(--fg-primary)] placeholder:text-[var(--fg-muted)] outline-none transition-colors"
          />
        </div>

        <Button className="h-11 px-3.5 sm:px-6 text-xs sm:text-sm shrink-0" size="md" type="submit" variant="primary">
          <span className="sm:hidden">Start</span>
          <span className="hidden sm:inline">Start Splitting</span>
          <ArrowRight className="w-3.5 h-3.5"/>
        </Button>
      </form>

      {emailError && (
        <p className="text-xs font-semibold text-[#ff7a7a] pl-1">{emailError}</p>
      )}
      <p className="text-[10px] text-[var(--fg-muted)] leading-snug pl-1 pt-0.5">
        No account or password needed. Your email is only used to route your PayPal payouts.
      </p>
    </div>
  );
}
