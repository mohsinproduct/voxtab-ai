import { NextRequest, NextResponse } from 'next/server';

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
  return NextResponse.redirect(target);
}
