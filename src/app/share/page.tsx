/**
 * @file page.tsx
 * @description /share#tab=...&person=...: a friend's tamper-proof view of a shared bill:
 * pick your name, review your share, and test payment with PayPal Sandbox.
 *
 * When a share code (`?s=...`) exists, the server-stored bill is the canonical source.
 * The URL fragment is only used as a legacy fallback when no server record is available.
 */
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TabLedger } from '@/types/tab';
import { ShareLinkAdapter } from '@/lib/tabStorage';
import { toWizardParticipants, DEFAULT_PARTICIPANTS, WizardParticipant } from '@/lib/participants';
import { StepSettle } from '@/components/StepSettle';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Button, Skeleton } from '@/components/ui';

export default function SharePage() {
  const router = useRouter();
  const [ledger, setLedger] = useState<TabLedger | null>(null);
  const [participants, setParticipants] = useState<WizardParticipant[]>([]);
  const [person, setPerson] = useState<string | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'invalid'>('loading');

  useEffect(() => {
    const loadShared = async () => {
      const query = new URLSearchParams(window.location.search);
      const shortCode = query.get('s');
      const shareParams = ShareLinkAdapter.readShareParams();
      let { encoded } = shareParams;
      const p = shareParams.person;

      // When a share code exists, the server-stored bill is authoritative.
      // Do not let an edited URL fragment override an existing server share record.
      if (shortCode) {
        setShareCode(shortCode);
        try {
          const res = await fetch(`/api/shortlink?code=${encodeURIComponent(shortCode)}`, {
            cache: 'no-store',
          });
          if (res.ok) {
            const data = await res.json();
            encoded = data?.encoded || null;
          }
        } catch {
          encoded = null;
        }
        if (!encoded) {
          setStatus('invalid');
          return;
        }
      }

      if (!encoded) {
        setStatus('invalid');
        return;
      }

      const decoded = await ShareLinkAdapter.decodeLedger(encoded);
      if (!decoded) {
        setStatus('invalid');
        return;
      }

      const ps = decoded.participants?.length
        ? toWizardParticipants(decoded.participants)
        : DEFAULT_PARTICIPANTS;
      const fullLedger = { ...decoded, participants: ps };
      // Shared bills live in temporary shared-view state only. They are not
      // saved into the visitor's own bill vault / History.
      setLedger(fullLedger);
      setParticipants(ps);
      setPerson(p);
      setStatus('ready');
    };

    loadShared();
  }, []);

  if (status === 'loading') {
    return (
      <div className="pt-6 space-y-4">
        <Skeleton className="h-8 w-44"/>
        <Skeleton className="h-24 w-full"/>
        <Skeleton className="h-52 w-full"/>
      </div>
    );
  }
  if (status === 'invalid' || !ledger) {
    return (
      <div className="pt-10 text-center space-y-4">
        <p className="text-sm text-[var(--fg-secondary)]">
          This share link is incomplete or damaged. Ask for the link again.
        </p>
        <Link href="/">
          <Button>Scan your own receipt</Button>
        </Link>
      </div>
    );
  }

  const headerTitle = person ? `${person}'s share` : 'Shared bill';
  const headerSubtitle = person
    ? `${ledger.merchant || 'Receipt'}: Review your items and pay your share below.`
    : `${ledger.merchant || 'Receipt'}: Tap your name below to view your items and pay your share on PayPal.`;

  return (
    <div className="w-full">
      <ScreenHeader subtitle={headerSubtitle} title={headerTitle} />
      <div className="spotlight-card p-3.5 sm:p-6">
        <StepSettle
          isSharedView
          ledger={ledger}
          onSelectPerson={setPerson}
          onStartOver={() => router.push('/')}
          participants={participants}
          sharedPerson={person}
          shareCode={shareCode}
          onBack={person ? () => setPerson(null) : undefined}
        />
      </div>
    </div>
  );
}
