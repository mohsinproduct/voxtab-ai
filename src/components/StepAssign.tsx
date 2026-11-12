/**
 * @file StepAssign.tsx
 * @description Step 2: Voice / Type assignment card on top, readable mobile-paced "Try saying:"
 * right-to-left ticker, Custom Tip bar (no percentage presets), and a locked read-only AG Grid
 * ledger with smart font scaling and 2-line wrapping.
 */
'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { TabLedger, LedgerRow, AllocationRule } from '@/types/tab';
import { formatRuleSummary, isSelfParticipant } from '@/lib/ledgerUtils';
import { Button, AvatarPill } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  mediaProblem,
  insecureContextHelp,
  describeMediaError,
  pickRecorderMime,
} from '@/lib/mediaSupport';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import {
  Mic,
  Square,
  ChevronRight,
  RotateCcw,
  Keyboard,
  CheckCircle2,
  Receipt,
  Loader2,
  Zap,
  Pencil,
  Coins,
  X,
} from 'lucide-react';

ModuleRegistry.registerModules([AllCommunityModule]);

const voxTabGridTheme = themeQuartz.withParams({
  backgroundColor: '#1d1922',
  foregroundColor: '#ffffff',
  borderColor: '#2d2635',
  headerBackgroundColor: '#25202a',
  headerTextColor: '#faf5ef',
  oddRowBackgroundColor: 'transparent',
  rowHoverColor: 'rgba(255, 217, 180, 0.06)',
  selectedRowBackgroundColor: 'rgba(255, 217, 180, 0.12)',
  fontFamily: 'var(--font-geist-sans), sans-serif',
  fontSize: 13,
  cellHorizontalPadding: 10,
  rowHeight: 48,
  wrapperBorderRadius: 12,
});

const fmtDuration = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

interface Participant {
  id: string;
  name: string;
  color: string;
  isHost?: boolean;
}

interface StepAssignProps {
  ledger: TabLedger | null;
  participants: Participant[];
  onParticipantsChange: (ps: Participant[]) => void;
  onRenameSelf?: (oldName: string, newName: string) => void;
  onUpdateTip?: (tipCents: number, tipAllocationRule?: AllocationRule) => void;
  onResetSplit?: () => void;
  voiceTranscript: string;
  onVoiceTranscript: (t: string) => void;
  audioBase64: string | null;
  onAudioBase64: (audio: string | null) => void;
  onApplyVoice?: (audio?: string | null, text?: string) => Promise<void>;
  loading?: boolean;
  error?: string | null;
  onNext: () => void;
  onBack: () => void;
}

/**
 * 1D Portal-Slit Typewriter Hint that automatically slides right-to-left
 * at a comfortable reading pace on mobile when the phrase exceeds the container width.
 */
function TypewriterPortalTicker({ phrases }: { phrases: string[] }) {
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [phase, setPhase] = useState<'typing' | 'pausing' | 'deleting'>('typing');
  const [isMobileView, setIsMobileView] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [slideOffset, setSlideOffset] = useState(0);

  useEffect(() => {
    const checkViewport = () => {
      setIsMobileView(window.innerWidth < 640);
    };
    checkViewport();
    window.addEventListener('resize', checkViewport, { passive: true });
    return () => window.removeEventListener('resize', checkViewport);
  }, []);

  useEffect(() => {
    const current = phrases[phraseIdx % phrases.length] || '';

    if (phase === 'typing') {
      if (charIdx < current.length) {
        const isScrolling = slideOffset > 0;
        const typeDelay = isMobileView ? (isScrolling ? 65 : 58) : isScrolling ? 44 : 34;
        const timer = setTimeout(() => setCharIdx((c) => c + 1), typeDelay);
        return () => clearTimeout(timer);
      } else {
        setPhase('pausing');
        return;
      }
    }

    if (phase === 'pausing') {
      const holdDelay = isMobileView ? 2800 : 2100;
      const timer = setTimeout(() => setPhase('deleting'), holdDelay);
      return () => clearTimeout(timer);
    }

    if (phase === 'deleting') {
      if (charIdx > 0) {
        const delDelay = isMobileView ? 18 : 14;
        const timer = setTimeout(() => setCharIdx((c) => c - 1), delDelay);
        return () => clearTimeout(timer);
      } else {
        setPhase('typing');
        setPhraseIdx((i) => (i + 1) % phrases.length);
      }
    }
  }, [charIdx, phase, phraseIdx, phrases, isMobileView, slideOffset]);

  const currentText = (phrases[phraseIdx % phrases.length] || '').slice(0, charIdx);

  useEffect(() => {
    const vp = viewportRef.current;
    const tx = textRef.current;
    if (!vp || !tx) {
      setSlideOffset(0);
      return;
    }
    const overflow = tx.scrollWidth - vp.clientWidth + 16;
    setSlideOffset(overflow > 0 ? overflow : 0);
  }, [currentText]);

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--bg-muted)]/85 border border-white/5 text-xs min-h-[38px] overflow-hidden">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)] shadow-[0_0_8px_var(--brand)] shrink-0" />
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--fg-muted)] shrink-0">
        Try saying:
      </span>
      <div
        ref={viewportRef}
        className="relative flex-1 min-w-0 overflow-hidden"
        style={
          slideOffset > 0
            ? {
                maskImage: 'linear-gradient(to right, transparent 0px, black 14px, black 100%)',
                WebkitMaskImage:
                  'linear-gradient(to right, transparent 0px, black 14px, black 100%)',
              }
            : undefined
        }
      >
        <div
          className="inline-flex items-center whitespace-nowrap transition-transform duration-150 ease-out"
          style={{ transform: `translateX(-${slideOffset}px)` }}
        >
          <span ref={textRef} className="text-[var(--fg-secondary)] font-medium">
            {currentText}
          </span>
          <span className="portal-slit ml-1" />
        </div>
      </div>
    </div>
  );
}

