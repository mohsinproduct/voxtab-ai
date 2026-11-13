/**
 * @file route.ts
 * @description API endpoint for multimodal receipt parsing and natural language split allocation.
 *
 * Architecture:
 * - Implements the ExtractionAdapter interface.
 * - Primary Adapter: GeminiParserAdapter (Google Generative AI REST API) with multimodal image and audio support.
 * - ZERO hardcoded items or participants: extracts purely what is on the receipt and what is spoken in the voice command.
 * - Production models: gemini-3.5-flash-lite, gemini-3.5-flash, gemini-flash-lite-latest, gemini-flash-latest.
 * - Structured 6-Factor Allocation NER: LLM only emits structured AllocationRule objects; TypeScript computes all math.
 * - Fallback Adapter: LocalKeywordFallbackAdapter providing deterministic NLP regex matching for offline environments.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  ParseTabRequest,
  ParseTabResponse,
  ItemCategory,
  TabLedger,
  LedgerRow,
  Participant,
  AllocationRule,
  AllocationMode,
  AllocationShare,
} from '@/types/tab';
import { formatRuleSummary, LEDGER_SCHEMA_VERSION } from '@/lib/ledgerUtils';

/** itemMatch values meaning "the remaining items" / "the whole bill" (shared by all matching steps). */
const REST_MATCH_RE = /^(?:(?:the\s+)?rest(?:\s+of\s+(?:the\s+)?(?:items|bill|receipt|order|food))?|(?:the\s+|all\s+)?(?:other|others|remaining)(?:\s+items)?|everything\s+else)$/i;
const ALL_MATCH_RE = /^(?:all|everything|both|bill|receipt|all\s+items|the\s+whole\s+bill|whole\s+bill|entire\s+bill|split)$/i;

/**
 * Common contract for receipt extraction engines.
 */
export interface ExtractionAdapter {
  name: string;
  parse(req: ParseTabRequest): Promise<ParseTabResponse>;
}

const DEFAULT_COLORS = ['#e09f67', '#10b981', '#f59e0b', '#06b6d4', '#fb923c', '#14b8a6', '#38bdf8', '#a3e635'];

/**
 * Normalizes participant name, ensuring 'I', 'me', 'myself' map to 'Me'.
 */
function normalizePersonName(name: string): string {
  const trimmed = (name || '').trim();
  if (/^(?:i|me|myself)$/i.test(trimmed)) return 'Me';
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'with', 'item', 'items', 'pack', 'order',
  'de', 'del', 'la', 'el', 'los', 'las', 'con', 'al', 'du', 'des', 'in', 'on',
]);

function isWordSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 2) return false;
  if (a[0] !== b[0]) return false;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const temp = dp[i];
      dp[i] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = temp;
    }
  }
  return dp[a.length] <= 2;
}

function doesSpecificRuleMatchItem(
  item: { id: string; name: string; quantity: number },
  r: any
): { matched: boolean; score: number } {
  const itemId = (item.id || '').toLowerCase().trim();
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\bitem[_\s-]*\d+\b/g, ' ')
      .replace(/\b\d+\s*x\b/g, ' ')
      .replace(/[^a-z0-9\u00C0-\uFFFF]+/g, ' ')
      .trim();
  const itemName = norm(item.name || '');
  const rawMatch = (typeof r?.itemMatch === 'string' ? r.itemMatch : String(r?.itemMatch ?? '')).trim();
  if (!rawMatch || REST_MATCH_RE.test(rawMatch) || ALL_MATCH_RE.test(rawMatch)) {
    return { matched: false, score: 0 };
  }

  const mLow = rawMatch.toLowerCase();
  if (mLow === itemId || mLow === `item_${itemId}` || itemId === `item_${mLow}`) {
    return { matched: true, score: 100 };
  }
  const idTokens = mLow.match(/\bitem_\d+\b/g);
  if (idTokens && idTokens.includes(itemId)) {
    return { matched: true, score: 95 };
  }

  const ruleName = norm(rawMatch);
  if (ruleName && ruleName === itemName) {
    return { matched: true, score: 90 };
  }

  const stem = (w: string) => (w.length > 3 ? w.replace(/(?:es|s)$/, '') : w);
  const meaningfulWords = (s: string) =>
    norm(s)
      .split(' ')
      .filter((w) => w && !/^\d+$/.test(w) && !STOP_WORDS.has(w))
      .map(stem);

  const itemWords = meaningfulWords(item.name || '');
  const rWords = meaningfulWords(rawMatch);
  if (itemWords.length === 0 || rWords.length === 0) {
    return { matched: false, score: 0 };
  }

  const hasWord = (list: string[], target: string) => list.some((w) => isWordSimilar(w, target));
  const allRuleInItem = rWords.every((w) => hasWord(itemWords, w));
  const allItemInRule = itemWords.every((w) => hasWord(rWords, w));
  if (allRuleInItem || allItemInRule) {
    return { matched: true, score: 50 + rWords.length };
  }

  const overlap = rWords.filter((w) => w.length >= 3 && hasWord(itemWords, w)).length;
  if (overlap > 0) {
    return { matched: true, score: overlap * 10 };
  }

  return { matched: false, score: 0 };
}

function findMatchingRule(
  item: { id: string; name: string; quantity: number },
  rules: any[],
  allItems?: { id: string; name: string; quantity: number }[]
): any | undefined {
  if (!rules || rules.length === 0) return undefined;
  const matchOf = (r: any) =>
    (typeof r?.itemMatch === 'string' ? r.itemMatch : String(r?.itemMatch ?? '')).trim();

  // Find all specific rules that match this item, filtering out weak single-word overlaps
  // when that rule strongly matches (>= 50) a DIFFERENT item on the receipt.
  const scored = rules
    .map((r) => ({ rule: r, ...doesSpecificRuleMatchItem(item, r) }))
    .filter((x) => {
      if (!x.matched) return false;
      if (x.score >= 50 || !allItems || allItems.length <= 1) return true;
      const stronglyMatchesOtherItem = allItems.some(
        (other) =>
          other.id !== item.id && doesSpecificRuleMatchItem(other, x.rule).score >= 50
      );
      return !stronglyMatchesOtherItem;
    });

  if (scored.length > 0) {
    const maxScore = Math.max(...scored.map((x) => x.score));
    // Keep all rules that tied or matched strongly (score >= 50) for this same item
    const matchingRules = scored
      .filter((x) => x.score >= 50 || x.score === maxScore)
      .map((x) => x.rule);

    if (matchingRules.length === 1) {
      return matchingRules[0];
    }

    // Merge multiple rules targeting the same receipt item (e.g., Ali got Pasta + Sara took 1 Pasta)
    const combinedShares: { person: string; value: number }[] = [];
    const combinedExcluded: string[] = [];
    let combinedRemainder: string[] = [];
    const hasQuantityRule = matchingRules.some((r) => r.mode === 'quantity');
    const mergedMode =
      hasQuantityRule || (item.quantity || 1) > 1 ? 'quantity' : matchingRules[0].mode;

    for (const r of matchingRules) {
      for (const s of r.shares || []) {
        const existing = combinedShares.find(
          (cs) => cs.person.toLowerCase() === String(s.person).toLowerCase()
        );
        const val = Number(s.value) > 0 ? Number(s.value) : 1;
        if (existing) {
          existing.value += val;
        } else {
          combinedShares.push({ person: s.person, value: val });
        }
      }
      for (const ex of r.excluded || []) {
        if (!combinedExcluded.includes(ex)) combinedExcluded.push(ex);
      }
      if (Array.isArray(r.remainderTo) && r.remainderTo.length > 0) {
        combinedRemainder = r.remainderTo;
      }
    }

    return {
      itemMatch: item.name,
      mode: mergedMode,
      shares: combinedShares,
      excluded: combinedExcluded,
      remainderTo: combinedRemainder,
    };
  }

  // Fallback to 'REST' / 'OTHER'
  const restMatch = rules.find((r) => REST_MATCH_RE.test(matchOf(r)));
  if (restMatch) return restMatch;

  // Fallback to 'ALL' / 'BILL' / 'SPLIT'
  const allMatch = rules.find((r) => ALL_MATCH_RE.test(matchOf(r)));
  if (allMatch) return allMatch;

  return undefined;
}

/**
 * Validates the parsed receipt structure from Gemini.
 */
