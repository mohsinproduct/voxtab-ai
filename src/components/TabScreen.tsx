/**
 * @file TabScreen.tsx
 * @description The /tab/[id]/(assign|settle) screens. Loads the tab from local storage by id,
 * shows a structured Skeleton Screen while loading, and saves every change including interactive tip updates.
 */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { TabLedger, AllocationRule } from '@/types/tab';
import {
  normalizeLedger,
  toUnassignedRows,
  scrubRemovedParticipants,
  renameParticipantInLedger,
  computeLedgerTotalCents,
} from '@/lib/ledgerUtils';
import { tabStorage } from '@/lib/tabStorage';
import { toWizardParticipants, WizardParticipant, DEFAULT_PARTICIPANTS } from '@/lib/participants';
import { StepAssign } from '@/components/StepAssign';
import { StepSettle } from '@/components/StepSettle';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Button, Skeleton } from '@/components/ui';

export type TabStep = 'assign' | 'settle';

const STEP_INFO: Record<TabStep, { n: number; title: string; subtitle: string }> = {
  assign: {
    n: 2,
    title: 'Who had what?',
    subtitle: 'Speak or type naturally. Everyone’s share updates on the receipt below.',
  },
  settle: {
    n: 3,
    title: 'Settle the bill',
    subtitle: 'Share one link to the group chat or let friends scan their QR code.',
  },
};

