/**
 * @file ScreenHeader.tsx
 * @description Brand logo link, centered desktop navigation (How It Works, FAQ, Privacy),
 * mobile left slide-out sidebar drawer, 2-column mobile footer, desktop spotlight tracker,
 * and wizard step header.
 */
'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Zap,
  History,
  Menu,
  X,
  ArrowRight,
  ShieldCheck,
  HelpCircle,
  Sparkles,
  MessageSquareQuoteIcon,
} from 'lucide-react';
import { StepIndicator, Step } from '@/components/ui';

export function SpotlightTracker() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const BOUNDARY_PX = 85;
    let rafId = 0;
    let lastClientX = -9999;
    let lastClientY = -9999;

    const updateCards = () => {
      if (lastClientX < 0 || lastClientY < 0) return;
      const cards = document.querySelectorAll<HTMLElement>('.spotlight-card');
      cards.forEach((card) => {
        const rect = card.getBoundingClientRect();
        const x = lastClientX - rect.left;
        const y = lastClientY - rect.top;

        const nearX = lastClientX >= rect.left - BOUNDARY_PX && lastClientX <= rect.right + BOUNDARY_PX;
        const nearY = lastClientY >= rect.top - BOUNDARY_PX && lastClientY <= rect.bottom + BOUNDARY_PX;

        if (nearX && nearY) {
          card.style.setProperty('--mx', `${x}px`);
          card.style.setProperty('--my', `${y}px`);
          card.style.setProperty('--spotlight-opacity', '1');
        } else {
          card.style.setProperty('--spotlight-opacity', '0');
        }
      });
    };

    const scheduleUpdate = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateCards);
    };

    const onPointerMove = (e: PointerEvent) => {
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      scheduleUpdate();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('scroll', scheduleUpdate);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  return null;
}

export function BrandLogoLink({ onClickExtra }: { onClickExtra?: () => void }) {
  return (
    <Link aria-label="VoxTab home" className="flex items-center gap-2.5 group shrink-0" href="/?landing=1" onClick={() =>{
        onClickExtra?.();
        if (typeof window !== 'undefined') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          window.dispatchEvent(new CustomEvent('voxtab:reset-home'));
        }
      }}
    >
      <span className="w-7 h-7 rounded-full bg-[var(--brand)] text-[#1b1418] flex items-center justify-center shadow-[0_0_16px_var(--brand-glow)] group-hover:shadow-[0_0_24px_rgba(255,217,180,0.5)] transition-all">
        <Zap className="w-3.5 h-3.5" fill="currentColor"/>
      </span>
      <span className="font-bold text-base text-white tracking-tight group-hover:text-[var(--brand)] transition-colors">
        VoxTab
      </span>
    </Link>
  );
}

