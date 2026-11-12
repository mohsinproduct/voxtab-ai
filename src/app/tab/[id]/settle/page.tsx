import { Suspense } from 'react';
import type { Metadata } from 'next';
import { TabScreen } from '@/components/TabScreen';

export const metadata: Metadata = { title: 'Settle: VoxTab' };

// The tab id is only known at request time; the screen reads it inside Suspense (Cache Components).
export default function Page() {
  return (
    <Suspense fallback={<p className="pt-10 text-center text-sm text-[var(--fg-muted)]">Loading receipt…</p>}>
      <TabScreen step="settle" />
    </Suspense>
  );
}
