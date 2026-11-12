/**
 * @file ui.tsx
 * @description Shared design-system primitives used across VoxTab.
 */
'use client';

import React from 'react';

/* ────────────────────────────────────────────────────────────
   BUTTON
   ──────────────────────────────────────────────────────────── */

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const base = 'inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap rounded-full transition-all duration-200 select-none focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[var(--bg-app)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 active:scale-[0.97] cursor-pointer';

  const variants = {
    primary: 'bg-[var(--brand)] hover:bg-[var(--brand-light)] text-[#1b1418] focus:ring-[var(--brand)] shadow-[0_0_24px_rgba(255,217,180,0.24)] hover:shadow-[0_0_32px_rgba(255,217,180,0.42)] hover:-translate-y-[1px]',
    secondary: 'bg-[var(--bg-surface)] hover:bg-[#2f2936] text-[var(--fg-secondary)] hover:text-white border border-white/10 hover:border-[var(--brand)]/40 focus:ring-[var(--border)] hover:-translate-y-[1px]',
    ghost: 'bg-transparent hover:bg-[var(--bg-surface)] text-[var(--fg-muted)] hover:text-[var(--fg-primary)]',
    danger: 'bg-[#ff7a7a]/10 hover:bg-[#ff7a7a]/20 text-[#ff7a7a] border border-[#ff7a7a]/25 hover:border-[#ff7a7a]/50',
  };

  const sizes = {
    sm: 'h-8 px-3.5 text-xs',
    md: 'h-10 px-5 text-sm',
    lg: 'h-12 px-6 text-sm sm:text-base',
  };

  return (
    <button
      disabled={disabled || loading}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {loading ? (
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin-slow" />
      ) : icon ? (
        <span className="shrink-0 inline-flex items-center justify-center [&_svg]:w-4 [&_svg]:h-4">{icon}</span>
      ) : null}
      {children}
    </button>
  );
}

/* ────────────────────────────────────────────────────────────
   STEP INDICATOR
   ──────────────────────────────────────────────────────────── */

export interface Step {
  id: number;
  label: string;
  sublabel: string;
}

interface StepIndicatorProps {
  steps: Step[];
  current: number;
  onStepClick?: (id: number) => void;
}

export function StepIndicator({ steps, current, onStepClick }: StepIndicatorProps) {
  return (
    <div className="w-full">
      {/* Mobile view: 3 progressive horizontal step bars */}
      <div className="flex sm:hidden items-center gap-2 w-full py-1" role="progressbar" aria-valuenow={current} aria-valuemin={1} aria-valuemax={steps.length}>
        {steps.map((s) => {
          const filled = s.id <= current;
          const locked = s.id > current;
          return (
            <button
              key={s.id}
              type="button"
              disabled={locked}
              onClick={() => !locked && onStepClick?.(s.id)}
              aria-label={`Step ${s.id}`}
              className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                filled
                  ? 'bg-[var(--brand)] shadow-[0_0_12px_var(--brand-glow)]'
                  : 'bg-[var(--bg-surface)]'
              } ${locked ? 'cursor-default' : 'cursor-pointer'}`}
            />
          );
        })}
      </div>

      {/* Desktop view: Editorial progressive bars with clean labels */}
      <div className="hidden sm:grid sm:grid-cols-3 gap-3 w-full">
        {steps.map((s) => {
          const filled = s.id <= current;
          const active = s.id === current;
          const locked = s.id > current;

          return (
            <button
              key={s.id}
              type="button"
              onClick={() => !locked && onStepClick?.(s.id)}
              disabled={locked}
              className={`group text-left space-y-2 rounded-xl p-2 transition-all ${
                locked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--bg-surface)]/60'
              }`}
            >
              <div
                className={`h-1.5 w-full rounded-full transition-all duration-300 ${
                  filled
                    ? 'bg-[var(--brand)] shadow-[0_0_12px_var(--brand-glow)]'
                    : 'bg-[var(--bg-surface)]'
                }`}
              />
              <div className="flex items-center justify-between gap-1">
                <span
                  className={`text-[11px] uppercase tracking-[0.12em] font-semibold ${
                    active ? 'text-[var(--brand)]' : filled ? 'text-[var(--fg-secondary)]' : 'text-[var(--fg-muted)]'
                  }`}
                >
                  0{s.id} · {s.label}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   MODAL
   ──────────────────────────────────────────────────────────── */

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}

export function Modal({ isOpen, onClose, title, children, maxWidth = 'max-w-md' }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full ${maxWidth} animate-fade-up`}>
        <div className="card overflow-hidden shadow-2xl">
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
            <h3 className="font-bold text-base text-[var(--fg-primary)]">{title}</h3>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-full flex items-center justify-center text-[var(--fg-muted)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-surface)] transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="p-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   AVATAR PILL  (participant color dot)
   ──────────────────────────────────────────────────────────── */

export function AvatarPill({
  name,
  color = '#e09f67',
  size = 'md',
}: {
  name: string;
  color?: string;
  size?: 'sm' | 'md';
}) {
  const sz = size === 'sm' ? 'w-5 h-5 text-[9px]' : 'w-7 h-7 text-[11px]';
  return (
    <div className={`${sz} rounded-full flex items-center justify-center font-bold text-white shrink-0`} style={{ backgroundColor: color }}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   SKELETON LOADER
   ──────────────────────────────────────────────────────────── */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton-shimmer rounded-xl ${className}`} aria-hidden="true" />;
}