export function HeaderBarContent() {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const isHow = pathname === '/how-it-works';
  const isPrivacy = pathname === '/privacy';
  const isHistory = pathname === '/history';

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (drawerOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  const handleFaqClick = (e: React.MouseEvent) => {
    setDrawerOpen(false);
    if (pathname === '/') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('voxtab:open-faq'));
    } else {
      e.preventDefault();
      router.push('/?faq=1#faq');
    }
  };

  const handleNavClick = (targetPath: string, hash?: string) => {
    setDrawerOpen(false);
    if (typeof window === 'undefined') return;
    if (pathname === targetPath) {
      if (hash) {
        const el = document.getElementById(hash);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          window.dispatchEvent(new CustomEvent('voxtab:highlight-section', { detail: hash }));
          return;
        }
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (targetPath === '/') {
        window.dispatchEvent(new CustomEvent('voxtab:reset-home'));
      }
    }
  };

  return (
    <>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 md:px-8 h-16 flex items-center justify-between gap-2">
        {/* Left: Mobile Menu Button + Brand Logo */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            className="sm:hidden p-2 -ml-1 rounded-full text-[var(--fg-secondary)] hover:text-[var(--brand)] hover:bg-white/5 transition-colors cursor-pointer"
          >
            <Menu className="w-5 h-5"/>
          </button>
          <BrandLogoLink/>
        </div>

        {/* Center (Desktop): Centered 3 Links between VoxTab and Saved Bills */}
        <nav
          aria-label="Main navigation"
          className="hidden sm:flex items-center justify-center gap-2 md:gap-4 flex-1"
        >
          <Link href="/how-it-works" onClick={() => handleNavClick('/how-it-works')}
            className={`nav-link-glow font-medium px-3.5 py-1.5 rounded-full text-xs ${
              isHow ? 'is-active' : ''
            }`}
          >
            How It Works
          </Link>
          <a
            href="/#faq"
            onClick={handleFaqClick}
            className="nav-link-glow font-medium px-3.5 py-1.5 rounded-full text-xs cursor-pointer"
          >
            FAQ
          </a>
          <Link href="/privacy" onClick={() => handleNavClick('/privacy')}
            className={`nav-link-glow font-medium px-3.5 py-1.5 rounded-full text-xs ${
              isPrivacy ? 'is-active' : ''
            }`}
          >
            Privacy
          </Link>
        </nav>

        {/* Right: Saved Bills Pill Button */}
        <div className="flex items-center shrink-0">
          <Link href="/history" onClick={() => handleNavClick('/history')}
            className={`pill-btn-glow inline-flex items-center gap-2 font-semibold px-3.5 py-1.5 rounded-full text-xs shadow-[0_0_20px_rgba(255,217,180,0.2)] ${
              isHistory ? 'border-[var(--brand)]/60' : ''
            }`}
          >
            <History className="w-3.5 h-3.5 text-[var(--brand)] drop-shadow-[0_0_8px_rgba(255,217,180,0.6)]"/>
            <span>Saved Bills</span>
          </Link>
        </div>
      </div>

      {/* Mobile Slide-Out Left Sidebar Drawer (Portaled to document.body so .glass backdrop-filter never clips it) */}
      {mounted &&
        drawerOpen &&
        createPortal(
          <div className="fixed inset-0 z-[100] sm:hidden">
            <div
              className="fixed inset-0 h-[100dvh] w-screen bg-black/80 backdrop-blur-sm animate-fade-in"
              onClick={() => setDrawerOpen(false)}
            />
            <aside
              aria-label="Mobile navigation"
              style={{ backgroundColor: '#16131a' }}
              className="fixed top-0 left-0 bottom-0 z-[101] h-[100dvh] w-72 max-w-[82vw] bg-[#16131a] border-r border-white/15 p-5 flex flex-col justify-between shadow-[0_0_50px_rgba(0,0,0,0.95)] overflow-y-auto animate-fade-in"
            >
              <div className="space-y-6">
                <div className="flex items-center justify-between pb-3.5 border-b border-white/10">
                  <BrandLogoLink onClickExtra={() => setDrawerOpen(false)} />
                  <button
                    type="button"
                    onClick={() => setDrawerOpen(false)}
                    aria-label="Close navigation menu"
                    className="p-1.5 rounded-full text-[var(--fg-muted)] hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4"/>
                  </button>
                </div>

                <nav className="flex flex-col gap-1.5">
                  <Link href="/?scan=1" onClick={() => {
                    setDrawerOpen(false);
                    if (typeof window !== 'undefined') {
                      window.dispatchEvent(new CustomEvent('voxtab:open-scanner'));
                    }
                  }}
                    className={`nav-link-glow flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm font-semibold ${
                      pathname === '/' ? 'is-active' : ''
                    }`}
                  >
                    <Zap className="w-4 h-4 text-[var(--brand)] shrink-0"/>
                    <span>Bill Splitter</span>
                  </Link>
                  <Link href="/how-it-works" onClick={() => handleNavClick('/how-it-works')}
                    className={`nav-link-glow flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm font-semibold ${
                      isHow ? 'is-active' : ''
                    }`}
                  >
                    <HelpCircle className="w-4 h-4 text-[var(--brand)] shrink-0"/>
                    <span>How It Works</span>
                  </Link>
                  <Link href="/how-it-works#voice-examples" onClick={() => handleNavClick('/how-it-works', 'voice-examples')}
                    className="nav-link-glow flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm font-semibold"
                  >
                    <Sparkles className="w-4 h-4 text-[var(--brand)] shrink-0"/>
                    <span>Voice Examples</span>
                  </Link>
                  <a
                    href="/#faq"
                    onClick={handleFaqClick}
                    className="nav-link-glow flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm font-semibold cursor-pointer"
                  >
                    <MessageSquareQuoteIcon className="w-4 h-4 text-[var(--brand)] shrink-0"/>
                    <span>FAQ</span>
                  </a>
                  <Link href="/privacy" onClick={() => handleNavClick('/privacy')}
                    className={`nav-link-glow flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm font-semibold ${
                      isPrivacy ? 'is-active' : ''
                    }`}
                  >
                    <ShieldCheck className="w-4 h-4 text-[var(--success)] shrink-0"/>
                    <span>Privacy</span>
                  </Link>
                  <Link href="/history" onClick={() => handleNavClick('/history')}
                    className={`nav-link-glow flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm font-semibold ${
                      isHistory ? 'is-active' : ''
                    }`}
                  >
                    <History className="w-4 h-4 text-[var(--brand)] shrink-0"/>
                    <span>Saved Bills</span>
                  </Link>
                </nav>
              </div>

              <div className="pt-4 border-t border-white/10 text-[11px] text-[var(--fg-muted)] flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-[var(--success)] shrink-0"/>
                <span>No app downloads · Splits to the exact cent</span>
              </div>
            </aside>
          </div>,
          document.body
        )}
    </>
  );
}