/** Parses a printed money value: numbers, "12.50", "1,350.00", "$4". Returns NaN when unreadable. */
function toMoney(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  return cleaned ? parseFloat(cleaned) : NaN;
}

const moneyOr0 = (value: unknown) => {
  const n = toMoney(value);
  return Number.isFinite(n) ? n : 0;
};

/** Words that mean "the group", never a person's name. */
const GROUP_WORD_RE = /^(?:all|everyone|everybody|both|us|we|group|shared|split|rest|the rest|others|other|remaining|together)$/i;
const isGroupWord = (name: string) => GROUP_WORD_RE.test((name || '').trim());

/**
 * Validates the parsed receipt and cleans it in place: unreadable lines are dropped, negative lines
 * (coupons, voids) are moved into the discount. Fails only when no usable item remains.
 */
function validateReceiptStructure(data: any): { valid: boolean; error?: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, error: 'Output is not a valid JSON object' };
  }
  if (!Array.isArray(data.items)) {
    return { valid: false, error: 'Missing "items" array in response' };
  }
  const kept: any[] = [];
  let extraDiscount = 0;
  for (const item of data.items) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const qty = toMoney(item.quantity);
    const unit = toMoney(item.unitPrice);
    let price = toMoney(item.totalPrice ?? item.price);
    if (!Number.isFinite(price) || price === 0) {
      price = Number.isFinite(unit) ? unit * (Number.isFinite(qty) && qty > 0 ? qty : 1) : price;
    }
    if (!Number.isFinite(price)) continue;
    if (price < 0) {
      extraDiscount += Math.abs(price);
      continue;
    }
    if (!name || price === 0) continue;
    kept.push({ ...item, name, totalPrice: price, quantity: Number.isFinite(qty) && qty > 0 ? qty : 1 });
  }
  if (kept.length === 0) {
    return { valid: false, error: 'NO_ITEMS: no readable line items on the receipt' };
  }
  data.items = kept;
  if (extraDiscount > 0) data.discount = Math.abs(moneyOr0(data.discount)) + extraDiscount;
  return { valid: true };
}

/** Coerces the voice model output to the expected shape (bad entries are dropped, not fatal). */
function sanitizeVoiceOutput(data: any): {
  participants: string[];
  rules: any[];
  speakerName: string | null;
  tipOverride: any;
  tipRule: any;
  discountOverride: any;
} | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const nameOf = (v: any) =>
    typeof v === 'string'
      ? v
      : typeof v?.name === 'string'
      ? v.name
      : typeof v?.person === 'string'
      ? v.person
      : '';
  const names = (v: any) =>
    (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
      .map(nameOf)
      .map((s: string) => s.trim())
      .filter(Boolean);
  const MODES = ['equal', 'exclude', 'quantity', 'percentage', 'fixed'];
  const cleanRule = (r: any) => ({
    itemMatch: String(r.itemMatch ?? '').trim(),
    mode: String(r.mode).toLowerCase(),
    shares: (Array.isArray(r.shares) ? r.shares : [])
      .filter((s: any) => s && nameOf(s))
      .map((s: any) => ({ person: nameOf(s).trim(), value: moneyOr0(s.value) })),
    excluded: names(r.excluded),
    remainderTo: names(r.remainderTo),
  });

  const rulesIn = Array.isArray(data.rules)
    ? data.rules
    : Array.isArray(data.itemRules)
    ? data.itemRules
    : [];
  const allRules = rulesIn
    .filter((r: any) => r && typeof r === 'object' && MODES.includes(String(r.mode).toLowerCase()))
    .map(cleanRule)
    .filter((r: any) => r.itemMatch);

  const tipRuleFromList = allRules.find((r: any) => /^(?:tip|tips|the tip|gratuity)$/i.test(r.itemMatch));
  const rules = allRules.filter((r: any) => !/^(?:tip|tips|the tip|gratuity)$/i.test(r.itemMatch));

  const rawTipRule = data.tipRule || data.tipOverride?.rule || tipRuleFromList || null;
  const tipRule =
    rawTipRule && typeof rawTipRule === 'object' && MODES.includes(String(rawTipRule.mode).toLowerCase())
      ? cleanRule({ ...rawTipRule, itemMatch: 'TIP' })
      : null;

  return {
    participants: names(data.participants),
    rules,
    speakerName: typeof data.speakerName === 'string' && data.speakerName.trim() ? data.speakerName.trim() : null,
    tipOverride: data.tipOverride,
    tipRule,
    discountOverride: data.discountOverride,
  };
}

/** Error carrying an HTTP status for the client (quota, bad key, ...). */
class ParseError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}

/**
 * Helper to build a complete TabLedger from extracted data.
 * Zero assumptions: If receipt has no tax, tax is strictly 0.00 (0%).
 * Converts serviceCharge to serviceChargeCents, includes + serviceChargeCents in netItemsCents,
 * reconciles against printedTotalCents, and stores serviceChargeCents on TabLedger.
 */
