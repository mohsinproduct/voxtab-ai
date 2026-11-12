import { NextRequest, NextResponse } from 'next/server';
import { getServerShareByCode } from '@/lib/shortLinkStore';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const person = req.nextUrl.searchParams.get('p') || req.nextUrl.searchParams.get('person');

  const target = new URL('/share', req.nextUrl.origin);
  target.searchParams.set('s', code);
  if (person) {
    target.searchParams.set('person', person);
  }

  try {
    const record = await getServerShareByCode(code);
    if (record?.encoded) {
      const hashParams = new URLSearchParams();
      hashParams.set('tab', record.encoded);
      if (person) hashParams.set('person', person);
      target.hash = hashParams.toString();
    }
  } catch {}

  return NextResponse.redirect(target);
}
