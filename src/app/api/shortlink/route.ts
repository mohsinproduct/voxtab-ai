import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import {
  saveServerShare,
  getServerShareByCode,
  getServerPaidStatusesByShareCode,
  PAYPAL_CURRENCIES,
} from '@/lib/shortLinkStore';
import { decodeShareLedger } from '@/lib/shareLedgerServer';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Manual payment statuses are stored client-side; the server only persists PayPal-verified statuses.
    if (body?.action === 'manual-status') {
      return NextResponse.json(
        {
          error:
            'Manual payment statuses are stored locally and cannot be changed through this endpoint.',
        },
        { status: 410 }
      );
    }

    // This endpoint only creates shortlinks from an encoded ledger.
    const encoded = body?.encoded;
    if (typeof encoded !== 'string' || !encoded.trim()) {
      return NextResponse.json({ error: 'Missing encoded ledger' }, { status: 400 });
    }

    const currencyCode =
      typeof body.currencyCode === 'string' ? body.currencyCode.trim().toUpperCase() : undefined;
    if (!currencyCode || !PAYPAL_CURRENCIES.has(currencyCode)) {
      return NextResponse.json(
        { error: 'currencyCode must be a supported currency' },
        { status: 400 }
      );
    }

    // Decode the ledger server-side and reject invalid or incomplete data.
    const ledger = decodeShareLedger(encoded.trim());
    if (!ledger) {
      return NextResponse.json({ error: 'Invalid or incomplete bill data' }, { status: 400 });
    }

    // Compute a deterministic share code from currency and encoded ledger.
    const code = createHash('sha256')
      .update(`${currencyCode}:${encoded.trim()}`)
      .digest('base64url')
      .slice(0, 22);

    const existing = await getServerShareByCode(code);
    if (!existing) {
      await saveServerShare({
        code,
        encoded: encoded.trim(),
        ledgerSnapshot: ledger,
        currencyCode,
        createdAt: Date.now(),
      });
    }

    // Never expose the internal share record; return only the public code.
    return NextResponse.json({ code });
  } catch (error) {
    console.error('[api/shortlink] Failed to process request:', error);
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')?.trim();
  if (code) {
    const record = await getServerShareByCode(code);
    if (!record) {
      return NextResponse.json({ error: 'Short link not found' }, { status: 404 });
    }
    return NextResponse.json({ encoded: record.encoded });
  }

  const shareCode = req.nextUrl.searchParams.get('shareCode')?.trim();
  if (shareCode) {
    try {
      const paid = await getServerPaidStatusesByShareCode(shareCode);
      // Public status summary: expose only the fields the shared settlement UI needs.
      // PayPal transaction IDs are not returned through this public endpoint.
      const summary: Record<string, { isPaid: boolean; paidAt?: number; source: 'paypal' }> = {};
      for (const [key, rec] of Object.entries(paid)) {
        summary[key] = {
          isPaid: rec.isPaid,
          paidAt: rec.paidAt,
          source: rec.source,
        };
      }
      return NextResponse.json(
        { paid: summary },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    } catch (error) {
      console.error('[api/shortlink] Failed to load payment statuses:', error);
      return NextResponse.json(
        { error: 'Unable to load payment statuses' },
        { status: 503 }
      );
    }
  }

  return NextResponse.json({ error: 'Missing code or shareCode' }, { status: 400 });
}