function buildLedgerFromExtracted(
  merchant: string,
  date: string,
  items: {
    id: string;
    name: string;
    price: number;
    quantity: number;
    category?: ItemCategory;
    assignedTo: string[];
    isTaxInclusive?: boolean;
    allocationRule?: AllocationRule;
    ruleSummary?: string;
  }[],
  participantsList: string[],
  taxAmount: number,
  taxPercentage: number,
  declaredTaxType: 'inclusive' | 'exclusive' | 'none' | undefined,
  discount: number,
  roundOff: number,
  tip: number,
  total: number,
  serviceCharge: number = 0,
  tabId?: string,
  /**
   * Voice passes: keep the tax type decided at scan time. `total` is then the app's own computed
   * total (including the previous tip), so re-checking it against a new tip can misclassify the tax.
   */
  lockTaxType = false,
  tipAllocationRule?: AllocationRule
): TabLedger {
  const uniqueNames = Array.from(
    new Map((participantsList || []).filter(Boolean).map((n) => [n.toLowerCase(), n] as const)).values()
  );
  const hasSelfName = uniqueNames.some((n) => /^(?:me|myself|i|host)$/i.test(n.trim()));
  const participants: Participant[] = uniqueNames.map((name, idx) => ({
    id: `p_${name.toLowerCase().replace(/\s+/g, '_')}`,
    name,
    color: DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
    isHost: /^(?:me|myself|i|host)$/i.test(name.trim()) || (!hasSelfName && idx === 0),
  }));

  const itemsSumCents = Math.round(items.reduce((s, it) => s + it.price, 0) * 100);
  const discountCents = Math.round(Math.abs(discount || 0) * 100);
  const serviceChargeCents = Math.round(Math.max(0, serviceCharge || 0) * 100);
  const roundOffCents = Math.round((roundOff || 0) * 100); // e.g. -1 for -0.01
  const tipCents = Math.round(Math.max(0, tip || 0) * 100);
  const rawTaxCents = Math.round(Math.max(0, taxAmount || 0) * 100);
  const printedTotalCents = total > 0 ? Math.round(total * 100) : 0;

  // Deductions: discount plus round-off if negative; Service charge is added
  const totalDeductionsCents = discountCents + (roundOffCents < 0 ? Math.abs(roundOffCents) : (roundOffCents > 0 ? -roundOffCents : 0));
  const netItemsCents = Math.max(0, itemsSumCents - totalDeductionsCents + serviceChargeCents);

  // Robust Mathematical Reconciliation to classify tax:
  let isTaxInclusive = false;
  let taxType: 'inclusive' | 'exclusive' | 'none' = 'none';

  if (rawTaxCents === 0 && (!taxPercentage || taxPercentage === 0)) {
    taxType = 'none';
    isTaxInclusive = false;
  } else if (lockTaxType && declaredTaxType) {
    taxType = declaredTaxType;
    isTaxInclusive = declaredTaxType === 'inclusive';
  } else if (printedTotalCents > 0) {
    const diffIfInclusive = Math.abs(netItemsCents + tipCents - printedTotalCents);
    const diffIfExclusive = Math.abs(netItemsCents + rawTaxCents + tipCents - printedTotalCents);

    if (diffIfInclusive <= 10 && diffIfExclusive > 10) {
      isTaxInclusive = true;
      taxType = 'inclusive';
    } else if (diffIfExclusive <= 10 && diffIfInclusive > 10) {
      isTaxInclusive = false;
      taxType = 'exclusive';
    } else if (declaredTaxType === 'inclusive') {
      isTaxInclusive = true;
      taxType = 'inclusive';
    } else {
      isTaxInclusive = false;
      taxType = 'exclusive';
    }
  } else if (declaredTaxType === 'inclusive') {
    isTaxInclusive = true;
    taxType = 'inclusive';
  } else {
    isTaxInclusive = false;
    taxType = 'exclusive';
  }

  // Exact Tax Rate Determination:
  let taxRate = 0;
  let taxCents = rawTaxCents;

  if (taxPercentage && taxPercentage > 0) {
    taxRate = taxPercentage / 100;
  } else if (taxCents > 0 && netItemsCents > 0) {
    taxRate = taxCents / netItemsCents;
  } else {
    taxRate = 0;
    taxCents = 0;
  }

  // Final Total Calculation:
  const computedTotalCents = isTaxInclusive
    ? netItemsCents + tipCents
    : netItemsCents + taxCents + tipCents;
  const totalCents = computedTotalCents > 0 ? computedTotalCents : printedTotalCents;

  const rows: LedgerRow[] = items.map((it, idx) => {
    let assigned = 'split';
    if (it.assignedTo && it.assignedTo.length === 1 && it.assignedTo[0]) {
      const target = it.assignedTo[0];
      if (!isGroupWord(target)) {
        const found = participants.find((p) => p.name.toLowerCase() === target.toLowerCase() || p.id === target);
        assigned = found ? found.name : target;
      }
    } else if (it.assignedTo && it.assignedTo.length > 1) {
      assigned = it.assignedTo.join(', ');
    }
    const summary = it.allocationRule
      ? formatRuleSummary(it.allocationRule)
      : it.ruleSummary || (assigned !== 'split' ? assigned : 'Split equally');

    return {
      id: it.id || `item_${idx + 1}`,
      description: it.name,
      quantity: it.quantity || 1,
      amountCents: Math.round(it.price * 100),
      assignedTo: assigned,
      taxPct: Math.round(taxRate * 10000) / 10000,
      isTaxInclusive,
      allocationRule: it.allocationRule,
      ruleSummary: summary,
    };
  });

  return {
    id: tabId || `tab_${Date.now()}`,
    title: merchant || 'Receipt Tab',
    merchant: merchant || 'Receipt Store',
    date: date || new Date().toISOString().split('T')[0],
    items: items.map((it, idx) => {
      const summary = it.allocationRule
        ? formatRuleSummary(it.allocationRule)
        : it.ruleSummary;
      return {
        id: it.id || `item_${idx + 1}`,
        name: it.name,
        priceCents: Math.round(it.price * 100),
        quantity: it.quantity || 1,
        assignedTo: it.assignedTo.map((name) => {
          const pt = participants.find((p) => p.name.toLowerCase() === name.toLowerCase());
          return pt ? pt.id : name;
        }),
        category: it.category || 'general',
        isTaxInclusive,
        allocationRule: it.allocationRule,
        ruleSummary: summary,
      };
    }),
    rows,
    participants,
    subtotalCents: itemsSumCents,
    taxCents,
    taxPercentage: taxRate > 0 ? Math.round(taxRate * 10000) / 100 : 0,
    isTaxInclusive,
    taxType,
    serviceChargeCents,
    // Store discount and round-off cents separately.
    discountCents,
    roundOffCents,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    tipCents,
    tipAllocationRule,
    totalCents,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Gemini Parser Adapter
 * Uses Google Generative AI with valid production models:
 * gemini-3.5-flash-lite, gemini-3.5-flash, gemini-flash-lite-latest, gemini-flash-latest.
 * Supports multimodal image OCR, native raw audio analysis, and structured JSON extraction.
 */
/** Combines the client's abort signal (if any) with a per-call timeout. */
function signalOf(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/**
 * Parses "X, Y, and Z shared/split/took/had/got the rest" transcripts for 2+ people.
 * Returns the resolved person names in transcript order.
 */
function extractRestSharePeopleFromTranscript(
  transcript: string,
  resolveName: (raw: string) => string
): string[] {
  const m = transcript.match(
    /(?:^|[.,;]\s*|\band\s+)([a-zA-Z]+(?:\s*,\s*[a-zA-Z]+)*(?:\s*,?\s*and\s+[a-zA-Z]+))\s+(?:shared|split|took|had|got)\s+(?:the\s+)?(?:rest|remaining|others)\b/i
  );
  if (!m?.[1]) return [];
  return m[1]
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(resolveName)
    .filter((p) => p && !isGroupWord(p));
}

export class GeminiParserAdapter implements ExtractionAdapter {
  name = 'gemini-3.5-flash-lite';
  /** Set by the route so Gemini calls stop when the browser cancels the request. */
  abortSignal?: AbortSignal;

  async parse(req: ParseTabRequest, explicitApiKey?: string): Promise<ParseTabResponse> {
    const apiKey = explicitApiKey || req.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not configured.');
    }

    const hasImage = Boolean((req.image && req.image.trim().length > 0) || (req.imageBase64 && req.imageBase64.trim().length > 0));
    const hasAudio = Boolean(req.audio && req.audio.trim().length > 0);
    const hasCommand = Boolean(req.voiceTranscript && req.voiceTranscript.trim().length > 0);

    // Abort the Gemini call when there is no receipt image, audio, or split command.
    if (!hasImage && !hasAudio && !hasCommand) {
      throw new Error('No receipt image, audio recording, or split command provided. Gemini call aborted.');
    }

    const parts: any[] = [];
    const isImageScanOnly = hasImage && !hasCommand && !hasAudio;

    let promptText = '';

    if (isImageScanOnly) {
      // MODE 1: PURE RECEIPT OCR & NER (Zero Arithmetic in LLM)
      promptText = `You are a pure OCR and Named Entity Recognition (NER) model.
Your ONLY task is to read and transcribe the exact printed text and numbers from this receipt image.

ABSOLUTE RULES:
1. DO NOT DO ANY ARITHMETIC. DO NOT DIVIDE, MULTIPLY, OR SPLIT ANY NUMBERS.
2. Read the EXACT printed characters and numbers as they appear on the paper.
3. For each printed line item:
   - "name": Exact printed description (e.g. "PALAZZO SET", "IV SET MASTER Y POT")
   - "quantity": Exact printed quantity (integer, default 1)
   - "unitPrice": Exact printed unit price as decimal
   - "totalPrice": Exact printed total price for that line item as decimal
4. Printed Financial Totals (Read verbatim from the receipt):
   - "merchant": Merchant/store name
   - "date": Printed date (YYYY-MM-DD or today)
   - "subtotal": Printed subtotal or gross total before tax/discounts (or 0.00 if not printed)
   - "discount": Printed discount or adjustment (e.g. 20.00 or 0.00 if none)
   - "serviceCharge": Printed service charge, auto-gratuity, delivery, or packaging fees (0.00 if none)
   - "roundOff": Printed round off amount if any (e.g. -0.01, +0.05, or 0.00)
   - "taxAmount": Total printed tax amount (GST, VAT, Sales Tax). 0.00 if no tax printed or tax is 0.
   - "taxPercentage": Printed tax percentage (e.g. 5 for 5%, or 0 if none)
   - "taxType": Decide if tax is "inclusive" (prices already include tax, GST/VAT retail invoices), "exclusive" (tax is added on top of subtotal at the end), or "none" (no tax).
   - "tip": Printed tip (0.00 if none)
   - "netTotal": Printed Net Total / Total Payable / Amount to Pay (e.g. 1350.00, 1800.00)

Do not calculate splits or reduce prices; output raw printed values only.

Output JSON strictly:
{
  "merchant": "string",
  "date": "YYYY-MM-DD",
  "items": [
    {
      "name": "string",
      "quantity": 1,
      "unitPrice": 0.00,
      "totalPrice": 0.00
    }
  ],
  "subtotal": 0.00,
  "discount": 0.00,
  "serviceCharge": 0.00,
  "roundOff": 0.00,
  "taxAmount": 0.00,
  "taxPercentage": 0.00,
  "taxType": "inclusive" | "exclusive" | "none",
  "tip": 0.00,
  "netTotal": 0.00
}`;
    } else {
      // MODE 2: PURE VOICE / AUDIO ALLOCATION NER (Structured AllocationRule Schema)
      const sanitizedItems = (req.existingItems || []).map((i) => ({
        id: i.id,
        name: i.name || i.description || 'Item',
        quantity: i.quantity || 1,
      }));

      promptText = `You are a Semantic Parser for expense allocation. Convert the user's natural language command into structured allocation rules.
NEVER calculate prices or dollar totals.

Existing receipt items:
${JSON.stringify(sanitizedItems, null, 2)}

${req.voiceTranscript?.trim() ? `Typed Command:\n"${req.voiceTranscript.trim()}"\n` : ''}${hasAudio ? 'Spoken Command: in the attached audio recording. Listen to it and use it as the command.\n' : ''}
RULES:
1. [Who]: Extract ONLY participant names explicitly mentioned in the command.
   - CRITICAL SELF-INTRODUCTION RULE: If a speaker states their name (e.g. "My name is Ali and I took...", "I am Sara, I got...", "This is Bilal, I had..."), set "speakerName" to that person's name (e.g. "Ali") and map all of their "I"/"me"/"my" pronouns directly to their stated name ("Ali", "Sara", "Bilal"). DO NOT extract "Me" for that speaker. This also applies when multiple people speak in sequence ("I'm Ali, I got X. I'm Sara, I got Y").
   - Only normalize "I", "me", "myself" to "Me" when the speaker does NOT state their own name (and speakerName is null).
   - If "You" is typed, treat "You" as someone's name. In spoken audio recordings, ignore conversational filler addressed to the AI assistant (e.g. "Can you split...", "Could you add...") and do NOT extract "You" as a participant from spoken audio unless explicitly typed.
2. [HowMany] & [What]: For each item (or "REST" for remaining items, or "ALL" for whole bill), output an allocation rule:
   - mode: "equal" | "exclude" | "quantity" | "percentage" | "fixed"
   - shares: [{ "person": "Name", "value": number }]
     * For "percentage": value is 0-100 (e.g. "I ate 30%, Bilal 10%, rest Mohsin" -> shares: [{person:"Me", value:30}, {person:"Bilal", value:10}], remainderTo: ["Mohsin"])
     * For "quantity": value is unit count (e.g. "Ali took 2 burgers, rest shared" -> shares: [{person:"Ali", value:2}], remainderTo: ["all"])
     * For "fixed": value is dollar amount (e.g. "Ali pays $5 of pizza, rest shared" -> shares: [{person:"Ali", value:5}], remainderTo: ["all"])
     * For "equal": list the people sharing equally in shares with value: 1 (e.g. [{person:"Ali", value:1}, {person:"Bilal", value:1}])
   - excluded: ["Name"] (only when mode === "exclude", e.g. "everyone except Sara")
   - remainderTo: ["Name"] or ["all"] (who gets the remaining percentage, units, or amount)
3. Never use group words ("everyone", "all", "both", "us", "rest", "shared") as a person. For "split equally between everyone" use mode "equal" with empty shares.
4. Optional Tip & Discount Overrides:
   - If the user states a tip or discount amount, output "tipOverride" / "discountOverride" as { "amount": number, "isPercent": boolean } (e.g. "add $5 tip" -> {amount:5,isPercent:false}; "10% tip" -> {amount:10,isPercent:true}), else null.
   - If the user specifies WHO pays the tip or HOW the tip is divided (e.g. "split tip equally", "Ali pays the tip", "tip is on me", "split tip except Sara", "Ali pays 60% of tip, Sara 40%", "I pay $3 of tip, rest shared"), output "tipRule" using the exact same { "mode", "shares", "excluded", "remainderTo" } structure as an item rule. If the user does NOT mention how to divide the tip, set "tipRule": null.

Output JSON strictly:
{
  "participants": ["string"],
  "speakerName": "string | null",
  "rules": [
    {
      "itemMatch": "item_1 or item name or REST or ALL",
      "mode": "equal | exclude | quantity | percentage | fixed",
      "shares": [{ "person": "string", "value": 1 }],
      "excluded": [],
      "remainderTo": ["all"]
    }
  ],
  "tipOverride": null,
  "tipRule": null,
  "discountOverride": null
}`;
    }

    parts.push({ text: promptText });

    // Handle receipt image (base64)
    const imgData = req.image || req.imageBase64;
    if (imgData && imgData.includes('base64,')) {
      const mimeType = imgData.substring(imgData.indexOf(':') + 1, imgData.indexOf(';'));
      const base64Data = imgData.substring(imgData.indexOf('base64,') + 7);
      parts.push({
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: base64Data,
        },
      });
    }

    // Handle native audio recording (base64)
    if (req.audio && req.audio.includes('base64,')) {
      const audioMime = req.audio.substring(req.audio.indexOf(':') + 1, req.audio.indexOf(';'));
      const audioBase64 = req.audio.substring(req.audio.indexOf('base64,') + 7);
      parts.push({
        inlineData: {
          mimeType: audioMime || 'audio/webm',
          data: audioBase64,
        },
      });
    }

    // Retry primary model on a fresh connection if a request stalls before failing over to backup model.
    const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
    const perAttemptTimeoutMs = isImageScanOnly ? 11000 : hasAudio ? 8500 : 5500;

    let lastError: any = null;
    let validatedParsed: any = null;
    let badOutput = false;

    const callModel = async (model: string, callParts: any[], timeoutMs = perAttemptTimeoutMs) => {
      const signal = signalOf(this.abortSignal, timeoutMs);
      return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: callParts }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0,
            topP: 1,
          },
        }),
        signal,
      });
    };

    const acceptText = (text: string | undefined, model: string): boolean => {
      if (!text) {
        badOutput = true;
        lastError = new Error(`${model} returned no content (possibly blocked).`);
        return false;
      }
      const cleanJson = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      let parsed: any;
      try {
        parsed = JSON.parse(cleanJson);
      } catch (jsonErr: any) {
        badOutput = true;
        lastError = new Error(`Invalid JSON from ${model}: ${jsonErr.message}`);
        return false;
      }
      if (isImageScanOnly) {
        const validation = validateReceiptStructure(parsed);
        if (!validation.valid) {
          badOutput = true;
          lastError = validation.error?.startsWith('NO_ITEMS')
            ? new ParseError('No items could be read from this photo. Retake it closer, flat and well lit.', 422, 'NO_ITEMS')
            : new Error(`Validation failed on ${model}: ${validation.error}`);
          return false;
        }
        validatedParsed = parsed;
      } else {
        const voice = sanitizeVoiceOutput(parsed);
        if (!voice) {
          badOutput = true;
          lastError = new Error(`Unexpected voice output from ${model}`);
          return false;
        }
        validatedParsed = voice;
      }
      this.name = model;
      return true;
    };

    for (const model of modelsToTry) {
      try {
        const response = await callModel(model, parts);
        if (response.ok) {
          const data = await response.json();
          if (acceptText(data.candidates?.[0]?.content?.parts?.[0]?.text, model)) break;
          continue;
        }
        const errText = await response.text();
        let errData: any = null;
        try { errData = JSON.parse(errText); } catch {}
        const errMsg = errData?.error?.message || errText.slice(0, 150);
        console.warn(`[Gemini Failover] ${model} ${response.status}: ${errMsg}`);

        if (response.status === 401 || response.status === 403) {
          throw new ParseError('The Gemini API key was rejected. Check GEMINI_API_KEY in .env.local.', 401, 'BAD_API_KEY');
        }
        if (response.status === 400 || response.status === 413) {
          // The request itself is unusable (e.g. unsupported or empty recording): other models will fail too.
          throw new ParseError(
            hasAudio ? 'The recording could not be processed. Record again (at least a second) or type the command.' : `Gemini rejected the request: ${errMsg}`,
            response.status === 413 ? 413 : 422,
            'BAD_INPUT'
          );
        }
        lastError =
          response.status === 429
            ? new ParseError('Gemini usage limit reached. Wait a minute and try again.', 429, 'QUOTA')
            : new ParseError('Google AI is temporarily busy. Please try again.', 503, 'UNAVAILABLE');
      } catch (err: any) {
        if (err instanceof ParseError && err.code !== 'QUOTA' && err.code !== 'UNAVAILABLE') throw err;
        if (this.abortSignal?.aborted) throw new ParseError('Request cancelled.', 499, 'CANCELLED');
        lastError =
          err?.name === 'TimeoutError' || err?.name === 'AbortError'
            ? new ParseError('System busy! Please try again.', 504, 'TIMEOUT')
            : err;
      }
    }

    // Retry once with a hint, only when a model answered but its output was unusable.
    if (!validatedParsed && isImageScanOnly && badOutput && !(lastError instanceof ParseError)) {
      try {
        const retryParts = [
          ...parts,
          { text: `Validation warning: ${lastError?.message || 'Could not parse'}. Re-examine the image and output valid JSON with exact line items, prices, quantities, serviceCharge (0.00 if none), and 0 tax if no tax is printed.` },
        ];
        const retryResponse = await callModel(modelsToTry[0], retryParts);
        if (retryResponse.ok) {
          const rData = await retryResponse.json();
          acceptText(rData.candidates?.[0]?.content?.parts?.[0]?.text, `${modelsToTry[0]}-retry`);
        }
      } catch {}
    }

    if (!validatedParsed) {
      throw lastError || new Error('All Gemini models failed to return valid receipt content');
    }

    // ─────────────────────────────────────────────────────────────
    // BRANCH A: Pure Receipt OCR & NER (Mode 1)
    // ─────────────────────────────────────────────────────────────
    if (isImageScanOnly) {
      const items = (validatedParsed.items || []).map((item: any, idx: number) => {
        const unit = moneyOr0(item.unitPrice);
        const total = moneyOr0(item.totalPrice ?? item.price);
        const qty = moneyOr0(item.quantity) || 1;
        const finalPrice = total > 0 ? total : (unit > 0 ? unit * qty : 0);

        return {
          id: item.id || `item_${idx + 1}`,
          name: item.name || `Item ${idx + 1}`,
          price: finalPrice, // Exact printed price
          quantity: qty,
          category: (item.category as ItemCategory) || 'general',
          assignedTo: ['split'],
        };
      });

      const merchant = String(validatedParsed.merchant || 'Receipt Store').trim() || 'Receipt Store';
      const rawDate = String(validatedParsed.date || '').trim();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : rawDate && !/today/i.test(rawDate) ? rawDate : new Date().toISOString().split('T')[0];
      const parsedTax = typeof validatedParsed.taxAmount === 'number' ? validatedParsed.taxAmount : (typeof validatedParsed.tax === 'number' ? validatedParsed.tax : parseFloat(validatedParsed.tax || validatedParsed.taxAmount) || 0);
      const parsedTaxPct = typeof validatedParsed.taxPercentage === 'number' ? validatedParsed.taxPercentage : parseFloat(validatedParsed.taxPercentage) || 0;
      const parsedTaxType = validatedParsed.taxType === 'inclusive' || validatedParsed.taxType === 'exclusive' || validatedParsed.taxType === 'none' ? validatedParsed.taxType : undefined;
      const parsedDiscount = typeof validatedParsed.discount === 'number' ? validatedParsed.discount : (typeof validatedParsed.adjustment === 'number' ? validatedParsed.adjustment : parseFloat(validatedParsed.discount || validatedParsed.adjustment) || 0);
      const parsedServiceCharge = typeof validatedParsed.serviceCharge === 'number' ? validatedParsed.serviceCharge : parseFloat(validatedParsed.serviceCharge) || 0;
      const parsedRoundOff = typeof validatedParsed.roundOff === 'number' ? validatedParsed.roundOff : parseFloat(validatedParsed.roundOff) || 0;
      const parsedTip = typeof validatedParsed.tip === 'number' ? validatedParsed.tip : parseFloat(validatedParsed.tip) || 0;
      const parsedNetTotal = typeof validatedParsed.netTotal === 'number' ? validatedParsed.netTotal : (typeof validatedParsed.total === 'number' ? validatedParsed.total : parseFloat(validatedParsed.total || validatedParsed.netTotal) || 0);

      const ledger = buildLedgerFromExtracted(
        merchant,
        date,
        items,
        [],
        parsedTax,
        parsedTaxPct,
        parsedTaxType,
        parsedDiscount,
        parsedRoundOff,
        parsedTip,
        parsedNetTotal,
        parsedServiceCharge,
        req.tabId
      );

      return {
        success: true,
        merchant,
        date,
        items,
        participants: [],
        tax: ledger.taxCents / 100,
        taxPercentage: ledger.taxPercentage,
        isTaxInclusive: ledger.isTaxInclusive,
        taxType: ledger.taxType,
        discount: (ledger.discountCents || 0) / 100,
        serviceCharge: (ledger.serviceChargeCents || 0) / 100,
        roundOff: (ledger.roundOffCents || 0) / 100,
        tip: ledger.tipCents / 100,
        total: ledger.totalCents / 100,
        adapterUsed: this.name,
        confidenceScore: 0.98,
        ledger,
      };
    }

    // Branch B: Pure Voice NER allocation with immutable line item prices.
    // ─────────────────────────────────────────────────────────────
    // Case-insensitive set of participants: "Sara Khan" and "sara khan" are one person.
    const existingHostName =
      req.existingParticipants?.find((p) => p.isHost)?.name ||
      req.existingParticipants?.find((p) => /^(?:me|myself|i|host)$/i.test(p.name))?.name;

    // Detect self-introduction in the typed/spoken command ("My name is Ali", "I am Sara", ...)
    const selfIntroMatch = req.voiceTranscript?.match(/\b(?:my name is|i am|i'm|this is)\s+([a-zA-Z]+)\b/i);
    const parsedSpeaker =
      typeof validatedParsed.speakerName === 'string' &&
      validatedParsed.speakerName.trim() &&
      !isGroupWord(validatedParsed.speakerName) &&
      !/^(?:i|me|myself|null|none)$/i.test(validatedParsed.speakerName.trim())
        ? normalizePersonName(validatedParsed.speakerName.trim())
        : undefined;
    const selfName = selfIntroMatch ? normalizePersonName(selfIntroMatch[1]) : parsedSpeaker;

    const resolveSpeakerName = (raw: string): string => {
      const n = normalizePersonName(raw);
      if (n === 'Me' && selfName) {
        return selfName;
      }
      if (n === 'Me' && existingHostName && existingHostName.trim()) {
        return existingHostName.trim();
      }
      return n;
    };

    const participantMap = new Map<string, string>();
    const participantsSet = {
      add(name: string) {
        const n = resolveSpeakerName(name);
        if (n && !isGroupWord(n) && !participantMap.has(n.toLowerCase())) participantMap.set(n.toLowerCase(), n);
      },
      delete(name: string) {
        participantMap.delete(name.toLowerCase());
      },
      get size() {
        return participantMap.size;
      },
    };
    (validatedParsed.participants as string[]).forEach((p) => participantsSet.add(p));

    // Group words in shares ("everyone") mean "split among everyone", not a person.
    const rulesList: any[] = (validatedParsed.rules as any[]).map((rule) => {
      const shares = rule.shares.filter((s: any) => !isGroupWord(s.person));
      const groupOnly = rule.shares.length > 0 && shares.length === 0;
      return {
        ...rule,
        shares: groupOnly && rule.mode === 'equal' ? [] : shares,
        excluded: rule.excluded.filter((e: string) => !isGroupWord(e)),
        remainderTo: rule.remainderTo.map((r: string) => (isGroupWord(r) ? 'all' : r)),
      };
    });

    // Determine "shared the rest" people from:
    // 1. An explicit REST rule in rulesList,
    // 2. Named people placed in any rule's remainderTo by Gemini, or
    // 3. Explicit "X and Y shared/split the rest" in voiceTranscript.
    let activeRestRule = rulesList.find((r) => REST_MATCH_RE.test(String(r.itemMatch || '').trim()));
    let restPeople: string[] =
      activeRestRule && activeRestRule.mode === 'equal' && Array.isArray(activeRestRule.shares) && activeRestRule.shares.length > 0
        ? activeRestRule.shares.map((s: any) => resolveSpeakerName(s.person)).filter((p: string) => p && !isGroupWord(p))
        : [];

    if (restPeople.length === 0) {
      const ruleWithNamedRemainder = rulesList.find(
        (r) => Array.isArray(r.remainderTo) && r.remainderTo.some((p: string) => p && p !== 'all' && !isGroupWord(p))
      );
      if (ruleWithNamedRemainder) {
        restPeople = ruleWithNamedRemainder.remainderTo
          .filter((p: string) => p && p !== 'all' && !isGroupWord(p))
          .map((p: string) => resolveSpeakerName(p));
      }
    }

    if (restPeople.length === 0 && req.voiceTranscript) {
      restPeople = extractRestSharePeopleFromTranscript(req.voiceTranscript, resolveSpeakerName);
    }

    // If Gemini didn't emit a standalone REST rule for the other receipt items, synthesize one
    // whenever the user specified who shared "the rest".
    if (!activeRestRule && restPeople.length > 0) {
      activeRestRule = {
        itemMatch: 'REST',
        mode: 'equal',
        shares: restPeople.map((person) => ({ person, value: 1 })),
        excluded: [],
        remainderTo: [],
      };
      rulesList.push(activeRestRule);
    }

    for (const rule of rulesList) {
      for (const s of rule.shares) participantsSet.add(s.person);
      for (const e of rule.excluded) participantsSet.add(e);
      for (const r of rule.remainderTo) if (r !== 'all') participantsSet.add(r);
    }

    let parsedTipAllocationRule: AllocationRule | undefined = undefined;
    if (validatedParsed.tipRule && validatedParsed.tipRule.mode) {
      const tr = validatedParsed.tipRule;
      const tShares: AllocationShare[] = (tr.shares || [])
        .filter((s: any) => !isGroupWord(s.person))
        .map((s: any) => ({
          person: resolveSpeakerName(s.person),
          value: typeof s.value === 'number' ? s.value : parseFloat(s.value) || 0,
        }));
      const tExcluded = (tr.excluded || [])
        .filter((e: string) => !isGroupWord(e))
        .map((e: string) => resolveSpeakerName(e));
      const tRemainder = (tr.remainderTo || []).map((r: string) =>
        isGroupWord(r) || r === 'all' ? 'all' : resolveSpeakerName(r)
      );

      for (const s of tShares) participantsSet.add(s.person);
      for (const e of tExcluded) participantsSet.add(e);
      for (const r of tRemainder) if (r !== 'all') participantsSet.add(r);

      parsedTipAllocationRule = {
        mode: tr.mode as AllocationMode,
        shares: tShares,
        ...(tExcluded.length > 0 ? { excluded: tExcluded } : {}),
        ...(tRemainder.length > 0 ? { remainderTo: tRemainder } : {}),
      };
    }

    const isYouExplicitlyTyped = Boolean(
      (req.voiceTranscript && /\byou\b/i.test(req.voiceTranscript)) ||
      (req.existingParticipants && req.existingParticipants.some((p) => /^you$/i.test(p.name)))
    );

    if (!isYouExplicitlyTyped && req.audio) {
      participantsSet.delete('You');
      participantsSet.delete('you');
    }

    // Single-recording model: all participants come directly from this recording/command.

    if (participantsSet.size === 0) {
      (req.existingParticipants || []).forEach((p) => p?.name && participantsSet.add(p.name));
    }

    if (participantsSet.size === 0) {
      participantsSet.add('Me');
    }

    const participantsList = Array.from(participantMap.values());

    const existing = req.existingItems || [];
    const sanitizedExistingForMatch = existing.map((orig, idx) => ({
      id: orig.id || `item_${idx + 1}`,
      name: (orig.name || orig.description || 'Item')
        .replace(/\s*\(\d+x\)$/i, '')
        .replace(/\s*\(\d+\s+of\s+\d+\)$/i, '')
        .trim(),
      quantity: orig.quantity || 1,
    }));
    const processedItems: {
      id: string;
      name: string;
      price: number;
      quantity: number;
      category?: ItemCategory;
      assignedTo: string[];
      allocationRule?: AllocationRule;
      ruleSummary?: string;
    }[] = [];

    for (const orig of existing) {
      const origId = orig.id || '';
      const rawName = orig.name || orig.description || 'Item';
      const cleanName = rawName.replace(/\s*\(\d+x\)$/i, '').replace(/\s*\(\d+\s+of\s+\d+\)$/i, '').trim();
      const origPrice = orig.amountCents ? orig.amountCents / 100 : (orig.price || 0);
      const origQty = orig.quantity || 1;

      const matched = findMatchingRule(
        { id: origId, name: cleanName, quantity: origQty },
        rulesList,
        sanitizedExistingForMatch
      );

      if (matched && matched.mode) {
        let mode = matched.mode as AllocationMode;
        const shares: AllocationShare[] = (matched.shares || []).map((s: any) => ({
          person: resolveSpeakerName(s.person),
          value: typeof s.value === 'number' ? s.value : parseFloat(s.value) || 0,
        }));
        const excluded = (matched.excluded || []).map((e: string) => resolveSpeakerName(e));
        let remainderTo = (matched.remainderTo || []).map((r: string) =>
          r === 'all' ? 'all' : resolveSpeakerName(r)
        );

        // If Gemini returned mode "equal" on a multi-quantity item where a partial count was claimed
        // and a remainder group exists, treat it as a quantity split.
        const isRestRule = REST_MATCH_RE.test(String(matched.itemMatch || '').trim());
        const claimedSum = shares.reduce((s, sh) => s + (sh.value || 0), 0);
        if (
          !isRestRule &&
          mode === 'equal' &&
          origQty > 1 &&
          shares.length > 0 &&
          claimedSum < origQty &&
          remainderTo.length > 0
        ) {
          mode = 'quantity';
        }

        // Unclaimed units/cents of a quantity / percentage / fixed item go to the people who
        // "shared the rest" (e.g. Bilal and Ali) whenever remainderTo is empty or "all".
        if (
          (mode === 'quantity' || mode === 'percentage' || mode === 'fixed') &&
          (remainderTo.length === 0 || remainderTo.includes('all')) &&
          restPeople.length > 0
        ) {
          remainderTo = [...restPeople];
        }

        // Clear remainderTo if 100% of the item's quantity, percentage, or price is already claimed!
        if (mode === 'quantity' && claimedSum >= origQty) {
          remainderTo = [];
        } else if (mode === 'percentage' && claimedSum >= 100) {
          remainderTo = [];
        } else if (mode === 'fixed' && claimedSum >= origPrice - 0.005) {
          remainderTo = [];
        }

        // If a single person got the entire item in 'equal' mode, show explicit unit count e.g. "Ali (1x)"
        if (!isRestRule && mode === 'equal' && shares.length === 1 && remainderTo.length === 0) {
          mode = 'quantity';
          shares[0].value = origQty;
        }

        // For quantity splits with remaining units (e.g. 2x item, Sara took 1x, Bilal & Ali shared the rest),
        // expand the remaining units into explicit fractional shares (e.g. Bilal (0.5x) · Ali (0.5x)).
        if (mode === 'quantity' && claimedSum > 0 && claimedSum < origQty && remainderTo.length > 0) {
          const remQty = origQty - claimedSum;
          const remTargets = remainderTo.includes('all') ? participantsList : remainderTo;
          if (remTargets.length > 0) {
            const addPerPerson = Math.round((remQty / remTargets.length) * 100) / 100;
            for (const personName of remTargets) {
              const existingShare = shares.find(
                (s) => s.person.toLowerCase() === personName.toLowerCase()
              );
              if (existingShare) {
                existingShare.value = Math.round((existingShare.value + addPerPerson) * 100) / 100;
              } else {
                shares.push({ person: personName, value: addPerPerson });
              }
            }
            remainderTo = [];
          }
        }

        const allocationRule: AllocationRule = {
          mode,
          shares,
          ...(excluded.length > 0 ? { excluded } : {}),
          ...(remainderTo.length > 0 ? { remainderTo } : {}),
        };

        const ruleSummary = formatRuleSummary(allocationRule);

        let assignedTo = ['split'];
        if (mode === 'equal' && shares.length === 1) {
          assignedTo = [shares[0].person];
        } else if (mode === 'equal' && shares.length > 1) {
          assignedTo = shares.map((s) => s.person);
        }

        processedItems.push({
          id: origId,
          name: cleanName,
          price: origPrice, // IMMUTABLE original line item price
          quantity: origQty, // IMMUTABLE original quantity
          category: orig.category || 'general',
          assignedTo,
          allocationRule,
          ruleSummary,
        });
      } else {
        const existingRule = orig.allocationRule;
        const assigned = typeof orig.assignedTo === 'string' && orig.assignedTo && orig.assignedTo !== 'split' ? orig.assignedTo : 'split';
        const ruleSummary = existingRule
          ? formatRuleSummary(existingRule)
          : (assigned !== 'split' ? assigned : 'Split equally');

        processedItems.push({
          id: origId,
          name: cleanName,
          price: origPrice,
          quantity: origQty,
          category: orig.category || 'general',
          assignedTo: [assigned],
          allocationRule: existingRule,
          ruleSummary,
        });
      }
    }

    const merchant = req.merchant || 'Receipt Store';
    const date = req.date || new Date().toISOString().split('T')[0];
    const tax = req.taxCents !== undefined ? req.taxCents / 100 : 0;
    const taxPct = req.taxPercentage !== undefined ? req.taxPercentage : 0;
    const declaredTaxType = req.taxType || (req.isTaxInclusive ? 'inclusive' : undefined);
    let discount = req.discountCents !== undefined ? req.discountCents / 100 : 0;
    let tip = req.tipCents !== undefined ? req.tipCents / 100 : 0;
    const serviceCharge = req.serviceChargeCents !== undefined ? req.serviceChargeCents / 100 : 0;
    const roundOff = req.roundOffCents !== undefined ? req.roundOffCents / 100 : 0;
    const total = req.totalCents !== undefined ? req.totalCents / 100 : 0;

    // Optional voice overrides: { amount, isPercent } (a plain number is read as dollars).
    // Percentages are of the item subtotal. A spoken discount adds to the printed one.
    const itemsTotal = processedItems.reduce((s, it) => s + (it.price || 0), 0);
    const readOverride = (o: any): number | null => {
      if (typeof o === 'number') return o >= 0 ? o : null;
      if (o && typeof o === 'object') {
        const amount = moneyOr0(o.amount);
        if (amount < 0) return null;
        return o.isPercent ? Math.round(itemsTotal * amount) / 100 : amount;
      }
      return null;
    };
    const discountOverride = readOverride(validatedParsed.discountOverride);
    const tipOverride = readOverride(validatedParsed.tipOverride);
    if (discountOverride !== null && discountOverride > 0) discount += discountOverride;
    if (tipOverride !== null) {
      tip = tipOverride;
    } else if (
      parsedTipAllocationRule?.mode === 'fixed' &&
      parsedTipAllocationRule.shares.length > 0 &&
      (!parsedTipAllocationRule.remainderTo || parsedTipAllocationRule.remainderTo.length === 0)
    ) {
      const sumFixedTip = parsedTipAllocationRule.shares.reduce((s: number, sh: any) => s + (sh.value || 0), 0);
      if (sumFixedTip > 0) tip = sumFixedTip;
    }

    const finalTipRule =
      tip > 0 ? parsedTipAllocationRule ?? req.tipAllocationRule : parsedTipAllocationRule;

    const ledger = buildLedgerFromExtracted(
      merchant,
      date,
      processedItems,
      participantsList,
      tax,
      taxPct,
      declaredTaxType,
      discount,
      roundOff,
      tip,
      total,
      serviceCharge,
      req.tabId,
      true,
      finalTipRule
    );

    if (req.payeeEmail) {
      ledger.payeeEmail = req.payeeEmail;
    }

    return {
      success: true,
      merchant,
      date,
      items: processedItems,
      participants: participantsList,
      tax: ledger.taxCents / 100,
      taxPercentage: ledger.taxPercentage,
      isTaxInclusive: ledger.isTaxInclusive,
      taxType: ledger.taxType,
      discount: (ledger.discountCents || 0) / 100,
      serviceCharge: (ledger.serviceChargeCents || 0) / 100,
      roundOff: (ledger.roundOffCents || 0) / 100,
      tip: ledger.tipCents / 100,
      total: ledger.totalCents / 100,
      transcriptUsed: req.voiceTranscript,
      adapterUsed: this.name,
      confidenceScore: 0.98,
      ledger,
    };
  }
}

