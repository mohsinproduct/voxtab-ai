/**
 * @file page.tsx
 * @description /how-it-works: Visual guide with top section jump pills (Three Steps, Voice Examples,
 * Use Cases) placed right between Product Guide and the main heading, glowing all cards in whichever
 * section the user clicks or navigates to.
 */
'use client';

import React, { useEffect, useState } from 'react';
import { PayPalEmailGate } from '@/components/PayPalEmailGate';
import {
  Camera,
  Mic,
  QrCode,
  Utensils,
  ShoppingBag,
  Home,
  Car,
  Check,
} from 'lucide-react';

const STEP_CARDS = [
  {
    step: 'Step 01',
    icon: Camera,
    title: 'Snap the receipt',
    desc: 'Take a photo or upload a receipt image. Every item, quantity, tax rate, and discount is read automatically.',
  },
  {
    step: 'Step 02',
    icon: Mic,
    title: 'Say who had what',
    desc: 'Speak in one go or pass the phone around. You can also type or edit your instructions anytime.',
  },
  {
    step: 'Step 03',
    icon: QrCode,
    title: 'Share or scan QR',
    desc: 'Show QR codes on your phone or share one link to the group chat so friends can pay their share on PayPal in seconds.',
  },
];

const VOICE_EXAMPLES = [
  {
    category: 'Assigning individual items',
    phrase: 'My name is Ali, I had the burger and fries, Sara had the iced latte.',
    result: 'Assigns the burger and fries to Ali, and the latte to Sara.',
  },
  {
    category: 'Splitting multi-quantity items',
    phrase: 'Bilal took 2 cold brews, Zaid and I shared the other 1.',
    result: 'Charges Bilal for 2 units and splits the remaining unit 0.5× each.',
  },
  {
    category: 'Sharing & exclusions',
    phrase: 'Everyone shared the nachos except Sara.',
    result: 'Divides the nachos equally among the rest of the group.',
  },
  {
    category: 'Percentages, tips & discounts',
    phrase: 'Omar pays 70% of the pizza, add a $6 tip split equally, $4 discount.',
    result: 'Splits the pizza 70/30, applies the $4 discount, and divides the $6 tip.',
  },
];

const USE_CASES = [
  {
    id: 'use-case-dinners',
    icon: Utensils,
    title: 'Group Dinners & Cafes',
    desc: 'Someone ordered a steak and someone ordered a coffee. Everyone pays for what they actually ordered plus their fair share of tax and tip.',
  },
  {
    id: 'use-case-groceries',
    icon: ShoppingBag,
    title: 'Roommate Grocery Runs',
    desc: 'Snap a 30-item supermarket or pharmacy receipt. Claim your personal items by voice and split household supplies equally.',
  },
  {
    id: 'use-case-trips',
    icon: Car,
    title: 'Road Trips & Weekend Getaways',
    desc: 'Keep track of snacks, gas station stops, and group takeout without asking friends to download an expense app.',
  },
  {
    id: 'use-case-house',
    icon: Home,
    title: 'Pharmacy & House Supplies',
    desc: 'Send one link to the Slack or WhatsApp group. Each person taps their name and pays you back on PayPal in seconds.',
  },
];

const GLOW_CLASS =
  'border-[var(--brand)]/65 shadow-[0_0_28px_rgba(255,217,180,0.24)] -translate-y-0.5';