export function AppFooter() {
  const pathname = usePathname();
  const router = useRouter();

  const handleFooterNav = (e: React.MouseEvent, targetPath: string, hash?: string) => {
    if (typeof window === 'undefined') return;
    if (targetPath === '/' && hash === 'faq') {
      e.preventDefault();
      if (pathname === '/') {
        window.dispatchEvent(new CustomEvent('voxtab:open-faq'));
      } else {
        router.push('/?faq=1#faq');
      }
      return;
    }

    if (targetPath === '/' && !hash) {
      e.preventDefault();
      let hasSavedEmail = false;
      try {
        const saved = (localStorage.getItem('voxtab_payee_email') || '').trim();
        hasSavedEmail = Boolean(saved && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(saved));
      } catch {}

      if (pathname === '/') {
        if (hasSavedEmail) {
          window.dispatchEvent(new CustomEvent('voxtab:open-scanner'));
        } else {
          window.dispatchEvent(new CustomEvent('voxtab:reset-home'));
          setTimeout(() => {
            const emailEl = document.getElementById('hero-paypal-email');
            if (emailEl) (emailEl as HTMLInputElement).focus();
          }, 350);
        }
      } else {
        router.push(hasSavedEmail ? '/?scan=1' : '/?landing=1');
      }
      return;
    }

    if (pathname === targetPath) {
      e.preventDefault();
      if (hash) {
        const el = document.getElementById(hash);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          window.dispatchEvent(new CustomEvent('voxtab:highlight-section', { detail: hash }));
          return;
        }
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  return (
    <footer className="border-t border-white/8 bg-[#120f16] pt-12 pb-8 mt-auto">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 md:px-8 space-y-10">
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-8">
          {/* Brand Column */}
          <div className="sm:col-span-5 space-y-4">
            <BrandLogoLink/>
            <p className="text-xs sm:text-sm text-[var(--fg-muted)] max-w-xs leading-relaxed">
              The voice-first bill splitter for groups. Snap any receipt, speak the split, and get paid back on PayPal.
            </p>
            <div>
              <Link href="/" onClick={(e) => handleFooterNav(e, '/')}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-full bg-[var(--brand)] hover:bg-[var(--brand-light)] text-[#1b1418] text-xs font-bold shadow-[0_0_24px_rgba(255,217,180,0.24)] hover:shadow-[0_0_32px_rgba(255,217,180,0.45)] hover:-translate-y-0.5 transition-all cursor-pointer"
              >
                <span>Split a Bill</span>
                <ArrowRight className="w-3.5 h-3.5"/>
              </Link>
            </div>
          </div>

          {/* 2-Column Mobile Grid for Product, Use Cases & Resources */}
          <div className="sm:col-span-7 grid grid-cols-2 sm:grid-cols-7 gap-6">
            {/* Product Column */}
            <div className="sm:col-span-2 space-y-2.5">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-white">
                Product
              </h3>
              <ul className="space-y-1.5 text-xs">
                <li>
                  <Link href="/" onClick={(e) => handleFooterNav(e, '/')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full"
                  >
                    Bill Splitter
                  </Link>
                </li>
                <li>
                  <Link href="/how-it-works" onClick={(e) => handleFooterNav(e, '/how-it-works')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full"
                  >
                    How It Works
                  </Link>
                </li>
                <li>
                  <Link href="/history" onClick={(e) => handleFooterNav(e, '/history')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full"
                  >
                    Saved Bills
                  </Link>
                </li>
              </ul>
            </div>

            {/* Use Cases Column */}
            <div className="sm:col-span-3 space-y-2.5">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-white">
                Use Cases
              </h3>
              <ul className="space-y-1.5 text-xs">
                <li>
                  <Link href="/how-it-works#use-case-dinners" onClick={(e) => handleFooterNav(e, '/how-it-works', 'use-case-dinners')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full"
                  >
                    Group Dinners &amp; Cafes
                  </Link>
                </li>
                <li>
                  <Link href="/how-it-works#use-case-groceries" onClick={(e) => handleFooterNav(e, '/how-it-works', 'use-case-groceries')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full"
                  >
                    Roommate Grocery Runs
                  </Link>
                </li>
                <li>
                  <Link href="/how-it-works#use-case-house" onClick={(e) => handleFooterNav(e, '/how-it-works', 'use-case-house')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full"
                  >
                    Pharmacy &amp; House Supplies
                  </Link>
                </li>
              </ul>
            </div>

            {/* Resources Column */}
            <div className="col-span-2 sm:col-span-2 space-y-2.5">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-white">
                Resources
              </h3>
              <ul className="grid grid-cols-2 sm:grid-cols-1 gap-1.5 text-xs">
                <li>
                  <Link href="/how-it-works#voice-examples" onClick={(e) => handleFooterNav(e, '/how-it-works', 'voice-examples')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full"
                  >
                    Voice Examples
                  </Link>
                </li>
                <li>
                  <a
                    href="/#faq"
                    onClick={(e) => handleFooterNav(e, '/', 'faq')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full cursor-pointer"
                  >
                    FAQ
                  </a>
                </li>
                <li>
                  <Link href="/privacy" onClick={(e) => handleFooterNav(e, '/privacy')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full"
                  >
                    Privacy & Security
                  </Link>
                </li>
                <li>
                  <Link href="/privacy#manage-data" onClick={(e) => handleFooterNav(e, '/privacy', 'manage-data')}
                    className="nav-link-glow inline-block px-2 py-1 -mx-2 rounded-full"
                  >
                    Clear Browser Data
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Bottom Legal & Local Privacy Bar */}
        <div className="pt-6 border-t border-white/5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-[var(--fg-muted)]">
          <span>© 2026 VoxTab. All rights reserved.</span>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[var(--success)] shrink-0"/>
            <span>No account required · Splits to the exact cent · Instant PayPal QR & links</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

export const WIZARD_STEPS: Step[] = [
  { id: 1, label: 'Capture', sublabel: 'Snap or upload receipt' },
  { id: 2, label: 'Assign', sublabel: 'Voice split, items & tip' },
  { id: 3, label: 'Settle', sublabel: 'Pay & share' },
];

const STEP_PATHS: Record<number, string> = { 2: 'assign', 3: 'settle' };

export function ScreenHeader({
  title,
  subtitle,
  step,
  tabId,
}: {
  title: string;
  subtitle: string | React.ReactNode;
  step?: number;
  tabId?: string;
}) {
  const router = useRouter();
  return (
    <div className="pt-4 pb-4 sm:pt-7 sm:pb-6 space-y-4 animate-fade-up">
      {step !== undefined && (
        <StepIndicator current={step} onStepClick={(id) => {
            if (id >= step) return;
            router.push(
              id === 1 || !tabId
                ? '/?scan=1'
                : `/tab/${encodeURIComponent(tabId)}/${STEP_PATHS[id]}`
            );
          }}
          steps={WIZARD_STEPS}
        />
      )}
      <div className="space-y-1">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--fg-primary)]">{title}</h1>
        <p className="text-xs sm:text-sm text-[var(--fg-muted)]">{subtitle}</p>
      </div>
    </div>
  );
}