export function StepAssign({
  ledger,
  participants,
  onParticipantsChange,
  onRenameSelf,
  onUpdateTip,
  onResetSplit,
  voiceTranscript,
  onVoiceTranscript,
  audioBase64,
  onAudioBase64,
  onApplyVoice,
  loading = false,
  error = null,
  onNext,
  onBack,
}: StepAssignProps) {
  const { fmtMoney, currencyMeta } = useI18n();
  const [inputMode, setInputMode] = useState<'voice' | 'type'>('voice');
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState(voiceTranscript);
  const [isApplying, setIsApplying] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [editingSelfId, setEditingSelfId] = useState<string | null>(null);
  const [selfNameDraft, setSelfNameDraft] = useState<string>('');
  const [customTipDraft, setCustomTipDraft] = useState('');
  const receiptSectionRef = useRef<HTMLDivElement | null>(null);

  const busy = isApplying || Boolean(loading);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const onApplyVoiceRef = useRef(onApplyVoice);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTranscript(voiceTranscript);
  }, [voiceTranscript]);

  useEffect(() => {
    const tipCents = ledger?.tipCents || 0;
    if (tipCents > 0) {
      setCustomTipDraft(
        currencyMeta.zeroDecimal ? String(Math.round(tipCents / 100)) : (tipCents / 100).toFixed(2)
      );
    } else {
      setCustomTipDraft('');
    }
  }, [ledger?.tipCents, currencyMeta.zeroDecimal]);

  useEffect(() => {
    onApplyVoiceRef.current = onApplyVoice;
  }, [onApplyVoice]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== 'inactive') {
        rec.onstop = null;
        rec.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /* ── Online Audio Recording via HTML5 MediaRecorder ── */
  const startRecording = async () => {
    setMicError(null);
    try {
      const problem = mediaProblem();
      if (problem === 'insecure') {
        setMicError(insecureContextHelp('microphone') + ' Switch to Type to enter your split.');
        return;
      }
      if (problem || typeof MediaRecorder === 'undefined') {
        setMicError('Voice recording is not supported in this browser. Switch to Type instead.');
        return;
      }

      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
        setAudioUrl(null);
      }
      onAudioBase64(null);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const selectedMime = pickRecorderMime();
      const recorder = selectedMime
        ? new MediaRecorder(stream, { mimeType: selectedMime })
        : new MediaRecorder(stream);

      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const mimeType = recorder.mimeType || selectedMime || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (blob.size < 1000) {
          setMicError('Recording was too short. Hold the mic a moment longer, or switch to Type.');
          return;
        }
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);

        const reader = new FileReader();
        reader.onloadend = async () => {
          const b64 = reader.result as string;
          onAudioBase64(b64);

          const targetApply = onApplyVoiceRef.current || onApplyVoice;
          if (targetApply) {
            setIsApplying(true);
            try {
              await targetApply(b64, '');
            } catch (e: unknown) {
              console.error(e);
            } finally {
              setIsApplying(false);
            }
          }
        };
        reader.readAsDataURL(blob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
      setRecordSeconds(0);

      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    } catch (err: unknown) {
      console.error('Audio capture error:', err);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setMicError(describeMediaError(err, 'microphone'));
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRecording(false);
  };

  const toggleRecording = () => {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
      setTimeout(() => {
        receiptSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  };

  const clearAudio = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }
    setAudioUrl(null);
    onAudioBase64(null);
    setRecordSeconds(0);
  };

  const removeParticipant = (id: string) => {
    onParticipantsChange(participants.filter((p) => p.id !== id));
  };

  const subtotalCents =
    ledger?.subtotalCents ||
    (ledger?.rows || []).reduce((s, r) => s + (Number(r.amountCents) || 0), 0);

  const currentTipCents = ledger?.tipCents || 0;
  const currentTipRule = ledger?.tipAllocationRule;

  // Determine current tip split mode: 'equal' | 'proportional' | 'single'
  const tipSplitMode: 'equal' | 'proportional' | 'single' = useMemo(() => {
    if (!currentTipRule) return 'proportional';
    if (currentTipRule.mode === 'equal' && currentTipRule.shares?.length === 1) return 'single';
    if (currentTipRule.mode === 'equal') return 'equal';
    return 'proportional';
  }, [currentTipRule]);

  const singleTipPayer =
    currentTipRule?.mode === 'equal' && currentTipRule.shares?.length === 1
      ? currentTipRule.shares[0].person
      : null;

  const peopleForTip = useMemo(() => {
    if (participants.length > 0) return participants.map((p) => p.name);
    return ['Me'];
  }, [participants]);

  const handleApplyCustomTip = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onUpdateTip) return;
    const parsed = parseFloat(customTipDraft.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onUpdateTip(0, undefined);
      setCustomTipDraft('');
      return;
    }
    const cents = Math.round(parsed * 100);
    const nextRule = currentTipRule ?? { mode: 'equal', shares: [] };
    onUpdateTip(cents, nextRule);
  };

  /* ── 1 Clickable Receipt Example + Separate Diverse Use-Case Phrases for Ticker ── */
  const { masterExample, animatedPhrases } = useMemo(() => {
    const rows = ledger?.rows || [];
    const clean = (s?: string) => (s || '').replace(/^\d+\s*[xX]\s*/, '').trim();
    const item1 = clean(rows[0]?.description) || 'Artisan Pizza Pack';
    const multiRow = rows.find((r) => (r.quantity || 1) > 1);
    const item2 = clean(multiRow?.description || rows[1]?.description) || 'Organic Cold Brew';

    const master =
      inputMode === 'type'
        ? `My name is Ali, I got the ${item1}, Sara took 1 ${item2}, Bilal and I shared the rest, add $5 tip split equally`
        : `My name is Ali, I got the ${item1}, Sara took 1 ${item2}, and Bilal and I shared the rest`;
    return {
      masterExample: master,
      animatedPhrases:
        inputMode === 'type'
          ? [
              'I am Sara, I took the vitamins and first aid kit, split household supplies equally',
              'Bilal pays 70% of the power adapter, Zaid and I split the groceries, $4 discount',
              'Split everything equally except Ali on the cold brew, add $5 tip on me',
              'Omar pays $15 toward the pharmacy items, rest shared between us',
            ]
          : [
              'I am Sara, I took the vitamins and first aid kit, split household supplies equally',
              'Bilal pays 70% of the power adapter, Zaid and I split the groceries',
              'Split everything equally except Ali on the cold brew',
              'Omar pays $15 toward the pharmacy items, rest shared between us',
            ],
    };
  }, [ledger?.rows, inputMode]);

  /* ── 4 Locked Read-Only AG Grid Columns with Smart Font Scaling & 2-Line Wrapping ── */
  const defaultColDef = useMemo(
    () => ({
      editable: false,
      sortable: false,
      resizable: false,
      suppressMovable: true,
    }),
    []
  );

  const columnDefs = useMemo(
    () => [
      {
        field: 'quantity' as const,
        headerName: 'Qty',
        width: 50,
        minWidth: 48,
        maxWidth: 56,
        valueFormatter: (p: { value?: number }) => (p.value ? `${p.value}×` : '1×'),
        cellStyle: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-geist-mono)',
          fontWeight: '700',
          color: 'var(--brand-light)',
        } as Record<string, string>,
      },
      {
        field: 'description' as const,
        headerName: 'Item',
        flex: 1.6,
        minWidth: 135,
        cellStyle: {
          display: 'flex',
          alignItems: 'center',
          paddingTop: '4px',
          paddingBottom: '4px',
        } as Record<string, string>,
        cellRenderer: (p: { value?: string }) => {
          const text = p.value || 'Item';
          const isLong = text.length > 22;
          return (
            <span
              className={`font-semibold text-white whitespace-normal break-words line-clamp-2 ${
                isLong
                  ? 'text-[11px] sm:text-xs leading-[1.15]'
                  : 'text-xs sm:text-[13px] leading-[1.2]'
              }`}
              title={text}
            >
              {text}
            </span>
          );
        },
      },
      {
        field: 'amountCents' as const,
        headerName: 'Price',
        width: 82,
        minWidth: 76,
        maxWidth: 94,
        valueFormatter: (p: { data?: LedgerRow }) => fmtMoney(p.data?.amountCents ?? 0),
        cellStyle: {
          display: 'flex',
          alignItems: 'center',
          fontFamily: 'var(--font-geist-mono)',
        } as Record<string, string>,
      },
      {
        field: 'assignedTo' as const,
        headerName: 'Assigned To',
        flex: 1.4,
        minWidth: 145,
        cellStyle: {
          display: 'flex',
          alignItems: 'center',
          paddingTop: '4px',
          paddingBottom: '4px',
        } as Record<string, string>,
        valueFormatter: (p: { value?: string; data?: LedgerRow }) => {
          const ruleSummary = p.data?.ruleSummary;
          if (ruleSummary) return ruleSummary;
          if (!p.value || p.value === 'split') return 'Split equally';
          return p.value;
        },
        cellRenderer: (p: { value: string; data?: LedgerRow }) => {
          const ruleSummary = p.data?.ruleSummary;
          if (ruleSummary && ruleSummary !== 'Split equally') {
            return (
              <span
                className="inline-flex items-center gap-1.5 min-w-0 max-w-[195px]"
                title={ruleSummary}
              >
                <span className="w-4 h-4 rounded-full bg-[var(--brand)]/20 border border-[var(--brand)]/40 flex items-center justify-center text-[var(--brand-light)] shrink-0">
                  <Zap className="w-2.5 h-2.5"/>
                </span>
                <span className="text-[11px] font-semibold text-[var(--brand-light)] whitespace-normal break-words line-clamp-2 leading-[1.15]">
                  {ruleSummary}
                </span>
              </span>
            );
          }

          if (!p.value || p.value === 'split') {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--fg-muted)]">
                <span className="w-4 h-4 rounded-full bg-[var(--bg-muted)] border border-white/10 flex items-center justify-center text-[var(--fg-muted)] shrink-0">
                  <Zap className="w-2.5 h-2.5"/>
                </span>
                <span>Shared</span>
              </span>
            );
          }
          const pt = participants.find((x) => x.name.toLowerCase() === p.value?.toLowerCase());
          return (
            <span className="inline-flex items-center gap-1.5 min-w-0 max-w-[195px]">
              <AvatarPill color={pt?.color ?? '#e09f67'} name={p.value} size="sm"/>
              <span className="text-xs font-medium text-[var(--fg-primary)] whitespace-normal break-words line-clamp-2 leading-[1.15]">
                {p.value}
              </span>
            </span>
          );
        },
      },
    ],
    [participants, fmtMoney]
  );

  const canContinue = participants.length >= 1 || !!audioBase64 || transcript.trim().length > 0;

  return (
    <div className="animate-fade-up space-y-4">
      {/* 1. Voice / Type Toggle & Hint Ticker */}
      <div className="card-surface p-4 sm:p-5 space-y-4">
        <div
          className="grid grid-cols-2 p-1.5 rounded-full bg-[var(--bg-muted)] border border-white/10"
        >
          <button
            type="button"
            aria-pressed={inputMode === 'voice'}
            onClick={() => setInputMode('voice')}
            className={`group flex items-center justify-center gap-2 py-2.5 px-4 rounded-full text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              inputMode === 'voice'
                ? 'bg-[var(--brand)] text-[#1b1418] shadow-[0_0_24px_rgba(255,217,180,0.35)]'
                : 'text-[var(--fg-muted)] hover:text-white'
            }`}
          >
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                inputMode === 'voice'
                  ? 'bg-[#1b1418] text-[var(--brand)] shadow-[0_0_12px_rgba(27,20,24,0.5)]'
                  : 'bg-transparent text-current group-hover:text-[var(--brand)]'
              }`}
            >
              <Mic className="w-3.5 h-3.5"/>
            </span>
            <span>Voice</span>
          </button>

          <button
            type="button"
            aria-pressed={inputMode === 'type'}
            onClick={() => {
              if (recording) stopRecording();
              setInputMode('type');
            }}
            className={`group flex items-center justify-center gap-2 py-2.5 px-4 rounded-full text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              inputMode === 'type'
                ? 'bg-[var(--brand)] text-[#1b1418] shadow-[0_0_24px_rgba(255,217,180,0.35)]'
                : 'text-[var(--fg-muted)] hover:text-white'
            }`}
          >
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                inputMode === 'type'
                  ? 'bg-[#1b1418] text-[var(--brand)] shadow-[0_0_12px_rgba(27,20,24,0.5)]'
                  : 'bg-transparent text-current group-hover:text-[var(--brand)]'
              }`}
            >
              <Keyboard className="w-3.5 h-3.5"/>
            </span>
            <span>Type</span>
          </button>
        </div>

        {/* 1D Portal-Cursor Auto-Sliding Line (Readable Mobile Speed) */}
        <TypewriterPortalTicker phrases={animatedPhrases}/>

        {/* TAB 1: VOICE MODE */}
        {inputMode === 'voice' && (
          <div className="flex items-center gap-4 p-4 rounded-2xl bg-[var(--bg-muted)] border border-white/10">
            <button
              type="button"
              onClick={toggleRecording}
              disabled={busy}
              className={`w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center shrink-0 transition-all duration-300 cursor-pointer disabled:opacity-50 ${
                recording
                  ? 'bg-[#ff7a7a] text-[#1b1418] shadow-[0_0_28px_rgba(255,122,122,0.5)] ring-4 ring-[#ff7a7a]/25 scale-105'
                  : 'bg-[var(--brand)] hover:bg-[var(--brand-light)] text-[#1b1418] shadow-[0_0_26px_rgba(255,217,180,0.32)] hover:shadow-[0_0_34px_rgba(255,217,180,0.5)] active:scale-95'
              }`}
              title={recording ? 'Stop Recording' : 'Start Recording Audio'}
            >
              {recording ? (
                <Square className="w-5 h-5 fill-current"/>
              ) : busy ? (
                <Loader2 className="w-6 h-6 animate-spin"/>
              ) : (
                <Mic className="w-6 h-6"/>
              )}
            </button>

            <div className="flex-1 min-w-0 space-y-1">
              {recording ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <div className="flex items-center gap-1 h-4" aria-hidden="true">
                      {[0, 150, 300, 100, 250, 400, 180].map((delay, i) => (
                        <span
                          key={i}
                          className="w-1 h-3.5 rounded-full bg-[#ff7a7a] wave-bar"
                          style={{ animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </div>
                    <p className="text-sm font-bold text-[#ff7a7a]">
                      Listening ({fmtDuration(recordSeconds)}) · Tap to stop
                    </p>
                  </div>
                  <p className="text-xs text-[var(--fg-muted)]">
                    Read from the receipt below and mention who had which items.
                  </p>
                </div>
              ) : busy ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 h-4" aria-hidden="true">
                      {[0, 150, 300, 100, 250, 400, 180].map((delay, i) => (
                        <span
                          key={i}
                          className="w-1 h-3.5 rounded-full bg-[var(--brand)] wave-bar"
                          style={{ animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </div>
                    <p className="text-xs font-semibold text-[var(--brand)]">
                      Splitting the bill...
                    </p>
                  </div>
                  <p className="text-xs text-[var(--fg-muted)]">
                    Matching names and items to your receipt below.
                  </p>
                </div>
              ) : audioBase64 ? (
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--success)]">
                    <CheckCircle2 className="w-4 h-4 shrink-0"/>
                    <span>Voice split applied</span>
                  </div>
                  <p className="text-xs text-[var(--fg-muted)]">
                    Tap mic again if the next person wants to speak their items.
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold text-[var(--fg-primary)]">
                    Tap mic and speak the split
                  </p>
                  <p className="text-xs text-[var(--fg-muted)]">
                    Speak who had what (or switch to Type to add a custom tip).
                  </p>
                </div>
              )}
            </div>

            {audioUrl && !recording && (
              <button
                type="button"
                onClick={clearAudio}
                className="p-2 rounded-full bg-[var(--bg-surface)] hover:bg-[#ff7a7a]/10 text-[var(--fg-muted)] hover:text-[#ff7a7a] border border-white/10 transition-colors cursor-pointer shrink-0"
                title="Discard audio recording"
              >
                <RotateCcw className="w-4 h-4"/>
              </button>
            )}
          </div>
        )}

        {/* TAB 2: TYPE MODE */}
        {inputMode === 'type' && (
          <div className="space-y-2.5">
            <textarea
              rows={3}
              placeholder="Type who got what, discounts, or tip (Press Enter for a new line)..."
              value={transcript}
              onChange={(e) => {
                if (audioBase64) clearAudio();
                setTranscript(e.target.value);
                onVoiceTranscript(e.target.value);
              }}
              className="w-full rounded-2xl bg-[var(--bg-muted)] border border-white/10 px-4 py-3 text-sm text-[var(--fg-primary)] placeholder:text-[var(--fg-muted)] outline-none focus:border-[var(--brand)] resize-y transition-colors"
            />
            <div className="flex justify-end">
              <Button
                disabled={!transcript.trim() || !onApplyVoice}
                loading={busy}
                onClick={async () => {
                  if (!transcript.trim() || !onApplyVoice) return;
                  setIsApplying(true);
                  try {
                    await onApplyVoice(null, transcript);
                  } finally {
                    setIsApplying(false);
                  }
                }}
                size="sm"
                variant="primary"
              >
                Apply
              </Button>
            </div>
          </div>
        )}

        {(micError || error) && (
          <div
            role="alert"
            className="p-3 rounded-xl border border-[var(--brand)]/25 bg-[var(--brand)]/10 text-xs font-semibold text-[var(--brand-light)] leading-relaxed"
          >
            {micError || error}
          </div>
        )}

        {/* Clickable Example Pill: Wraps up to 2 readable lines on mobile instead of truncating early */}
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (audioBase64) clearAudio();
            setTranscript(masterExample);
            onVoiceTranscript(masterExample);
            if (onApplyVoice) {
              setIsApplying(true);
              try {
                await onApplyVoice(null, masterExample);
              } finally {
                setIsApplying(false);
              }
            }
          }}
          className="w-full flex items-start sm:items-center gap-2 px-3 py-2 rounded-xl bg-[var(--bg-muted)] hover:bg-[var(--brand-dim)] border border-white/10 hover:border-[var(--brand)]/40 text-left transition-all cursor-pointer disabled:opacity-50 group"
          title="Tap to apply this example split"
        >
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--brand)] bg-[var(--brand)]/15 border border-[var(--brand)]/30 px-2 py-0.5 rounded-full shrink-0 mt-0.5 sm:mt-0">
            Example
          </span>
          <span className="text-[11px] sm:text-xs text-[var(--fg-secondary)] group-hover:text-[var(--brand)] line-clamp-2 whitespace-normal text-left leading-snug flex-1 min-w-0">
            &ldquo;{masterExample}&rdquo;
          </span>
        </button>
      </div>

      {/* 2. Custom Tip Bar */}
      {inputMode === 'type' && ledger && onUpdateTip && (
        <div className="card-surface p-3.5 sm:p-4 rounded-xl space-y-3 animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-[var(--brand-dim)] border border-[var(--brand)]/30 flex items-center justify-center text-[var(--brand)] shrink-0">
                <Coins className="w-3.5 h-3.5"/>
              </span>
              <span className="text-xs font-bold text-white">Custom Tip</span>
              {currentTipCents > 0 && (
                <span className="mono text-xs font-bold text-[var(--brand)]">
                  {fmtMoney(currentTipCents)}
                </span>
              )}
            </div>

            <form onSubmit={handleApplyCustomTip} className="flex items-center gap-1.5">
              <div className="relative w-28 sm:w-32">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-[var(--fg-muted)] mono">
                  {currencyMeta.symbol.trim()}
                </span>
                <input
                  type="number"
                  step={currencyMeta.zeroDecimal ? '1' : '0.01'}
                  min="0"
                  placeholder={currencyMeta.zeroDecimal ? '0' : '0.00'}
                  value={customTipDraft}
                  onChange={(e) => setCustomTipDraft(e.target.value)}
                  aria-label="Custom tip amount"
                  className="w-full h-8 pl-7 pr-2.5 rounded-full bg-[var(--bg-muted)] border border-white/15 focus:border-[var(--brand)] text-xs mono text-white outline-none"
                />
              </div>

              <button
                type="submit"
                className="h-8 px-3 rounded-full bg-[var(--brand)] hover:bg-[var(--brand-light)] text-[#1b1418] text-[11px] font-bold transition-all cursor-pointer shrink-0"
              >
                {currentTipCents > 0 ? 'Update' : 'Add'}
              </button>

              {currentTipCents > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setCustomTipDraft('');
                    onUpdateTip(0, undefined);
                  }}
                  title="Remove tip"
                  className="h-8 w-8 rounded-full bg-[var(--bg-muted)] hover:bg-[#ff7a7a]/15 text-[var(--fg-muted)] hover:text-[#ff7a7a] border border-white/10 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                >
                  <X className="w-3.5 h-3.5"/>
                </button>
              )}
            </form>
          </div>

          {/* Row 2: How to Divide or Assign the Tip */}
          {currentTipCents > 0 && (
            <div className="pt-2 border-t border-white/8 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--fg-muted)] font-medium">
                Divide tip:
              </span>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onUpdateTip(currentTipCents, { mode: 'equal', shares: [] })}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all cursor-pointer ${
                    tipSplitMode === 'equal'
                      ? 'bg-[var(--brand)]/20 text-[var(--brand)] border-[var(--brand)]/50'
                      : 'bg-[var(--bg-muted)] text-[var(--fg-muted)] border-white/10 hover:text-white'
                  }`}
                >
                  Equally
                </button>

                <button
                  type="button"
                  onClick={() => onUpdateTip(currentTipCents, undefined)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all cursor-pointer ${
                    tipSplitMode === 'proportional'
                      ? 'bg-[var(--brand)]/20 text-[var(--brand)] border-[var(--brand)]/50'
                      : 'bg-[var(--bg-muted)] text-[var(--fg-muted)] border-white/10 hover:text-white'
                  }`}
                >
                  By Item Share
                </button>

                {peopleForTip.map((personName) => {
                  const isAssigned =
                    tipSplitMode === 'single' &&
                    singleTipPayer?.toLowerCase() === personName.toLowerCase();
                  return (
                    <button
                      key={personName}
                      type="button"
                      onClick={() =>
                        onUpdateTip(currentTipCents, {
                          mode: 'equal',
                          shares: [{ person: personName, value: 1 }],
                        })
                      }
                      className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all cursor-pointer ${
                        isAssigned
                          ? 'bg-[var(--brand)] text-[#1b1418] border-[var(--brand)] shadow-[0_0_10px_rgba(255,217,180,0.3)]'
                          : 'bg-[var(--bg-muted)] text-[var(--fg-secondary)] border-white/10 hover:border-[var(--brand)]/40'
                      }`}
                      title={`Assign entire tip to ${personName}`}
                    >
                      {personName} only
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3. Scanned Receipt Details & Locked AG Grid Ledger */}
      {ledger && (
        <div className="space-y-2.5">
          <div
            ref={receiptSectionRef}
            className={`card-surface p-3.5 rounded-xl space-y-2.5 transition-all ${
              recording ? 'ring-2 ring-[#ff7a7a]/60 bg-[#ff7a7a]/5' : ''
            }`}
          >
            {/* Row 1: Merchant Title, Item Count & Reset Button */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-full bg-[var(--brand-dim)] flex items-center justify-center border border-[var(--brand)]/25 shrink-0">
                  <Receipt className="w-4 h-4 text-[var(--brand)]"/>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs sm:text-sm font-bold text-[var(--fg-primary)] truncate">
                      {ledger.merchant || 'Receipt'}
                    </p>
                    {recording && (
                      <button
                        type="button"
                        onClick={stopRecording}
                        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#ff7a7a] text-[#1b1418] text-[10px] font-bold animate-pulse cursor-pointer shrink-0"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[#1b1418]" />
                        REC {fmtDuration(recordSeconds)} · Stop
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-[var(--fg-muted)]">
                    {ledger.rows.length} {ledger.rows.length === 1 ? 'item' : 'items'}
                    {participants.length > 0 ? ` · ${participants.length} people` : ''}
                  </p>
                </div>
              </div>

              {(participants.length > 0 || ledger.tipCents > 0) && onResetSplit && (
                <button
                  type="button"
                  onClick={onResetSplit}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[var(--bg-muted)] hover:bg-[#ff7a7a]/15 border border-white/10 text-[11px] font-semibold text-[var(--fg-muted)] hover:text-[#ff7a7a] transition-colors cursor-pointer shrink-0"
                  title="Reset all assignments"
                >
                  <RotateCcw className="w-3 h-3"/>
                  <span>Reset</span>
                </button>
              )}
            </div>

            {/* Row 2: Symmetrical Financial Summary Strip */}
            <div className="pt-2 border-t border-white/8 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[var(--fg-muted)]">
                  Subtotal:{' '}
                  <strong className="mono text-[var(--fg-secondary)]">
                    {fmtMoney(subtotalCents)}
                  </strong>
                </span>
                {ledger.taxCents > 0 && (
                  <span className="text-[var(--fg-muted)]">
                    Tax:{' '}
                    <strong className="mono text-[var(--fg-secondary)]">
                      {fmtMoney(ledger.taxCents)}
                    </strong>
                  </span>
                )}
                {ledger.discountCents !== undefined && ledger.discountCents > 0 && (
                  <span className="text-[var(--success)]">
                    Discount: <strong className="mono">-{fmtMoney(ledger.discountCents)}</strong>
                  </span>
                )}
                {ledger.tipCents > 0 && (
                  <span className="text-[var(--fg-muted)]">
                    Tip:{' '}
                    <strong className="mono text-[var(--fg-secondary)]">
                      {fmtMoney(ledger.tipCents)}
                      {ledger.tipAllocationRule
                        ? ` (${formatRuleSummary(ledger.tipAllocationRule)})`
                        : ''}
                    </strong>
                  </span>
                )}
              </div>

              <span className="text-[var(--fg-primary)] font-bold ml-auto">
                Total:{' '}
                <strong className="mono text-[var(--brand)] text-sm">
                  {fmtMoney(ledger.totalCents)}
                </strong>
              </span>
            </div>
          </div>

          <div
            className={`w-full overflow-x-auto rounded-xl border border-white/10 transition-opacity ${
              busy ? 'opacity-60 pointer-events-none' : ''
            } ${ledger.rows.length > 6 ? 'h-[300px] sm:h-[340px]' : ''}`}
          >
            <AgGridReact<LedgerRow>
              theme={voxTabGridTheme}
              rowData={ledger.rows}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              domLayout={ledger.rows.length > 6 ? 'normal' : 'autoHeight'}
              suppressMovableColumns={true}
              suppressDragLeaveHidesColumns={true}
              suppressColumnMoveAnimation={true}
              suppressCellFocus={true}
              animateRows
            />
          </div>

          {participants.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {participants.map((p) => {
                const isSelf = editingSelfId === p.id;
                const canEdit = p.isHost ?? isSelfParticipant(p.name);
                return (
                  <div
                    key={p.id}
                    className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full bg-[var(--bg-surface)] border border-white/10"
                  >
                    {canEdit && !isSelf ? (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSelfId(p.id);
                          setSelfNameDraft(p.name);
                        }}
                        className="p-1 text-[var(--fg-muted)] hover:text-[var(--brand)] hover:bg-white/10 rounded-full transition-colors cursor-pointer"
                        title={`Rename ${p.name}`}
                      >
                        <Pencil className="w-3 h-3"/>
                      </button>
                    ) : null}
                    {canEdit && isSelf ? (
                      <input
                        autoFocus
                        value={selfNameDraft}
                        onChange={(e) => setSelfNameDraft(e.target.value)}
                        onBlur={() => {
                          setEditingSelfId(null);
                          if (
                            selfNameDraft.trim() &&
                            selfNameDraft.trim() !== p.name &&
                            onRenameSelf
                          ) {
                            onRenameSelf(p.name, selfNameDraft.trim());
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            setEditingSelfId(null);
                            if (
                              selfNameDraft.trim() &&
                              selfNameDraft.trim() !== p.name &&
                              onRenameSelf
                            ) {
                              onRenameSelf(p.name, selfNameDraft.trim());
                            }
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditingSelfId(null);
                          }
                        }}
                        className="text-xs font-medium text-[var(--fg-primary)] bg-transparent border-none outline-none placeholder-[var(--fg-muted)] px-1.5 min-w-[60px] text-center"
                        placeholder={p.name}
                      />
                    ) : (
                      <AvatarPill color={p.color} name={p.name} size="sm"/>
                    )}
                    <span className="text-xs font-medium text-[var(--fg-primary)]">{p.name}</span>
                    {!canEdit && (
                      <button
                        type="button"
                        onClick={() => removeParticipant(p.id)}
                        className="text-[var(--fg-muted)] hover:text-[#ff7a7a] transition-colors ml-0.5 cursor-pointer"
                        title={`Remove ${p.name}`}
                      >
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2.5}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Navigation Footer: Full-width Settle button next to Back */}
      <div className="flex gap-3 pt-1">
        <Button
          icon={<ChevronRight className="w-4 h-4 rotate-180"/>}
          onClick={onBack}
          size="lg"
          variant="secondary"
          className="w-24 sm:w-28 h-12"
        >
          Back
        </Button>
        <Button
          icon={busy ? <Loader2 className="w-4 h-4 animate-spin"/> : <ChevronRight className="w-4 h-4"/>}
          disabled={!canContinue || busy}
          size="lg"
          variant="primary"
          onClick={onNext}
          className="flex-1 h-12"
        >
          {busy ? 'Processing...' : 'Settle'}
        </Button>
      </div>
    </div>
  );
}