export default function HowItWorksPage() {
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const triggerHighlight = (id: string) => {
    setHighlightedId(id);
    setTimeout(() => {
      setHighlightedId((curr) => (curr === id ? null : curr));
    }, 2200);
  };

  useEffect(() => {
    const scrollToHash = () => {
      if (typeof window === 'undefined') return;
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash) return;
      const target = document.getElementById(hash);
      if (target) {
        setTimeout(() => {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          triggerHighlight(hash);
        }, 80);
      }
    };

    const handleCustomHighlight = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) triggerHighlight(detail);
    };

    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    window.addEventListener('voxtab:highlight-section', handleCustomHighlight);
    return () => {
      window.removeEventListener('hashchange', scrollToHash);
      window.removeEventListener('voxtab:highlight-section', handleCustomHighlight);
    };
  }, []);

  const jumpTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      triggerHighlight(id);
    }
  };

  const isStepsGlowing = highlightedId === 'steps';
  const isVoiceGlowing = highlightedId === 'voice-examples';

  return (
    <div className="pt-6 sm:pt-9 space-y-12 animate-fade-up">
      {/* Header with Section Quick-Jump Pills between Product Guide and Title */}
      <div className="space-y-3.5 w-full">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <span className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--brand)]">
            Product Guide
          </span>

          <div className="flex flex-wrap items-center gap-2">
            {[
              { id: 'steps', label: 'Three Steps' },
              { id: 'voice-examples', label: 'Voice Examples' },
              { id: 'use-cases', label: 'Use Cases' },
            ].map((sec) => (
              <button
                key={sec.id}
                type="button"
                onClick={() => jumpTo(sec.id)}
                className={`pill-btn-glow px-3.5 py-1.5 rounded-full text-xs font-semibold cursor-pointer ${
                  highlightedId === sec.id ? 'border-[var(--brand)]/65 text-[var(--brand)]' : ''
                }`}
              >
                {sec.label}
              </button>
            ))}
          </div>
        </div>

        <h1 className="text-2xl sm:text-4xl font-bold text-white tracking-tight">
          How <span className="italic font-serif text-[var(--brand)]">VoxTab</span> splits any bill
        </h1>
          <p className="max-w-2xl text-xs sm:text-sm text-[var(--fg-muted)] leading-relaxed">
            No spreadsheets, no manual price typing, and no app downloads for your friends. Here is how a bill goes from paper to settled on PayPal in under a minute.
          </p>
      </div>

      {/* SECTION 1: Three Steps */}
      <section id="steps" className="scroll-mt-24 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {STEP_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.step}
              className={`spotlight-card p-5 space-y-2.5 transition-all duration-500 ${
                isStepsGlowing ? GLOW_CLASS : ''
              }`}
            >
              <div className="w-9 h-9 rounded-full bg-[var(--brand-dim)] border border-[var(--brand)]/30 flex items-center justify-center text-[var(--brand)]">
                <Icon className="w-4 h-4"/>
              </div>
              <span className="mono text-[10px] font-bold uppercase tracking-wider text-[var(--brand)] block">
                {card.step}
              </span>
              <h2 className="text-sm sm:text-base font-bold text-white">{card.title}</h2>
              <p className="text-xs text-[var(--fg-muted)] leading-relaxed">{card.desc}</p>
            </div>
          );
        })}
      </section>

      {/* SECTION 2: Voice Command Cheat Sheet */}
      <section id="voice-examples" className="scroll-mt-24 space-y-4">
        <div className="space-y-1">
          <span className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--brand)]">
            What You Can Say
          </span>
          <h2 className="text-lg sm:text-2xl font-bold text-white">
            Talk naturally, just like you do at the table
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {VOICE_EXAMPLES.map((ex, i) => (
            <div
              key={i}
              className={`spotlight-card p-4 sm:p-5 space-y-2 transition-all duration-500 ${
                isVoiceGlowing ? GLOW_CLASS : ''
              }`}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--brand)]">
                {ex.category}
              </span>
              <p className="text-xs sm:text-sm font-bold text-white">
                &ldquo;{ex.phrase}&rdquo;
              </p>
              <p className="text-xs text-[var(--fg-muted)] flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-[var(--success)] shrink-0"/>
                <span>{ex.result}</span>
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* SECTION 3: Everyday Use Cases */}
      <section id="use-cases" className="scroll-mt-24 space-y-4">
        <div className="space-y-1">
          <span className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--brand)]">
            Built For Everyday Life
          </span>
          <h2 className="text-lg sm:text-2xl font-bold text-white">
            Works on any receipt with line items
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {USE_CASES.map((uc) => {
            const Icon = uc.icon;
            const isTarget = highlightedId === uc.id || highlightedId === 'use-cases';
            return (
              <div
                key={uc.id}
                id={uc.id}
                className={`scroll-mt-24 spotlight-card p-4 sm:p-5 space-y-2 transition-all duration-500 ${
                  isTarget ? GLOW_CLASS : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4 text-[var(--brand)]"/>
                  <h3 className="text-sm font-bold text-white">{uc.title}</h3>
                </div>
                <p className="text-xs text-[var(--fg-muted)] leading-relaxed">{uc.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* SECTION 4: Direct PayPal Email Grabber Unit */}
      <section id="start-splitting" className="scroll-mt-24 space-y-3 pt-2">
        <div className="space-y-1">
          <span className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--brand)]">
            Get Started
          </span>
          <h2 className="text-lg sm:text-2xl font-bold text-white">
            Ready to split your first receipt?
          </h2>
        </div>
        <PayPalEmailGate inputId="how-it-works-paypal-email"/>
      </section>
    </div>
  );
}