export function TabScreen({ step }: { step: TabStep }) {
  const params = useParams<{ id: string }>();
  const tabId = decodeURIComponent(params.id);
  const router = useRouter();

  const [ledger, setLedger] = useState<TabLedger | null>(null);
  const [participants, setParticipants] = useState<WizardParticipant[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [voiceApplied, setVoiceApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [initialFilter, setInitialFilter] = useState<'all' | 'unpaid' | 'paid'>('all');
  const [fromHistory, setFromHistory] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    tabStorage.getTab(tabId).then((tab) => {
      if (cancelled) return;
      const params = new URLSearchParams(window.location.search);
      setSelectedPerson(params.get('person'));
      const f = params.get('filter');
      setInitialFilter(f === 'paid' || f === 'unpaid' ? f : 'all');
      setFromHistory(params.get('from') === 'history');

      if (!tab) {
        setStatus('missing');
        return;
      }
      const fresh = normalizeLedger(tab);
      setLedger(fresh);
      setParticipants(toWizardParticipants(fresh.participants));
      if (fresh.lastCommand) {
        setVoiceTranscript(fresh.lastCommand);
        setVoiceApplied(true);
      }
      setStatus('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  /** Updates and saves the tab. */
  const commit = useCallback(async (next: TabLedger, nextParticipants?: WizardParticipant[]) => {
    const ps = nextParticipants ?? toWizardParticipants(next.participants);
    const saved = { ...next, participants: ps };
    setLedger(saved);
    setParticipants(ps);
    await tabStorage.saveTab(saved);
  }, []);

  /** Updates tip amount and optional tip allocation rule directly from the Step 2 Tip Bar. */
  const handleUpdateTip = useCallback(
    (tipCents: number, tipAllocationRule?: AllocationRule) => {
      if (!ledger) return;
      const nextLedger: TabLedger = {
        ...ledger,
        tipCents: Math.max(0, Math.round(tipCents)),
        tipAllocationRule: tipCents > 0 ? tipAllocationRule : undefined,
        updatedAt: Date.now(),
      };
      nextLedger.totalCents = computeLedgerTotalCents(nextLedger);
      commit(nextLedger, participants);
    },
    [ledger, participants, commit]
  );

  /** Applies a spoken/typed command additively and returns the updated ledger & participants. */
  const applyVoice = useCallback(
    async (
      audio?: string | null,
      text?: string
    ): Promise<{ ok: boolean; updatedLedger?: TabLedger; updatedParticipants?: WizardParticipant[] }> => {
      if (!ledger) return { ok: false };
      const aud = audio !== undefined ? audio : audioBase64;
      const txt = (text !== undefined ? text : voiceTranscript)?.trim();
      if (!aud && !txt) return { ok: true, updatedLedger: ledger, updatedParticipants: participants };

      const baseline = ledger.scanBaseline ?? {
        rows: toUnassignedRows(ledger.rows),
        discountCents: ledger.discountCents || 0,
        tipCents: ledger.tipCents || 0,
      };

      setBusy(true);
      setVoiceError(null);
      try {
        const res = await fetch('/api/parse-tab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tabId: ledger.id,
            audio: aud || undefined,
            voiceTranscript: txt || undefined,
            existingItems: ledger.rows,
            existingParticipants: participants,
            merchant: ledger.merchant,
            date: ledger.date,
            taxCents: ledger.taxCents,
            taxPercentage: ledger.taxPercentage,
            isTaxInclusive: ledger.isTaxInclusive,
            taxType: ledger.taxType,
            serviceChargeCents: ledger.serviceChargeCents,
            discountCents: baseline.discountCents,
            roundOffCents: ledger.roundOffCents,
            tipCents: ledger.tipCents || 0,
            tipAllocationRule: ledger.tipAllocationRule,
            totalCents: ledger.totalCents,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ledger) {
          setVoiceError(data?.message || `Could not apply the command (HTTP ${res.status}).`);
          return { ok: false };
        }
        const updated = normalizeLedger({
          ...data.ledger,
          id: ledger.id,
          payeeEmail: ledger.payeeEmail,
          createdAt: ledger.createdAt,
          scanBaseline: baseline,
          lastCommand: txt || ledger.lastCommand,
        });
        const ps = updated.participants?.length ? toWizardParticipants(updated.participants) : participants;
        commit(updated, ps);
        setVoiceApplied(true);
        if (data.fallbackReason) console.warn(data.fallbackReason);
        return { ok: true, updatedLedger: updated, updatedParticipants: ps };
      } catch {
        setVoiceError('Could not reach the server. Check your connection and try again.');
        return { ok: false };
      } finally {
        setBusy(false);
      }
    },
    [ledger, audioBase64, voiceTranscript, participants, commit]
  );

  const resetSplit = useCallback(() => {
    if (!ledger) return;
    const baseline = ledger.scanBaseline ?? {
      rows: toUnassignedRows(ledger.rows),
      discountCents: 0,
      tipCents: 0,
    };
    const resetLedger = normalizeLedger({
      ...ledger,
      payeeEmail: ledger.payeeEmail,
      rows: toUnassignedRows(baseline.rows),
      discountCents: baseline.discountCents,
      tipCents: baseline.tipCents,
      tipAllocationRule: undefined,
      participants: [],
      lastCommand: undefined,
    });
    resetLedger.totalCents = computeLedgerTotalCents(resetLedger);
    commit(resetLedger, []);
    setVoiceTranscript('');
    setAudioBase64(null);
    setVoiceApplied(false);
    setVoiceError(null);
  }, [ledger, commit]);

  const handleRenameSelf = useCallback(
    (oldName: string, newName: string) => {
      if (!ledger) return;
      const updatedLedger = renameParticipantInLedger(ledger, oldName, newName);
      const ps = toWizardParticipants(updatedLedger.participants);
      commit(updatedLedger, ps);
    },
    [ledger, commit]
  );

  const go = (next: TabStep) => router.push(`/tab/${encodeURIComponent(tabId)}/${next}`);

  const settleParticipants = useMemo(
    () =>
      (participants.length ? participants : DEFAULT_PARTICIPANTS).map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isHost: p.isHost,
        shareCents: 0,
        paid: false,
      })),
    [participants]
  );

  const isSettleFromHistory = step === 'settle' && fromHistory;
  const headerStep = isSettleFromHistory ? undefined : STEP_INFO[step].n;
  const headerSubtitle = isSettleFromHistory
    ? 'Saved bill settlement overview. Share the link or scan QR codes below.'
    : STEP_INFO[step].subtitle;

  if (status === 'loading') {
    const info = STEP_INFO[step];
    return (
      <div className="w-full">
        <ScreenHeader step={headerStep} subtitle={headerSubtitle} tabId={tabId} title={info.title}/>
        <div className="spotlight-card p-4 sm:p-6 space-y-4">
          <Skeleton className="h-12 w-full rounded-full"/>
          <Skeleton className="h-24 w-full rounded-2xl"/>
          <Skeleton className="h-56 w-full rounded-xl"/>
        </div>
      </div>
    );
  }
  if (status === 'missing' || !ledger) {
    return (
      <div className="w-full pt-10 text-center space-y-4">
        <p className="text-sm text-[var(--fg-secondary)]">
          This receipt is not saved in this browser. Receipts are stored on the device that scanned them.
        </p>
        <div className="flex justify-center gap-2">
          <Link href="/history"><Button variant="secondary">Saved Bills</Button></Link>
          <Link href="/"><Button>Scan a receipt</Button></Link>
        </div>
      </div>
    );
  }

  const info = STEP_INFO[step];
  return (
    <div className="w-full">
      <ScreenHeader step={headerStep} subtitle={headerSubtitle} tabId={tabId} title={info.title}/>
      <div className="spotlight-card p-3.5 sm:p-6">
        {step === 'assign' && (
          <StepAssign
            ledger={ledger}
            onParticipantsChange={(ps) =>
              commit(
                scrubRemovedParticipants(
                  { ...ledger, participants: ps },
                  ps.map((p) => p.name)
                ),
                ps
              )
            }
            participants={participants}
            onRenameSelf={handleRenameSelf}
            onUpdateTip={handleUpdateTip}
            onResetSplit={resetSplit}
            voiceTranscript={voiceTranscript}
            onVoiceTranscript={(t) => {
              setVoiceTranscript(t);
              setVoiceApplied(false);
            }}
            audioBase64={audioBase64}
            onAudioBase64={(a) => {
              setAudioBase64(a);
              setVoiceApplied(false);
            }}
            onApplyVoice={async (aud, txt) => {
              await applyVoice(aud, txt);
            }}
            loading={busy}
            error={voiceError}
            onNext={async () => {
              let finalLedger = ledger;
              let finalPs = participants;
              if (!voiceApplied && (audioBase64 || voiceTranscript.trim())) {
                const res = await applyVoice(audioBase64, voiceTranscript);
                if (!res.ok) return;
                if (res.updatedLedger) finalLedger = res.updatedLedger;
                if (res.updatedParticipants) finalPs = res.updatedParticipants;
              }
              if (finalLedger && finalPs.length === 0) {
                await commit(finalLedger, DEFAULT_PARTICIPANTS);
              }
              go('settle');
            }}
            onBack={() => router.push('/?scan=1')}
          />
        )}
        {step === 'settle' && (
          <StepSettle
            ledger={ledger}
            participants={settleParticipants}
            sharedPerson={selectedPerson}
            isSharedView={false}
            initialFilter={initialFilter}
            onSelectPerson={setSelectedPerson}
            onRenameSelf={isSettleFromHistory ? undefined : handleRenameSelf}
            onStartOver={() => router.push('/?scan=1')}
            onBack={isSettleFromHistory ? () => router.push('/history') : () => go('assign')}
          />
        )}
      </div>
    </div>
  );
}
