/**
 * @file route.ts
 * @description PayPal Orders v2 (Sandbox) endpoint for the settle step.
 *
 * - POST creates one CAPTURE order per participant share. The QR code and the PayPal button
 *   both use this order, so a payment made on any device can be verified here.
 * - GET ?orderId= reads the order and captures it once the payer has approved it. It reports
 *   `paid: true` only when PayPal returns a COMPLETED capture.
 *
 * Authentication follows https://developer.paypal.com/api/rest/authentication/ : the app's
 * client ID and secret are exchanged for an OAuth 2.0 access token (client_credentials grant).
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  saveServerOrder,
  findServerOrderById,
  saveServerPaidStatus,
  getServerShareByCode,
  ServerOrderRecord,
  PAYPAL_CURRENCIES,
} from '@/lib/shortLinkStore';
import { computeSplit } from '@/lib/ledgerUtils';

const PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';

type PayPalErrorCode =
  | 'PAYPAL_SERVER_CREDENTIALS_MISSING'
  | 'PAYPAL_OAUTH_FAILED'
  | 'PAYPAL_ACCESS_TOKEN_MISSING'
  | 'PAYPAL_SERVER_CONFIG_ERROR';

/** Configuration problems that retrying cannot fix (reported as 503 with a clear message). */
class PayPalConfigError extends Error {
  code: PayPalErrorCode;

  constructor(message: string, code: PayPalErrorCode) {
    super(message);
    this.name = 'PayPalConfigError';
    this.code = code;
  }
}

interface PayPalOrder {
  id: string;
  status: string;
  purchase_units?: {
    amount?: { value?: string };
    payee?: { email_address?: string };
    payments?: { captures?: { id: string; status: string; amount?: { value?: string; currency_code?: string } }[] };
  }[];
  links?: { href: string; rel: string }[];
}

interface CreateOrderBody {
  shareCode?: unknown;
  participantName?: unknown;
  returnUrl?: unknown;
  cancelUrl?: unknown;
}

const IS_SANDBOX = PAYPAL_API_BASE.includes('sandbox');

type PayeeMode = 'custom' | 'sandbox_fallback';

/** PayPal issue codes that indicate the requested payee itself is rejected (not the order). */
const PAYEE_REJECTION_ISSUES = new Set(['PAYEE_ACCOUNT_NOT_VERIFIED', 'PAYEE_NOT_CONSENTED']);

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Capture attempt counter per order, used to build the PayPal-Request-Id (see captureOrder). */
const captureAttempts = new Map<string, number>();