/**
 * Local Keyword & Heuristic Fallback Adapter
 * Guarantees offline resilience, zero-key development, and deterministic voice assignment.
 * NEVER inserts hardcoded items if none were extracted or provided.
 */
export class LocalKeywordFallbackAdapter implements ExtractionAdapter {
  name = 'local-heuristic-fallback';

  async parse(req: ParseTabRequest): Promise<ParseTabResponse> {
    if (!req.existingItems || req.existingItems.length === 0) {
      return {
        success: false,
        merchant: 'Receipt',
        date: new Date().toISOString().split('T')[0],
        items: [],
        participants: [],
        tax: 0,
        tip: 0,
        total: 0,
        adapterUsed: 'local-fallback',
        confidenceScore: 0,
        message: 'No items could be extracted. Please check your image or internet connection.',
      };
    }

    const transcript = req.voiceTranscript || '';

    // 1. Detect speaker self-introduction ("My name is Ali", "I am Sara", "This is Bilal")
    const introMatch = transcript.match(/\b(?:my name is|i am|i'm|this is)\s+([a-zA-Z]+)\b/i);
    const speakerSelfName = introMatch ? normalizePersonName(introMatch[1]) : 'Me';
    const resolveName = (raw: string): string => {
      const n = normalizePersonName(raw);
      return n === 'Me' ? speakerSelfName : n;
    };

    const participantsSet = new Set<string>();
    if (req.existingParticipants && req.existingParticipants.length > 0) {
      req.existingParticipants.forEach((p) => {
        const nm = normalizePersonName(p.name);
        if (nm === 'Me' && speakerSelfName !== 'Me') {
          participantsSet.add(speakerSelfName);
        } else {
          participantsSet.add(nm);
        }
      });
    }
    if (introMatch) {
      participantsSet.add(speakerSelfName);
    }

    // 2. Detect quantity splits (e.g., "Sara took 1 Organic Cold Brew")
    const qtyRegex = /\b([a-zA-Z]+)\s+(?:had|ate|drank|got|ordered|took|ne)\s+(\d+)\s+([a-zA-Z0-9\s]+?)(?=\s*,|\s*\.|\s+and\s+|$)/gi;
    let qm;
    const qtySplits: { person: string; count: number; targetItem: string }[] = [];
    while ((qm = qtyRegex.exec(transcript)) !== null) {
      const personName = resolveName(qm[1]);
      if (isGroupWord(personName)) continue;
      const count = parseInt(qm[2], 10);
      const targetItem = qm[3].trim().toLowerCase();
      participantsSet.add(personName);
      qtySplits.push({ person: personName, count, targetItem });
    }

    // 3. Detect individual item claims (e.g., "I got the Artisan Pizza Pack")
    const actionRegex = /\b([a-zA-Z]+)\s+(?:ate|had|got|ordered|took|has|eat|eating|drank|pi|khaya|ne)\s+(?:all\s+|the\s+|an?\s+)?([a-zA-Z0-9\s&]+?)(?=\s+[a-zA-Z]+\s+(?:ate|had|got|ordered|took|has|eat|eating|drank|pi|khaya|ne)|\s+and\s+|\s*,|\s*\.|$)/gi;
    let actionMatch;
    const voicePairs: { person: string; target: string }[] = [];
    while ((actionMatch = actionRegex.exec(transcript)) !== null) {
      const personName = resolveName(actionMatch[1]);
      if (isGroupWord(personName)) continue;
      const targetItem = actionMatch[2].trim().toLowerCase();
      if (/^\d+\s+/.test(targetItem)) continue; // already handled by qtyRegex
      participantsSet.add(personName);
      voicePairs.push({ person: personName, target: targetItem });
    }

    // 4. Detect shared remainder ("Bilal, Zaid, and I shared the rest")
    const restSharePeople = extractRestSharePeopleFromTranscript(transcript, resolveName);
    for (const p of restSharePeople) participantsSet.add(p);

    if (participantsSet.size === 0) {
      participantsSet.add(speakerSelfName);
    }
    const participants = Array.from(participantsSet);

    const rawItems = req.existingItems.map((it, idx) => ({
      id: it.id || `item_${idx + 1}`,
      name: it.description || it.name || `Item ${idx + 1}`,
      price: (it.amountCents ? it.amountCents / 100 : it.price) || 0,
      quantity: it.quantity || 1,
      category: (it.category as ItemCategory) || 'food',
      assignedTo: it.assignedTo && it.assignedTo !== 'split' ? [it.assignedTo] : ['split'],
      allocationRule: it.allocationRule,
      ruleSummary: it.allocationRule ? formatRuleSummary(it.allocationRule) : undefined,
      matchedInTurn: false,
    }));

    const matchesTarget = (itemName: string, target: string) => {
      const n = itemName.toLowerCase();
      const t = target.toLowerCase();
      return n.includes(t) || t.includes(n) || t.split(/\s+/).some((w) => w.length > 3 && n.includes(w));
    };

    for (const it of rawItems) {
      const splitsForItem = qtySplits.filter((s) => matchesTarget(it.name, s.targetItem));
      if (splitsForItem.length > 0) {
        const shares: AllocationShare[] = splitsForItem.map((s) => ({
          person: s.person,
          value: s.count,
        }));
        const rule: AllocationRule = {
          mode: 'quantity',
          shares,
          remainderTo: restSharePeople && restSharePeople.length > 0 ? restSharePeople : ['all'],
        };
        it.allocationRule = rule;
        it.ruleSummary = formatRuleSummary(rule);
        it.matchedInTurn = true;
      }
    }

    for (const pair of voicePairs) {
      for (const item of rawItems) {
        if (item.matchedInTurn) continue;
        if (matchesTarget(item.name, pair.target)) {
          const rule: AllocationRule = {
            mode: 'equal',
            shares: [{ person: pair.person, value: 1 }],
          };
          item.assignedTo = [pair.person];
          item.allocationRule = rule;
          item.ruleSummary = pair.person;
          item.matchedInTurn = true;
        }
      }
    }

    if (restSharePeople && restSharePeople.length > 0) {
      for (const item of rawItems) {
        if (item.matchedInTurn) continue;
        const rule: AllocationRule = {
          mode: 'equal',
          shares: restSharePeople.map((p) => ({ person: p, value: 1 })),
        };
        item.assignedTo = [...restSharePeople];
        item.allocationRule = rule;
        item.ruleSummary = formatRuleSummary(rule);
      }
    }

    const processedItems = rawItems.map(({ matchedInTurn, ...rest }) => rest);

    // 5. Optional Tip & Discount extraction from transcript
    const subtotal = processedItems.reduce((acc, it) => acc + it.price, 0);
    const tax = req.taxCents !== undefined ? req.taxCents / 100 : 0.0;
    const taxPct = req.taxPercentage !== undefined ? req.taxPercentage : 0;
    const declaredTaxType = req.taxType || (req.isTaxInclusive ? 'inclusive' : undefined);
    let discount = req.discountCents !== undefined ? req.discountCents / 100 : 0;
    const serviceCharge = req.serviceChargeCents !== undefined ? req.serviceChargeCents / 100 : 0;
    const roundOff = req.roundOffCents !== undefined ? req.roundOffCents / 100 : 0;
    let tip = req.tipCents !== undefined ? req.tipCents / 100 : 0.0;
    let tipAllocationRule = req.tipAllocationRule;

    const tipMatch = transcript.match(/\$?\s*(\d+(?:\.\d{1,2})?)\s*tip\b|\btip\s*(?:of\s*)?\$?\s*(\d+(?:\.\d{1,2})?)/i);
    if (tipMatch) {
      const parsedTip = parseFloat(tipMatch[1] || tipMatch[2]);
      if (Number.isFinite(parsedTip) && parsedTip >= 0) {
        tip = parsedTip;
        if (/split\s+equally|shared\s+equally/i.test(transcript)) {
          tipAllocationRule = { mode: 'equal', shares: [] };
        } else if (/tip\s+(?:is\s+)?on\s+me/i.test(transcript)) {
          tipAllocationRule = { mode: 'equal', shares: [{ person: speakerSelfName, value: 1 }] };
        }
      }
    }

    const discountMatch = transcript.match(/\$?\s*(\d+(?:\.\d{1,2})?)\s*discount\b|\bdiscount\s*(?:of\s*)?\$?\s*(\d+(?:\.\d{1,2})?)/i);
    if (discountMatch) {
      const parsedDisc = parseFloat(discountMatch[1] || discountMatch[2]);
      if (Number.isFinite(parsedDisc) && parsedDisc > 0) {
        discount += parsedDisc;
      }
    }

    const total = req.totalCents !== undefined ? req.totalCents / 100 : Math.round((subtotal + tax + tip) * 100) / 100;

    const ledger = buildLedgerFromExtracted(
      req.merchant || 'Receipt Tab',
      req.date || new Date().toISOString().split('T')[0],
      processedItems,
      participants,
      tax,
      taxPct,
      declaredTaxType,
      discount,
      roundOff,
      tip,
      total,
      serviceCharge,
      req.tabId,
      true,
      tipAllocationRule
    );

    return {
      success: true,
      merchant: ledger.merchant,
      date: ledger.date,
      items: processedItems,
      participants,
      tax: ledger.taxCents / 100,
      taxPercentage: ledger.taxPercentage,
      isTaxInclusive: ledger.isTaxInclusive,
      taxType: ledger.taxType,
      discount: (ledger.discountCents || 0) / 100,
      serviceCharge: (ledger.serviceChargeCents || 0) / 100,
      roundOff: (ledger.roundOffCents || 0) / 100,
      tip: ledger.tipCents / 100,
      total: ledger.totalCents / 100,
      transcriptUsed: req.voiceTranscript || 'Voice split instruction',
      adapterUsed: 'local-heuristic-fallback',
      confidenceScore: 0.95,
      ledger,
    };
  }
}

/**
 * POST handler for receipt parsing requests.
 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { success: false, error: 'TOO_LARGE', message: 'The photo or recording is too large. Use a smaller photo or a shorter recording.' },
        { status: 413 }
      );
    }
    let body: ParseTabRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'BAD_REQUEST', message: 'Request body must be JSON.' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'BAD_REQUEST', message: 'Request body must be a JSON object.' }, { status: 400 });
    }

    // Normalize image property
    if (!body.image && body.imageBase64) {
      body.image = body.imageBase64;
    }

    const headerKey = request.headers.get('x-gemini-api-key') || undefined;
    const apiKey = headerKey || body.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

    // Check if there is an actual receipt, audio, or command provided
    const hasImage = Boolean((body.image && body.image.trim().length > 0) || (body.imageBase64 && body.imageBase64.trim().length > 0));
    const hasAudio = Boolean(body.audio && body.audio.trim().length > 0);
    const hasCommand = Boolean(body.voiceTranscript && body.voiceTranscript.trim().length > 0);

    // Abort the Gemini call when there is no receipt image, audio, or split command.
    if (!hasImage && !hasAudio && !hasCommand) {
      if (body.existingItems && body.existingItems.length > 0) {
        const fallbackAdapter = new LocalKeywordFallbackAdapter();
        const fallbackResult = await fallbackAdapter.parse(body);
        return NextResponse.json(fallbackResult);
      }
      return NextResponse.json(
        {
          success: false,
          error: 'NO_INPUT',
          message: 'No receipt image, audio recording, or split command provided. Gemini was not called.',
        },
        { status: 400 }
      );
    }

    // The keyword fallback can only read a typed command; it cannot listen to audio or read photos.
    const canUseFallback = hasCommand && !hasImage && Boolean(body.existingItems && body.existingItems.length > 0);
    const runFallback = async (reason: string) => {
      const fallbackResult = await new LocalKeywordFallbackAdapter().parse(body);
      return NextResponse.json({ ...fallbackResult, fallbackReason: reason, confidenceScore: 0.5 });
    };

    if (!apiKey) {
      if (canUseFallback) return runFallback('Gemini is not configured; used simple keyword matching.');
      return NextResponse.json(
        { success: false, error: 'NO_API_KEY', message: 'GEMINI_API_KEY is not set in .env.local, so receipts and recordings cannot be read.' },
        { status: 503 }
      );
    }

    try {
      const geminiAdapter = new GeminiParserAdapter();
      geminiAdapter.abortSignal = request.signal;
      const result = await geminiAdapter.parse(body, apiKey);
      return NextResponse.json(result);
    } catch (geminiError: any) {
      console.warn('Gemini extraction error:', geminiError?.message || geminiError);
      if (canUseFallback && !(geminiError instanceof ParseError && geminiError.code === 'CANCELLED')) {
        return runFallback(`Gemini failed (${geminiError?.message || 'error'}); used simple keyword matching.`);
      }
      const status = geminiError instanceof ParseError ? geminiError.status : 502;
      const headers: Record<string, string> = status === 429 ? { 'Retry-After': '60' } : {};
      return NextResponse.json(
        {
          success: false,
          error: geminiError instanceof ParseError ? geminiError.code : 'EXTRACTION_FAILED',
          message: geminiError?.message || (hasImage ? 'Could not read the receipt.' : 'Could not understand the command.'),
        },
        { status, headers }
      );
    }
  } catch (error: any) {
    console.error('Parse Tab Route Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to process receipt',
      },
      { status: 500 }
    );
  }
}
