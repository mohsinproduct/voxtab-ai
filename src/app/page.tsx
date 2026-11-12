/**
 * @file page.tsx
 * @description Two-stage home: a landing overview followed by the scanner workspace
 * where users snap receipts, speak or type their split, and proceed to settlement.
 */
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TabLedger } from '@/types/tab';
import { normalizeLedger, toUnassignedRows } from '@/lib/ledgerUtils';
import { tabStorage } from '@/lib/tabStorage';
import { toWizardParticipants } from '@/lib/participants';
import { StepCapture } from '@/components/StepCapture';
import { WIZARD_STEPS } from '@/components/ScreenHeader';
import { PayPalEmailGate, PAYEE_STORAGE_KEY } from '@/components/PayPalEmailGate';
import { StepIndicator, Skeleton } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  CheckCircle2,
  ArrowRight,
  Mic,
  Check,
  X,
  QrCode,
} from 'lucide-react';

const MARQUEE_ITEMS = [
  'Group Dinners',
  'Roommate Groceries',
  'Pharmacy Runs',
  'Road Trip Snacks',
  'Office Lunches',
  'Weekend Trips',
  'House Supplies',
  'Coffee Runs',
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const PROOF_CARDS = [
    {
      stat: '0 logins',
      desc: 'Friends pay from their browser in one tap',
    },
    {
      stat: '0 setup',
      desc: 'Snap a photo and say who had what',
    },
    {
      stat: '0 cost',
      desc: 'Free to split bills with no hidden fees',
    },
  ];

const FAQS = [
  {
    q: 'Do my friends need to download an app or create an account?',
    a: 'No. When you share the bill link in your group chat or show your phone screen, friends simply open the link in their browser, tap their name, and pay their exact share on PayPal.',
  },
  {
    q: 'What if we shared appetizers or bought multiple of the same drink?',
    a: 'Just say it naturally, like "Ali and Sara shared the nachos" or "Bilal took 2 cold brews and we split the rest." VoxTab divides multi-quantity items and shared plates automatically.',
  },
  {
    q: 'How are tax, tip, and discounts calculated?',
    a: 'Tax, service charges, and discounts are split proportionally based on what each person ordered, down to the exact cent. You can also split the tip equally, proportionally, or assign it to one person.',
  },
  {
    q: 'Can we pass the phone around so everyone speaks their own items?',
    a: "Yes. You can read out the whole table's order in one go, or tap the mic multiple times as each friend claims what they had. Every turn updates the same receipt live.",
  },
  {
    q: 'How do I get paid back and track who has paid?',
    a: 'Your PayPal email is used to generate a personalized checkout link and QR code for each friend\'s share. As soon as a friend completes checkout, their card flips to Paid on your screen.',
  },
];

function buildSampleFallbackLedger(): TabLedger {
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const sampleItems = [
    { id: 'item_1', name: 'Artisan Pizza Pack', priceCents: 1800, quantity: 1 },
    { id: 'item_2', name: 'Organic Cold Brew', priceCents: 2800, quantity: 2 },
    { id: 'item_3', name: 'Sparkling Water', priceCents: 1200, quantity: 3 },
    { id: 'item_4', name: 'First Aid & Vitamins', priceCents: 1000, quantity: 1 },
    { id: 'item_5', name: 'Household Essentials', priceCents: 1200, quantity: 1 },
  ];
  return normalizeLedger({
    id: `tab_${now}`,
    title: 'METRO CORNER MARKET',
    merchant: 'METRO CORNER MARKET',
    date: today,
    items: sampleItems.map((it) => ({
      ...it,
      assignedTo: ['split'],
      category: 'general',
      isTaxInclusive: false,
      ruleSummary: 'Split equally',
    })),
    rows: sampleItems.map((it) => ({
      id: it.id,
      description: it.name,
      quantity: it.quantity,
      amountCents: it.priceCents,
      assignedTo: 'split',
      taxPct: 0.085,
      isTaxInclusive: false,
      ruleSummary: 'Split equally',
    })),
    participants: [],
    subtotalCents: 8000,
    taxCents: 680,
    taxPercentage: 8.5,
    isTaxInclusive: false,
    taxType: 'exclusive',
    serviceChargeCents: 0,
    discountCents: 0,
    roundOffCents: 0,
    tipCents: 0,
    totalCents: 8680,
    createdAt: now,
    updatedAt: now,
  });
}

export default function HomePage() {
  const router = useRouter();
  const { fmtMoney } = useI18n();
  const [receiptImage, setReceiptImage] = useState<string | null>(null);
  const [isSampleStaged, setIsSampleStaged] = useState<boolean>(false);
  const [payeeEmail, setPayeeEmail] = useState<string>('');
  const [workspaceOpen, setWorkspaceOpen] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState<boolean>(false);

  // Sequential highlight across the 3 proof cards
  const [activeProofIdx, setActiveProofIdx] = useState<number>(0);
  const [hoveredProofIdx, setHoveredProofIdx] = useState<number | null>(null);

  // Active stacked card in "How It Works" (0 = Step 1, 1 = Step 2, 2 = Step 3)
  const [activeStepCard, setActiveStepCard] = useState<number>(0);
  const [stackExitOffset, setStackExitOffset] = useState<number>(0);
  const [step3Phase, setStep3Phase] = useState<'scanning' | 'paid'>('paid');
  const howHeaderRef = useRef<HTMLDivElement | null>(null);
  const [howHeaderHeight, setHowHeaderHeight] = useState<number>(116);
  const stepCard1Ref = useRef<HTMLDivElement | null>(null);
  const stepCard2Ref = useRef<HTMLDivElement | null>(null);
  const stepCard3Ref = useRef<HTMLDivElement | null>(null);

  // FAQs always start closed (null) on page load or refresh
  const [openFaqIdx, setOpenFaqIdx] = useState<number | null>(null);
  const [heroAnimKey, setHeroAnimKey] = useState<number>(0);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const prefetchRef = useRef<{
    image: string;
    promise: Promise<{ ok: boolean; status: number; data: any }>;
  } | null>(null);

  const scrollToFaqSection = useCallback(() => {
    setWorkspaceOpen(false);
    setTimeout(() => {
      const faqEl = document.getElementById('faq');
      if (faqEl) {
        faqEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    try {
      const savedEmail = (localStorage.getItem(PAYEE_STORAGE_KEY) || '').trim();
      if (savedEmail && EMAIL_REGEX.test(savedEmail)) {
        setPayeeEmail(savedEmail);
      }

      if (hash === '#faq' || params.get('faq') === '1') {
        setWorkspaceOpen(false);
        setTimeout(() => {
          document.getElementById('faq')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
      } else if (params.get('landing') === '1') {
        setWorkspaceOpen(false);
      } else if (savedEmail && EMAIL_REGEX.test(savedEmail)) {
        setWorkspaceOpen(true);
      } else if (params.get('scan') === '1') {
        setWorkspaceOpen(true);
      }
    } catch {}
    setHydrated(true);

    if (params.get('tab')) {
      setForwarding(true);
      const nextHash = new URLSearchParams();
      nextHash.set('tab', params.get('tab')!);
      if (params.get('person')) nextHash.set('person', params.get('person')!);
      router.replace(`/share#${nextHash.toString()}`);
    } else if (params.get('paypal') || params.get('token') || params.get('paid_tab')) {
      setForwarding(true);
      router.replace(`/paypal/return${window.location.search}`);
    }

    const handleResetHome = () => {
      abortRef.current?.abort();
      prefetchRef.current = null;
      setParsing(false);
      setReceiptImage(null);
      setIsSampleStaged(false);
      setError(null);
      setOpenFaqIdx(null);
      try {
        const currentSaved = (localStorage.getItem(PAYEE_STORAGE_KEY) || '').trim();
        setPayeeEmail(currentSaved && EMAIL_REGEX.test(currentSaved) ? currentSaved : '');
      } catch {
        setPayeeEmail('');
      }
      // Clicking the VoxTab logo always returns to the landing page (Stage A)
      setWorkspaceOpen(false);
      setHeroAnimKey((k) => k + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleOpenScanner = () => {
      setWorkspaceOpen(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    window.addEventListener('voxtab:reset-home', handleResetHome);
    window.addEventListener('voxtab:open-scanner', handleOpenScanner);
    window.addEventListener('voxtab:open-faq', scrollToFaqSection);
    return () => {
      window.removeEventListener('voxtab:reset-home', handleResetHome);
      window.removeEventListener('voxtab:open-scanner', handleOpenScanner);
      window.removeEventListener('voxtab:open-faq', scrollToFaqSection);
      abortRef.current?.abort();
    };
  }, [router, scrollToFaqSection]);

  const startBackgroundPrefetch = useCallback((img: string | null) => {
    abortRef.current?.abort();
    prefetchRef.current = null;
    if (!img) return;

    const controller = new AbortController();
    abortRef.current = controller;

    const promise = fetch('/api/parse-tab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: img }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, data };
      })
      .catch((err) => ({ ok: false, status: 0, data: null, err }));

    prefetchRef.current = { image: img, promise };
  }, []);

  const handleSelectReceiptImage = useCallback(
    (img: string | null, isSample = false) => {
      setReceiptImage(img);
      setIsSampleStaged(Boolean(img && isSample));
      setError(null);
      if (img && !isSample) {
        startBackgroundPrefetch(img);
      } else {
        abortRef.current?.abort();
        prefetchRef.current = null;
      }
    },
    [startBackgroundPrefetch]
  );

  // Cycle the warm amber highlight from left to right (0 logins -> 0 setup -> 0 cost)
  useEffect(() => {
    if (workspaceOpen || hoveredProofIdx !== null) return;
    const timer = setInterval(() => {
      setActiveProofIdx((prev) => (prev + 1) % PROOF_CARDS.length);
    }, 2200);
    return () => clearInterval(timer);
  }, [workspaceOpen, hoveredProofIdx]);

  // Loop the Step 03 QR scan -> Paid [✓] preview animation when Step 03 is active
  useEffect(() => {
    if (workspaceOpen || activeStepCard !== 2) {
      setStep3Phase('paid');
      return;
    }
    setStep3Phase('scanning');
    const interval = setInterval(() => {
      setStep3Phase((prev) => (prev === 'scanning' ? 'paid' : 'scanning'));
    }, 1800);
    return () => clearInterval(interval);
  }, [workspaceOpen, activeStepCard]);

  // Track active stacked card, dynamic header height, and synchronized scroll-out
  useEffect(() => {
    if (!hydrated || workspaceOpen) return;

    const handleScroll = () => {
      const hdrH = howHeaderRef.current?.offsetHeight || 116;
      setHowHeaderHeight((prev) => (prev !== hdrH ? hdrH : prev));

      const c1 = stepCard1Ref.current?.getBoundingClientRect();
      const c2 = stepCard2Ref.current?.getBoundingClientRect();
      const c3 = stepCard3Ref.current?.getBoundingClientRect();
      if (!c1 || !c2 || !c3) return;

      if (c3.top <= c2.top + 115) {
        setActiveStepCard(2);
      } else if (c2.top <= c1.top + 115) {
        setActiveStepCard(1);
      } else {
        setActiveStepCard(0);
      }

      // Card 1 pins at 64 + hdrH + 14; Card 2 at +26; Card 3 at +38
      const pinnedTop3 = 64 + hdrH + 38;
      if (c3.top < pinnedTop3) {
        setStackExitOffset(c3.top - pinnedTop3);
      } else {
        setStackExitOffset(0);
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });
    handleScroll();
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [hydrated, workspaceOpen]);

  // IntersectionObserver for scroll-reveal sections (including left/right comparison slide-in)
  useEffect(() => {
    if (!hydrated || workspaceOpen) return;
    const nodes = document.querySelectorAll('.reveal-on-scroll, .reveal-from-left, .reveal-from-right');
    if (!nodes.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
          }
        });
      },
      { threshold: 0.14 }
    );

    nodes.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [hydrated, workspaceOpen]);

  const focusEmailGate = () => {
    const el = document.getElementById('hero-paypal-email');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => (el as HTMLInputElement).focus(), 300);
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const scan = useCallback(
    async (imgOverride?: string) => {
      const image = imgOverride || receiptImage;
      if (!image) return;

      setParsing(true);
      setError(null);

      // Run 3 to 4 top-to-bottom laser passes (0.82s per pass => ~2.5s for 3 passes or ~3.3s for 4 passes)
      const passes = Math.random() < 0.5 ? 3 : 4;
      const scanDurationMs = passes * 820;
      const minAnimPromise = new Promise((r) => setTimeout(r, scanDurationMs));

      try {
        const cleanEmail = payeeEmail.trim();

        // If the user clicked "Try sample", run the 3-4 laser passes and use the deterministic sample receipt
        if (isSampleStaged) {
          await minAnimPromise;
          const fresh = buildSampleFallbackLedger();
          const ledger: TabLedger = {
            ...fresh,
            payeeEmail: cleanEmail && EMAIL_REGEX.test(cleanEmail) ? cleanEmail : undefined,
            participants: [],
            scanBaseline: {
              rows: toUnassignedRows(fresh.rows),
              discountCents: 0,
              tipCents: 0,
            },
          };
          await tabStorage.saveTab(ledger);
          router.push(`/tab/${encodeURIComponent(ledger.id)}/assign`);
          return;
        }

        let activePrefetch = prefetchRef.current;
        if (!activePrefetch || activePrefetch.image !== image) {
          startBackgroundPrefetch(image);
          activePrefetch = prefetchRef.current;
        }

        const [result] = await Promise.all([activePrefetch!.promise, minAnimPromise]);

        if (!result.ok || !result.data?.ledger?.items?.length) {
          const controller = new AbortController();
          abortRef.current = controller;
          const retryRes = await fetch('/api/parse-tab', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image }),
            signal: controller.signal,
          });
          const retryData = await retryRes.json().catch(() => null);
          if (!retryRes.ok || !retryData?.ledger?.items?.length) {
            setError(
              retryData?.message ||
                `Could not read the receipt (HTTP ${retryRes.status}). Try again or retake the photo.`
            );
            return;
          }
          result.data = retryData;
        }

        const fresh = normalizeLedger(result.data.ledger as TabLedger);
        const ledger: TabLedger = {
          ...fresh,
          payeeEmail: cleanEmail && EMAIL_REGEX.test(cleanEmail) ? cleanEmail : undefined,
          participants: toWizardParticipants(fresh.participants),
          scanBaseline: {
            rows: toUnassignedRows(fresh.rows),
            discountCents: fresh.discountCents || 0,
            tipCents: fresh.tipCents || 0,
          },
        };
        await tabStorage.saveTab(ledger);
        router.push(`/tab/${encodeURIComponent(ledger.id)}/assign`);
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        setParsing(false);
      }
    },
    [receiptImage, isSampleStaged, payeeEmail, router, startBackgroundPrefetch]
  );

  if (forwarding || !hydrated) {
    return (
      <div className="pt-8 space-y-4">
        <Skeleton className="h-8 w-48"/>
        <Skeleton className="h-64 w-full"/>
      </div>
    );
  }

  /* ────────────────────────────────────────────────────────────
     STAGE B: UNLOCKED RECEIPT SCANNER WORKSPACE
     ──────────────────────────────────────────────────────────── */
  if (workspaceOpen) {
    return (
      <div className="animate-fade-up space-y-4">
        <div className="pt-5 pb-2 sm:pt-7 sm:pb-3 space-y-4">
          <StepIndicator current={1} steps={WIZARD_STEPS}/>

          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                Snap the receipt
              </h1>
              <p className="text-xs sm:text-sm text-[var(--fg-muted)]">
                Take a clear photo or upload an image to read every item and price.
              </p>
            </div>
          </div>
        </div>

        {/* Active PayPal Payout Bar with Change email option (never deletes past bills) */}
        <div className="spotlight-card px-4 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
            <span className="text-xs text-[var(--fg-muted)] shrink-0">PayPal payouts:</span>
            <span className="text-xs font-bold text-[var(--fg-primary)] truncate">
              {payeeEmail || 'Not set'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => {
              setReceiptImage(null);
              setIsSampleStaged(false);
              setWorkspaceOpen(false);
            }}
            className="text-xs font-semibold text-[var(--brand)] hover:underline shrink-0 cursor-pointer"
          >
            Change email
          </button>
        </div>

        <div className="spotlight-card p-4 sm:p-6">
          <StepCapture error={error} loading={parsing} onNext={scan} onSetImage={handleSelectReceiptImage} receiptImage={receiptImage}/>
        </div>
      </div>
    );
  }

  /* ────────────────────────────────────────────────────────────
     STAGE A: PRODUCT WEBSITE (Gated by PayPal Email)
     ──────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-14 sm:space-y-16 pt-6 sm:pt-10 pb-6">
      {/* 1. HERO + PAYPAL EMAIL GATE */}
      <section key={heroAnimKey} className="animate-fade-up space-y-6">
        <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--bg-surface)] border border-white/10 text-[11px] font-semibold text-[var(--brand)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)] animate-pulse" />
          <span>Voice-First Bill Splitter for Groups</span>
        </div>

        <div className="space-y-3.5">
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-white leading-[1.08]">
            Snap the bill.<br />
            <span className="italic font-serif text-[var(--brand)]">Say</span> who had what.<br />
            Get paid back.
          </h1>
          <p className="text-sm sm:text-base text-[var(--fg-muted)] max-w-2xl leading-relaxed">
            Stop passing paper receipts around the table or typing 25 grocery items into a calculator. Snap one photo, speak the split in plain English, and let friends pay their share on PayPal.
          </p>
        </div>

        <PayPalEmailGate initialEmail={payeeEmail} onUnlock={(cleanEmail) => {
            setPayeeEmail(cleanEmail);
            setReceiptImage(null);
            setIsSampleStaged(false);
            setWorkspaceOpen(true);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />

        {/* 3 Original Proof Cards: 0 logins, 0 setup, 0 cost */}
        <div
          className="grid grid-cols-3 gap-2 sm:gap-4 pt-1 items-stretch"
          onMouseLeave={() => setHoveredProofIdx(null)}
        >
          {PROOF_CARDS.map((card, idx) => {
            const currentActive = hoveredProofIdx !== null ? hoveredProofIdx : activeProofIdx;
            const isHighlighted = currentActive === idx;

            return (
              <div
                key={card.stat}
                onMouseEnter={() => {
                  setHoveredProofIdx(idx);
                  setActiveProofIdx(idx);
                }}
                onTouchStart={() => {
                  setHoveredProofIdx(idx);
                  setActiveProofIdx(idx);
                }}
                onTouchEnd={() => setHoveredProofIdx(null)}
                className={`spotlight-card p-2.5 sm:p-4 flex flex-col justify-between cursor-default transition-all duration-300 ${
                  isHighlighted
                    ? 'border-[var(--brand)]/50 shadow-[0_0_24px_rgba(255,217,180,0.16)] -translate-y-1'
                    : 'border-white/8 hover:-translate-y-1 hover:border-[var(--brand)]/40'
                }`}
              >
                <p
                  className={`mono text-[13px] sm:text-xl font-bold tracking-tight transition-colors duration-300 ${
                    isHighlighted ? 'text-[var(--brand)]' : 'text-white'
                  }`}
                >
                  {card.stat}
                </p>
                <p className="text-[10px] sm:text-xs text-[var(--fg-muted)] mt-1 leading-tight sm:leading-snug">
                  {card.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. INFINITE USE-CASE MARQUEE */}
      <section className="overflow-hidden py-3 border-y border-white/10 -mx-4 sm:mx-0 sm:rounded-full sm:border sm:px-2 bg-[var(--bg-surface)]/50">
        <div className="marquee-track items-center gap-6">
          {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((label, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-3 text-xs font-semibold text-[var(--fg-secondary)] whitespace-nowrap"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)]" />
              <span>{label}</span>
            </span>
          ))}
        </div>
      </section>

      {/* 3. HOW VOXTAB WORKS (Covered cards hide inner content so background text never pokes out) */}
      <section className="relative">
        <div
          ref={howHeaderRef}
          style={
            stackExitOffset < 0
              ? { transform: `translateY(${stackExitOffset}px)` }
              : undefined
          }
          className="sticky top-16 z-30 bg-[var(--bg-app)] pt-3.5 pb-4 mb-4 flex items-end justify-between gap-3 border-b border-white/10"
        >
          <div className="space-y-1">
            <span className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--brand)] block">
              How It Works
            </span>
            <h2 className="text-lg sm:text-3xl font-bold text-white tracking-tight leading-snug">
              From crumpled paper to <span className="italic font-serif text-[var(--brand)]">settled</span> in three steps.
            </h2>
          </div>
          <Link className="pill-btn-glow inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold shrink-0" href="/how-it-works">
            <span>Learn more</span>
            <ArrowRight className="w-3.5 h-3.5 text-[var(--brand)]"/>
          </Link>
        </div>

        {/* Stacking Cards Container: 12px rim per card, covered cards hide their inner text */}
        <div className="space-y-14 sm:space-y-16">
          {/* STEP 01 CARD */}
          <div
            ref={stepCard1Ref}
            style={{
              top: `${64 + howHeaderHeight + 14}px`,
              ...(stackExitOffset < 0
                ? { transform: `translateY(${stackExitOffset}px) scale(0.97)` }
                : {}),
            }}
            className={`sticky z-10 origin-top spotlight-card p-4 sm:p-6 shadow-[0_12px_32px_rgba(0,0,0,0.5)] transition-all duration-300 ${
              activeStepCard === 1
                ? 'scale-[0.985] border-white/15'
                : activeStepCard >= 2
                ? 'scale-[0.97] border-white/10'
                : 'scale-100'
            }`}
          >
            <div
              className={`grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-5 items-center transition-opacity duration-200 ${
                activeStepCard >= 1 ? 'opacity-0 pointer-events-none select-none' : 'opacity-100'
              }`}
            >
              <div className="sm:col-span-7 space-y-1.5">
                <span className="mono text-[11px] font-bold uppercase tracking-wider text-[var(--brand)]">
                  Step 01
                </span>
                <h3 className="text-base sm:text-lg font-bold text-white">
                  Snap the paper bill
                </h3>
                <p className="text-xs sm:text-sm text-[var(--fg-muted)] leading-relaxed">
                  Snap a photo of any restaurant check, grocery run, or pharmacy receipt. Every item, quantity, tax line, and discount appears on your screen in seconds.
                </p>
              </div>

              <div className="sm:col-span-5 relative rounded-xl bg-[var(--bg-muted)] border border-white/10 p-3 overflow-hidden h-28 sm:h-32 flex flex-col justify-between">
                <div className="flex items-center justify-between text-[10px] font-bold text-[var(--fg-secondary)]">
                  <span>METRO MARKET</span>
                  <span className="mono text-[var(--brand)]">{fmtMoney(8680)}</span>
                </div>
                <div className="space-y-1 text-[10px] text-[var(--fg-muted)] mono">
                  <div className="flex justify-between">
                    <span>1x Artisan Pizza</span>
                    <span>{fmtMoney(1800)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>2x Cold Brew</span>
                    <span>{fmtMoney(2800)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>3x Sparkling Water</span>
                    <span>{fmtMoney(1200)}</span>
                  </div>
                </div>
                <div className={`scan-laser-line ${activeStepCard >= 1 ? 'scan-laser-paused' : ''}`} />
              </div>
            </div>
          </div>

          {/* STEP 02 CARD */}
          <div
            ref={stepCard2Ref}
            style={{
              top: `${64 + howHeaderHeight + 26}px`,
              ...(stackExitOffset < 0
                ? { transform: `translateY(${stackExitOffset}px) scale(0.985)` }
                : {}),
            }}
            className={`sticky z-20 origin-top spotlight-card p-4 sm:p-6 shadow-[0_-18px_38px_rgba(0,0,0,0.85)] transition-all duration-300 ${
              activeStepCard >= 2 ? 'scale-[0.985] border-white/15' : 'scale-100'
            }`}
          >
            <div
              className={`grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-5 items-center transition-opacity duration-200 ${
                activeStepCard >= 2 ? 'opacity-0 pointer-events-none select-none' : 'opacity-100'
              }`}
            >
              <div className="sm:col-span-7 space-y-1.5">
                <span className="mono text-[11px] font-bold uppercase tracking-wider text-[var(--brand)]">
                  Step 02
                </span>
                <h3 className="text-base sm:text-lg font-bold text-white">
                  Just say who had what
                </h3>
                <p className="text-xs sm:text-sm text-[var(--fg-muted)] leading-relaxed">
                  Talk like a normal person: &ldquo;Ali had the pizza, Sara took 1 cold brew, we shared the rest, add $5 tip.&rdquo; Everyone&apos;s exact share updates live.
                </p>
              </div>

              <div className="sm:col-span-5 rounded-xl bg-[var(--bg-muted)] border border-white/10 p-3 h-28 sm:h-32 flex flex-col justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-7 h-7 rounded-full bg-[var(--brand)] text-[#1b1418] flex items-center justify-center shrink-0 shadow-[0_0_12px_var(--brand-glow)]">
                    <Mic className="w-3.5 h-3.5"/>
                  </span>
                  <div className="flex items-center gap-1 h-4">
                    {[0, 150, 300, 100, 250, 400, 180].map((delay, i) => (
                      <span
                        key={i}
                        className={`w-1 h-3.5 rounded-full bg-[var(--brand)] wave-bar ${
                          activeStepCard !== 1 ? 'wave-bar-paused' : ''
                        }`}
                        style={{ animationDelay: `${delay}ms` }}
                      />
                    ))}
                  </div>
                  <span className="text-[10px] font-semibold text-[var(--brand)] ml-auto">Voice</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="px-2 py-0.5 rounded-full bg-[var(--bg-surface)] border border-white/10 text-[10px] font-semibold text-white">
                    Ali · <span className="mono text-[var(--brand)]">{fmtMoney(3420)}</span>
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-[var(--bg-surface)] border border-white/10 text-[10px] font-semibold text-white">
                    Sara · <span className="mono text-[var(--brand)]">{fmtMoney(2630)}</span>
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-[var(--bg-surface)] border border-white/10 text-[10px] font-semibold text-white">
                    Bilal · <span className="mono text-[var(--brand)]">{fmtMoney(2630)}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* STEP 03 CARD */}
          <div
            ref={stepCard3Ref}
            style={{ top: `${64 + howHeaderHeight + 38}px` }}
            className="sticky z-[25] origin-top spotlight-card p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-5 items-center border-[var(--brand)]/35 shadow-[0_-18px_38px_rgba(0,0,0,0.9)] transition-all duration-300"
          >
            <div className="sm:col-span-7 space-y-1.5">
              <span className="mono text-[11px] font-bold uppercase tracking-wider text-[var(--brand)]">
                Step 03
              </span>
              <h3 className="text-base sm:text-lg font-bold text-white">
                Friends pay in one tap
              </h3>
                <p className="text-xs sm:text-sm text-[var(--fg-muted)] leading-relaxed">
                  Send one link to the group chat or show the QR codes on your phone. As each friend pays on PayPal, their status flips to Paid automatically.
                </p>
            </div>

            <div className="sm:col-span-5 relative rounded-xl bg-[var(--bg-muted)] border border-white/10 p-3 h-28 sm:h-32 flex flex-col justify-between overflow-hidden">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <div className="relative w-6 h-6 rounded-md bg-white/10 border border-white/15 flex items-center justify-center">
                    <QrCode className="w-3.5 h-3.5 text-[var(--brand)]"/>
                    {activeStepCard === 2 && step3Phase === 'scanning' && (
                      <span className="absolute inset-0 rounded-md ring-2 ring-[var(--brand)] animate-ping opacity-60" />
                    )}
                  </div>
                  <span className="text-xs font-bold text-white">Sara&apos;s Share</span>
                </div>
                <span className="mono text-xs font-bold text-white">{fmtMoney(2630)}</span>
              </div>

              {activeStepCard === 2 && step3Phase === 'scanning' ? (
                <div className="relative flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--brand)]/40 overflow-hidden animate-fade-in">
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-[var(--brand)]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)] animate-ping" />
                      Scanning PayPal QR…
                    </span>
                  <QrCode className="w-3 h-3 text-[var(--brand)]"/>
                </div>
              ) : (
                <div
                  className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#009cde]/18 border border-[#38bdf8]/40 transition-all animate-fade-in ${
                    activeStepCard === 2 ? 'shadow-[0_0_18px_rgba(56,189,248,0.25)]' : ''
                  }`}
                >
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--success)]">
                    <CheckCircle2 className="w-3 h-3"/>
                    Paid via PayPal
                  </span>
                  <span className="w-4 h-4 rounded-full bg-[var(--success)] text-[#1b1418] flex items-center justify-center">
                    <Check className="w-2.5 h-2.5 stroke-[3]"/>
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 4. THE OLD WAY VS. VOXTAB (Simultaneous Left & Right Viewport Slide-In) */}
      <section className="reveal-on-scroll grid grid-cols-1 sm:grid-cols-2 gap-4 overflow-hidden">
        <div className="reveal-from-left spotlight-card p-5 space-y-2.5 opacity-90">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#ff7a7a]">
            The Old Way
          </span>
          <h3 className="text-sm sm:text-base font-bold text-white">
            15 minutes of table math
          </h3>
          <ul className="space-y-1.5 text-xs text-[var(--fg-muted)]">
            <li className="flex items-center gap-1.5">
              <X className="w-3.5 h-3.5 text-[#ff7a7a] shrink-0"/>
              <span>Passing a long paper receipt around the table</span>
            </li>
            <li className="flex items-center gap-1.5">
              <X className="w-3.5 h-3.5 text-[#ff7a7a] shrink-0"/>
              <span>Forgetting to include tax and tip on shared items</span>
            </li>
            <li className="flex items-center gap-1.5">
              <X className="w-3.5 h-3.5 text-[#ff7a7a] shrink-0"/>
              <span>Typing every price into a calculator or notes app</span>
            </li>
            <li className="flex items-center gap-1.5">
              <X className="w-3.5 h-3.5 text-[#ff7a7a] shrink-0"/>
              <span>Texting friends reminders to pay you back days later</span>
            </li>
          </ul>
        </div>

        <div className="reveal-from-right spotlight-card p-5 space-y-2.5 border-[var(--brand)]/35">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--brand)]">
            With VoxTab
          </span>
          <h3 className="text-sm sm:text-base font-bold text-white">
            Done before you leave the table
          </h3>
          <ul className="space-y-1.5 text-xs text-[var(--fg-secondary)]">
            <li className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-[var(--success)] shrink-0"/>
              <span>One photo reads every item and price</span>
            </li>
            <li className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-[var(--success)] shrink-0"/>
              <span>One spoken sentence assigns the whole group</span>
            </li>
            <li className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-[var(--success)] shrink-0"/>
              <span>Tax, tip, and discounts split fairly to the cent</span>
            </li>
            <li className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-[var(--success)] shrink-0"/>
              <span>Instant PayPal QR codes and shareable bill links</span>
            </li>
          </ul>
        </div>
      </section>

      {/* 5. FAQ ACCORDION (All Closed by Default on Load & Refresh) */}
      <section id="faq" className="scroll-mt-24 reveal-on-scroll space-y-4">
        <div className="space-y-1">
          <span className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--brand)]">
            Questions
          </span>
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
            Good to know before you split
          </h2>
        </div>

        <div className="space-y-2.5">
          {FAQS.map((item, idx) => {
            const isOpen = openFaqIdx === idx;
            return (
              <button
                key={idx}
                type="button"
                aria-expanded={isOpen}
                aria-controls={`faq-panel-${idx}`}
                onClick={() => setOpenFaqIdx((prev) => (prev === idx ? null : idx))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenFaqIdx((prev) => (prev === idx ? null : idx));
                  }
                }}
                className={`spotlight-card w-full text-left px-5 py-4 transition-all duration-200 ${
                  isOpen
                    ? 'bg-[#211c27] border-[var(--brand)]/35 shadow-[0_0_24px_rgba(255,217,180,0.06)]'
                    : 'bg-[#19151d]/90 border-white/8 hover:border-white/15'
                }`}
              >
                <div className="flex items-center justify-between gap-4 text-xs sm:text-sm font-bold text-white">
                  <span>{item.q}</span>
                  <span className="text-[var(--brand)] text-base font-normal leading-none shrink-0">
                    {isOpen ? '−' : '+'}
                  </span>
                </div>
                {isOpen && (
                  <p id={`faq-panel-${idx}`} className="text-xs sm:text-[13px] text-[var(--fg-muted)] leading-relaxed pt-2.5 animate-fade-in">
                    {item.a}
                  </p>
                )}
              </button>
            );
          })}
        </div>

        <div className="pt-2 flex justify-center">
          <button
            type="button"
            onClick={focusEmailGate}
            className="pill-btn-glow inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full text-xs font-bold text-[var(--brand)] cursor-pointer"
          >
            <span>Enter Your PayPal Email to Start ↑</span>
          </button>
        </div>
      </section>
    </div>
  );
}