async function getPayPalAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new PayPalConfigError("PAYPAL_SERVER_CREDENTIALS_MISSING", 'PAYPAL_SERVER_CREDENTIALS_MISSING');
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(
    `${PAYPAL_API_BASE}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new PayPalConfigError("PAYPAL_OAUTH_FAILED", 'PAYPAL_OAUTH_FAILED');
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new PayPalConfigError("PAYPAL_ACCESS_TOKEN_MISSING", 'PAYPAL_ACCESS_TOKEN_MISSING');
  }

  const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 300;
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(expiresInSec - 60, 30) * 1000,
  };
  return cachedToken.token;
}

async function paypalFetch(
  path: string,
  method: 'GET' | 'POST',
  options: { body?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  const token = await getPayPalAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body,
  });
  if (res.status === 401) {
    cachedToken = null; // Token expired or was revoked early: request a new one next time.
  }
  return res;
}

/** Extracts PayPal's error `issue` code and a readable message from a failed response. */
async function readPayPalError(res: Response): Promise<{ issue?: string; message: string }> {
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    const detail = data?.details?.[0];
    const issue: string | undefined = detail?.issue;
    const description: string = detail?.description || data?.message || text;
    const debugId = data?.debug_id ? ` (debug_id ${data.debug_id})` : '';
    return { issue, message: `${issue ? `${issue}: ` : ''}${description}${debugId}` };
  } catch {
    return { message: text || `HTTP ${res.status}` };
  }
}

function errorResponse(error: unknown, context: string) {
  if (error instanceof PayPalConfigError) {
    // Never echo secrets or tokens to the client.
    return NextResponse.json({ error: 'PayPal server configuration error', code: error.code }, { status: 503 });
  }
  console.error(`[paypal-order] ${context}:`, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : context, code: 'PAYPAL_API_ERROR' },
    { status: 500 }
  );
}

const moneyObj = (cents: number, currencyCode = 'USD') => ({
  currency_code: currencyCode,
  value: currencyCode === 'JPY' ? String(Math.round(cents / 100)) : (cents / 100).toFixed(2),
});

function isValidEmail(val: unknown): val is string {
  return typeof val === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val.trim());
}

function buildPurchaseUnit(
  amountCents: number,
  description: unknown,
  items: unknown,
  payeeEmail?: string,
  currencyCode = 'USD'
) {
  const label = (
    typeof description === 'string' && description.trim() ? description.trim() : 'VoxTab split'
  ).slice(0, 127);
  const payeeBlock = payeeEmail ? { payee: { email_address: payeeEmail.trim() } } : {};
  const lineItems = (Array.isArray(items) ? items : [])
    .map((item) => ({
      name: String(item?.name ?? '').trim().slice(0, 127) || 'Item',
      cents: Math.round(Number(item?.amountCents)),
    }))
    .filter((item) => Number.isFinite(item.cents) && item.cents > 0);

  if (lineItems.length === 0 || currencyCode === 'JPY') {
    return { description: label, amount: moneyObj(amountCents, currencyCode), ...payeeBlock };
  }

  const itemTotalCents = lineItems.reduce((sum, item) => sum + item.cents, 0);
  const adjustmentCents = amountCents - itemTotalCents;
  return {
    description: label,
    ...payeeBlock,
    amount: {
      ...moneyObj(amountCents, currencyCode),
      breakdown: {
        item_total: moneyObj(itemTotalCents, currencyCode),
        tax_total: moneyObj(Math.max(adjustmentCents, 0), currencyCode),
        discount: moneyObj(Math.max(-adjustmentCents, 0), currencyCode),
      },
    },
    items: lineItems.map((item) => ({
      name: item.name,
      quantity: '1',
      unit_amount: moneyObj(item.cents, currencyCode),
    })),
  };
}

/**
 * Returns the trusted application origin. Checks `req.nextUrl.origin` first
 * (requiring HTTPS only in production) and falls back to NEXT_PUBLIC_APP_URL.
 */
function getTrustedAppOrigin(req: NextRequest): string {
  const nextOrigin = req.nextUrl?.origin;
  if (nextOrigin) {
    const url = new URL(nextOrigin);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new PayPalConfigError(
        'NEXT_PUBLIC_APP_URL must use HTTPS in production',
        'PAYPAL_SERVER_CONFIG_ERROR'
      );
    }
    return url.origin;
  }

  const configured = (process.env.NEXT_PUBLIC_APP_URL || '').trim();
  if (!configured) {
    throw new PayPalConfigError(
      'NEXT_PUBLIC_APP_URL is not configured',
      'PAYPAL_SERVER_CONFIG_ERROR'
    );
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new PayPalConfigError(
      'NEXT_PUBLIC_APP_URL is not a valid absolute URL',
      'PAYPAL_SERVER_CONFIG_ERROR'
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PayPalConfigError(
      'NEXT_PUBLIC_APP_URL must use http or https',
      'PAYPAL_SERVER_CONFIG_ERROR'
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new PayPalConfigError(
      'NEXT_PUBLIC_APP_URL must not contain credentials',
      'PAYPAL_SERVER_CONFIG_ERROR'
    );
  }

  if (url.search !== '' || url.hash !== '') {
    throw new PayPalConfigError(
      'NEXT_PUBLIC_APP_URL must not contain a query string or fragment',
      'PAYPAL_SERVER_CONFIG_ERROR'
    );
  }

  if (url.pathname !== '/') {
    throw new PayPalConfigError(
      'NEXT_PUBLIC_APP_URL must be an application origin, not a path',
      'PAYPAL_SERVER_CONFIG_ERROR'
    );
  }

  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new PayPalConfigError(
      'NEXT_PUBLIC_APP_URL must use HTTPS in production',
      'PAYPAL_SERVER_CONFIG_ERROR'
    );
  }

  return url.origin;
}

/**
 * Captures an approved order. Duplicate or concurrent attempts share a PayPal-Request-Id, so PayPal
 * processes the capture once and replays the result. After a rejected attempt (for example
 * INSTRUMENT_DECLINED) the next attempt gets a new ID, so the payer can retry with another funding source.
 */
async function captureOrder(orderId: string): Promise<Response> {
  const attempt = captureAttempts.get(orderId) ?? 0;
  const res = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, 'POST', {
    headers: {
      Prefer: 'return=representation',
      'PayPal-Request-Id': `cap-${orderId}-${attempt}`,
    },
  });
  if (res.ok) {
    captureAttempts.delete(orderId);
  } else if (res.status >= 400 && res.status < 500) {
    captureAttempts.set(orderId, attempt + 1);
  }
  return res;
}

export async function POST(req: NextRequest) {
  let body: CreateOrderBody | null = null;
  try {
    body = await req.json();
  } catch {
    // Handled below.
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const shareCode =
    typeof body.shareCode === 'string' ? body.shareCode.trim() : undefined;
  const participantName =
    typeof body.participantName === 'string' ? body.participantName.trim() : undefined;

  if (!shareCode) {
    return NextResponse.json({ error: 'shareCode is required' }, { status: 400 });
  }
  if (!participantName) {
    return NextResponse.json({ error: 'participantName is required' }, { status: 400 });
  }

  // Build return/cancel URLs from the trusted application origin.
  // Never trust client-supplied returnUrl or cancelUrl.
  let returnUrl: string;
  let cancelUrl: string;
  try {
    const origin = getTrustedAppOrigin(req);
    returnUrl = new URL('/paypal/return', origin).toString();
    cancelUrl = new URL('/paypal/return?paypal=cancel', origin).toString();
  } catch (error) {
    if (error instanceof PayPalConfigError) {
      return NextResponse.json(
        { error: 'PayPal server configuration error', code: error.code },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: 'Failed to resolve application origin', code: 'PAYPAL_SERVER_CONFIG_ERROR' },
      { status: 503 }
    );
  }

  // Load the trusted, server-saved bill snapshot. Never trust browser-supplied amounts.
  const savedShare = await getServerShareByCode(shareCode);
  if (!savedShare) {
    return NextResponse.json(
      { error: 'Share link not found or expired' },
      { status: 404 }
    );
  }

  const ledger = savedShare.ledgerSnapshot;
  const currencyCode = savedShare.currencyCode;
  const customPayee = typeof ledger.payeeEmail === 'string' && ledger.payeeEmail.trim()
    ? ledger.payeeEmail.trim()
    : undefined;

  // Route Sandbox checkouts to the configured Sandbox merchant unless a matching custom merchant is set.
  const configuredMerchantEmail = (process.env.PAYPAL_SANDBOX_MERCHANT_EMAIL || '').trim();
  const canUseCustomPayeeDirectly =
    !IS_SANDBOX ||
    Boolean(
      customPayee &&
        configuredMerchantEmail &&
        customPayee.toLowerCase() === configuredMerchantEmail.toLowerCase()
    );

  // Validate the payee email when one is provided. PayPal requires a well-formed
  // recipient email; reject invalid ones early with a clear message.
  if (customPayee !== undefined && !isValidEmail(customPayee)) {
    return NextResponse.json(
      { error: 'PayPal payout email is invalid. Please enter a valid email address.' },
      { status: 400 }
    );
  }

  // Validate the requested participant against the saved ledger (case/space insensitive).
  const requestedParticipantName = participantName;
  const matchedParticipants = (ledger.participants || []).filter(
    (p: { name: string }) =>
      p.name.trim().toLowerCase() === requestedParticipantName.trim().toLowerCase()
  );
  if (matchedParticipants.length !== 1) {
    return NextResponse.json(
      { error: 'Participant not found or ambiguous' },
      { status: 400 }
    );
  }
  const participant = matchedParticipants[0];

  const participantNames = (ledger.participants || []).map((p: { name: string }) => p.name);
  const split = computeSplit(ledger, participantNames).find(
    (entry) => entry.participantName === participant.name
  );

  if (
    !split ||
    !Number.isSafeInteger(split.amountCents) ||
    split.amountCents <= 0
  ) {
    return NextResponse.json(
      { error: 'Invalid participant share' },
      { status: 400 }
    );
  }

  // All payment-critical values come from the server-calculated split and saved bill.
  const amountCents = split.amountCents;
  const items = split.items;

  try {
    const createOrderAttempt = (payee?: string, useItems: unknown = items) =>
      paypalFetch('/v2/checkout/orders', 'POST', {
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            buildPurchaseUnit(amountCents, `${ledger.merchant || 'VoxTab'}: ${participant.name}'s share`, useItems, payee, currencyCode),
          ],
          application_context: {
            brand_name: 'VoxTab',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        }),
      });

    let payeeMode: PayeeMode =
      customPayee && !canUseCustomPayeeDirectly ? 'sandbox_fallback' : 'custom';
    let res = await createOrderAttempt(canUseCustomPayeeDirectly ? customPayee : undefined);

    if (!res.ok && customPayee && IS_SANDBOX && canUseCustomPayeeDirectly) {
      const { issue, message } = await readPayPalError(res);
      if (issue && PAYEE_REJECTION_ISSUES.has(issue)) {
        res = await createOrderAttempt(undefined);
        payeeMode = 'sandbox_fallback';
      } else {
        console.error(`[paypal-order] Create order failed (${res.status}): ${message}`);
        return NextResponse.json({ error: message, issue, code: 'PAYPAL_API_ERROR' }, { status: res.status });
      }
    }

    if (!res.ok) {
      const { issue, message } = await readPayPalError(res);
      console.error(`[paypal-order] Create order failed (${res.status}): ${message}`);
      return NextResponse.json({ error: message, issue, code: 'PAYPAL_API_ERROR' }, { status: res.status });
    }

    const order: PayPalOrder = await res.json();
    const approveUrl =
      order.links?.find((link) => link.rel === 'approve' || link.rel === 'payer-action')?.href ??
      `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(order.id)}`;

    // Persist the server order record before returning the approval URL. Fail closed if it
    // cannot be saved: do not hand out an order the server cannot later verify.
    try {
      await saveServerOrder({
        orderId: order.id,
        shareCode,
        tabId: ledger.id,
        participantName: participant.name,
        amountCents,
        currencyCode,
        requestedPayeeEmail: customPayee,
        payeeMode,
        createdAt: Date.now(),
      });
    } catch (saveError) {
      console.error(`[paypal-order] Failed to save server order ${order.id}:`, saveError);
      return NextResponse.json(
        { error: 'Failed to persist PayPal order record', code: 'SERVER_ORDER_SAVE_FAILED' },
        { status: 500 }
      );
    }

    return NextResponse.json({ orderId: order.id, status: order.status, approveUrl, payeeMode });
  } catch (error) {
    return errorResponse(error, 'Failed to create PayPal order');
  }
}

export async function GET(req: NextRequest) {
  const orderId = req.nextUrl.searchParams.get('orderId');
  if (!orderId) {
    return NextResponse.json({ error: 'orderId parameter is required' }, { status: 400 });
  }

  // The server-side order record is the source of truth. An order with no server record
  // cannot mark a participant paid, even if PayPal itself reports it completed.
  let saved: ServerOrderRecord | null;
  try {
    saved = await findServerOrderById(orderId);
  } catch (lookupError) {
    console.error(`[paypal-order] Failed to look up order ${orderId}:`, lookupError);
    return NextResponse.json(
      { paid: false, status: 'ERROR', error: 'Unable to look up the saved PayPal order', code: 'PAYPAL_ORDER_LOOKUP_FAILED' },
      { status: 503 }
    );
  }
  if (!saved) {
    return NextResponse.json(
      {
        paid: false,
        status: 'NOT_FOUND',
        error: 'No server-side order record for this PayPal order',
      },
      { status: 404 }
    );
  }

  const orderPath = `/v2/checkout/orders/${encodeURIComponent(orderId)}`;

  try {
    const orderRes = await paypalFetch(orderPath, 'GET');
    if (!orderRes.ok) {
      const { issue, message } = await readPayPalError(orderRes);
      return NextResponse.json(
        { paid: false, status: orderRes.status === 404 ? 'NOT_FOUND' : 'ERROR', issue, error: message },
        { status: orderRes.status }
      );
    }
    let order: PayPalOrder = await orderRes.json();

    // Preserve the pre-capture payee email: PayPal's capture response body often omits
    // purchase_units[0].payee.email_address, which would otherwise make actualPayee undefined.
    const preCapturePayeeEmail = order.purchase_units?.[0]?.payee?.email_address;

    // Approved by the payer (button popup, QR scan or redirect checkout): capture it now.
    // Concurrent capture attempts share a PayPal-Request-Id so PayPal replays the result instead
    // of double-capturing; a rejected attempt gets a new ID so the payer can retry funding.
    if (order.status === 'APPROVED') {
      const captureRes = await captureOrder(orderId);
      if (captureRes.ok) {
        order = await captureRes.json();
      } else if (captureRes.status === 422) {
        // A 422 payee error in Sandbox can mean the requested payee is rejected: re-fetch the order
        // and re-check its status instead of failing closed.
        const recheckRes = await paypalFetch(orderPath, 'GET');
        if (recheckRes.ok) {
          order = await recheckRes.json();
        }
      } else {
        const { issue, message } = await readPayPalError(captureRes);
        // Another request (polling, return page or button) may have captured it first: re-check.
        const recheckRes = await paypalFetch(orderPath, 'GET');
        if (recheckRes.ok) {
          order = await recheckRes.json();
        }
        if (order.status !== 'COMPLETED') {
          console.warn(`[paypal-order] Capture of ${orderId} failed (${captureRes.status}): ${message}`);
          return NextResponse.json(
            { paid: false, status: order.status, issue, error: message },
            { status: captureRes.status }
          );
        }
      }
    }

    // Accept COMPLETED captures (and PENDING captures in Sandbox test mode).
    const captures = order.purchase_units?.flatMap((u) => u.payments?.captures ?? []) ?? [];
    const completedCapture = captures.find(
      (c) => c.status === 'COMPLETED' || (IS_SANDBOX && c.status === 'PENDING')
    );
    if (order.status !== 'COMPLETED' || !completedCapture) {
      return NextResponse.json(
        { paid: false, status: order.status, captureStatus: completedCapture?.status ?? null },
        { status: 200 }
      );
    }

    // Exact amount and currency comparison against the server-saved expectation. String comparison
    // on PayPal's amount value avoids floating-point rounding entirely.
    const expectedMoney = moneyObj(saved.amountCents, saved.currencyCode);
    const actualAmount = completedCapture.amount?.value;
    const actualCurrency = completedCapture.amount?.currency_code;
    if (
      typeof actualAmount !== 'string' ||
      typeof actualCurrency !== 'string' ||
      actualAmount !== expectedMoney.value ||
      actualCurrency !== saved.currencyCode
    ) {
      return NextResponse.json(
        { paid: false, error: 'Capture amount or currency does not match the expected share' },
        { status: 200 }
      );
    }

    // Custom mode: verify the actual PayPal recipient against the saved requested email.
    if (saved.payeeMode === 'custom') {
      const actualPayee =
        order.purchase_units?.[0]?.payee?.email_address ?? preCapturePayeeEmail;
      if (
        !saved.requestedPayeeEmail ||
        (actualPayee && actualPayee.toLowerCase() !== saved.requestedPayeeEmail.toLowerCase())
      ) {
        return NextResponse.json(
          { paid: false, error: 'PayPal recipient could not be verified' },
          { status: 200 }
        );
      }
    }
    // sandbox_fallback: the actual recipient is not compared to the email originally entered.

    // Save the verified payment status server-side. Only this path may set source: 'paypal'.
    try {
      await saveServerPaidStatus(saved.shareCode, saved.participantName, {
        isPaid: true,
        paidAt: Date.now(),
        paypalTxId: completedCapture.id,
        source: 'paypal',
      });
    } catch (saveError) {
      console.error(`[paypal-order] Failed to save verified payment status for ${orderId}:`, saveError);
      return NextResponse.json(
        {
          paid: false,
          status: order.status,
          captureStatus: completedCapture.status,
          orderId: order.id,
          txId: completedCapture.id,
          code: 'PAYMENT_STATUS_SAVE_FAILED',
          error: 'PayPal completed the payment, but VoxTab could not persist the payment status. Retry verification to mark the participant paid.',
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      paid: true,
      status: order.status,
      captureStatus: completedCapture.status,
      orderId: order.id,
      txId: completedCapture.id,
      tabId: saved.tabId,
      shareCode: saved.shareCode,
      participantName: saved.participantName,
    });
  } catch (error) {
    return errorResponse(error, 'Failed to verify PayPal order');
  }
}
