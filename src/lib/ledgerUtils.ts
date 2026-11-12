/**
 * @file ledgerUtils.ts
 * @description Single deterministic math engine for the entire app (used by both StepAssign
 * and StepSettle), evaluating all 6 allocation factors in integer cents with Largest Remainder rounding.
 */

import { TabLedger, LedgerRow, ReceiptItem, AllocationRule } from '@/types/tab';

/* ──────────────────────────────────────────────────────────
   LedgerRow <-> ReceiptItem bridge
   ────────────────────────────────────────────────────────── */

/**
 * Derives a grid-friendly LedgerRow projection from a ReceiptItem.
 */
export function itemToRow(item: ReceiptItem, ledger: TabLedger, globalTaxRate: number): LedgerRow {
  let assignedName = 'split';
  if (item.assignedTo.length === 1) {
    const participant = ledger.participants.find((p) => p.id === item.assignedTo[0]);
    if (participant) assignedName = participant.name;
  }

  return {
    id: item.id,
    description: item.name,
    quantity: item.quantity || 1,
    amountCents: item.priceCents,
    assignedTo: assignedName,
    taxPct: globalTaxRate,
    isTaxInclusive: ledger.isTaxInclusive,
    allocationRule: item.allocationRule,
    ruleSummary: item.ruleSummary,
  };
}

/**
 * Builds the full LedgerRow[] from a TabLedger.
 */
export function buildRows(ledger: TabLedger): LedgerRow[] {
  const taxRate = ledger.subtotalCents > 0 ? ledger.taxCents / ledger.subtotalCents : 0;
  return ledger.items.map((item) => itemToRow(item, ledger, taxRate));
}

/**
 * Ensures a TabLedger always has a populated rows[] array.
 */
export function ensureRows(ledger: TabLedger): TabLedger {
  if (ledger.rows && ledger.rows.length > 0) return ledger;
  return { ...ledger, rows: buildRows(ledger) };
}

/** Ledger format written by this app. v2: `discountCents` no longer includes the round-off. */
export const LEDGER_SCHEMA_VERSION = 2;

/**
 * Grand total from the ledger's parts, with the same formula as the parse-tab route:
 * items − discount + service charge + round-off (never below 0), plus exclusive tax and tip.
 * This is exactly what computeSplit hands out, so the split always matches it.
 */
export function computeLedgerTotalCents(ledger: TabLedger): number {
  const itemsCents = (ledger.rows || []).reduce((sum, r) => sum + Math.max(0, Number(r.amountCents) || 0), 0);
  const netCents = Math.max(
    0,
    itemsCents - (ledger.discountCents || 0) + (ledger.serviceChargeCents || 0) + (ledger.roundOffCents || 0)
  );
  const taxCents = ledger.isTaxInclusive ? 0 : ledger.taxCents || 0;
  return netCents + taxCents + (ledger.tipCents || 0);
}

/**
 * Ensures a stored or shared ledger has populated rows[] and current schema version.
 */
export function normalizeLedger(ledger: TabLedger): TabLedger {
  const withRows = ensureRows(ledger);
  if ((withRows.schemaVersion ?? 1) >= LEDGER_SCHEMA_VERSION) return withRows;

  const upgraded: TabLedger = { ...withRows, schemaVersion: LEDGER_SCHEMA_VERSION };
  const roundOffCents = upgraded.roundOffCents || 0;
  if (roundOffCents !== 0) {
    upgraded.discountCents = Math.max(0, (upgraded.discountCents || 0) + roundOffCents);
    upgraded.totalCents = computeLedgerTotalCents(upgraded);
  }
  return upgraded;
}

/** The rows with every assignment removed: the starting point whenever a voice command is (re)applied. */
export function toUnassignedRows(rows: LedgerRow[]): LedgerRow[] {
  return rows.map((row) => ({
    ...row,
    assignedTo: 'split',
    allocationRule: undefined,
    ruleSummary: 'Split equally',
  }));
}

/** Scrubs removed participants from item and tip rules so deleted names never leave ghost badges. */
export function scrubRemovedParticipants(ledger: TabLedger, activeNames: string[]): TabLedger {
  const activeSet = new Set(activeNames.map((n) => n.trim().toLowerCase()));
  const cleanRule = (rule?: AllocationRule): AllocationRule | undefined => {
    if (!rule) return undefined;
    const shares = (rule.shares || []).filter((s) => activeSet.has(s.person.trim().toLowerCase()));
    const excluded = (rule.excluded || []).filter((e) => activeSet.has(e.trim().toLowerCase()));
    const remainderTo = (rule.remainderTo || []).filter(
      (r) => r === 'all' || activeSet.has(r.trim().toLowerCase())
    );
    if (shares.length === 0 && excluded.length === 0) return undefined;
    return { ...rule, shares, excluded, remainderTo: remainderTo.length ? remainderTo : ['all'] };
  };

  const rows = (ledger.rows || []).map((r) => {
    const nextRule = cleanRule(r.allocationRule);
    const nextAssigned =
      r.assignedTo && r.assignedTo !== 'split' && activeSet.has(r.assignedTo.trim().toLowerCase())
        ? r.assignedTo
        : nextRule?.mode === 'equal' && nextRule.shares.length === 1
        ? nextRule.shares[0].person
        : 'split';
    return {
      ...r,
      assignedTo: nextAssigned,
      allocationRule: nextRule,
      ruleSummary: nextRule ? formatRuleSummary(nextRule) : nextAssigned !== 'split' ? nextAssigned : 'Split equally',
    };
  });
  return { ...ledger, rows, tipAllocationRule: cleanRule(ledger.tipAllocationRule) };
}

/**
 * Returns true if the participant name represents the current user / host (e.g. 'me', 'myself', 'i', 'host').
 * 'You' is the name of another participant/friend (not self).
 */
export function isSelfParticipant(name: string): boolean {
  return /^(?:me|myself|i|host)$/i.test((name || '').trim());
}

/**
 * Renames a participant (specifically the host/speaker) across all participants,
 * rows, items, allocation rules, and summaries in a TabLedger.
 */
export function renameParticipantInLedger(
  ledger: TabLedger,
  oldName: string,
  newName: string
): TabLedger {
  const fromClean = (oldName || '').trim();
  const toClean = (newName || '').trim();
  if (!fromClean || !toClean || fromClean.toLowerCase() === toClean.toLowerCase()) {
    return ledger;
  }

  const matchesOld = (val: string) => (val || '').trim().toLowerCase() === fromClean.toLowerCase();
  const newId = `p_${toClean.toLowerCase().replace(/\s+/g, '_')}`;

  const renameRule = (rule?: AllocationRule): AllocationRule | undefined => {
    if (!rule) return undefined;
    return {
      ...rule,
      shares: (rule.shares || []).map((s) =>
        matchesOld(s.person) ? { ...s, person: toClean } : s
      ),
      excluded: rule.excluded?.map((e) => (matchesOld(e) ? toClean : e)),
      remainderTo: rule.remainderTo?.map((r) => (matchesOld(r) ? toClean : r)),
    };
  };

  const participants = (ledger.participants || []).map((p) =>
    matchesOld(p.name) ? { ...p, id: newId, name: toClean, isHost: true } : p
  );

  const rows = (ledger.rows || []).map((r) => {
    const nextRule = renameRule(r.allocationRule);
    let nextAssigned = r.assignedTo;
    if (r.assignedTo && r.assignedTo !== 'split') {
      nextAssigned = r.assignedTo
        .split(',')
        .map((part) => (matchesOld(part) ? toClean : part.trim()))
        .join(', ');
    }
    return {
      ...r,
      assignedTo: nextAssigned,
      allocationRule: nextRule,
      ruleSummary: nextRule
        ? formatRuleSummary(nextRule)
        : nextAssigned !== 'split'
        ? nextAssigned
        : 'Split equally',
    };
  });

  const items = (ledger.items || []).map((it) => {
    const nextRule = renameRule(it.allocationRule);
    return {
      ...it,
      assignedTo: (it.assignedTo || []).map((a) => (matchesOld(a) ? newId : a)),
      allocationRule: nextRule,
      ruleSummary: nextRule ? formatRuleSummary(nextRule) : it.ruleSummary,
    };
  });

  return {
    ...ledger,
    participants,
    rows,
    items,
    tipAllocationRule: renameRule(ledger.tipAllocationRule),
    updatedAt: Date.now(),
  };
}

/* ──────────────────────────────────────────────────────────
   Structured Allocation & Split Results
   ────────────────────────────────────────────────────────── */

export interface SplitResult {
  participantName: string;
  foodCents: number;
  discountCents: number;
  serviceChargeCents: number;
  taxCents: number;
  tipCents: number;
  amountCents: number;
  taxRatePct: number;
  items: { description: string; qty: number; qtyLabel?: string; amountCents: number; ruleSummary?: string }[];
}

/**
 * Resolves a participant name against the participants list (case-insensitive).
 */
function resolvePerson(name: string, participants: string[]): string | undefined {
  const clean = name.trim().toLowerCase();
  return participants.find((p) => p.trim().toLowerCase() === clean);
}

/**
 * Formats a clean human-readable badge summary of an allocation rule.
 * E.g., "Me 30% · Bilal 10% · Rest: Mohsin" or "Ali (2x) · Rest: Shared" or "All except Sara".
 */
export function formatRuleSummary(rule: AllocationRule): string {
  if (!rule) return 'Split equally';

  switch (rule.mode) {
    case 'percentage': {
      const parts = (rule.shares || []).map((s) => `${s.person} ${s.value}%`);
      if (rule.remainderTo && rule.remainderTo.length > 0) {
        const rem = rule.remainderTo.includes('all') ? 'Shared' : rule.remainderTo.join(', ');
        parts.push(`Rest: ${rem}`);
      }
      return parts.join(' · ') || 'Percentage split';
    }
    case 'quantity': {
      const parts = (rule.shares || []).map((s) => `${s.person} (${s.value}x)`);
      if (rule.remainderTo && rule.remainderTo.length > 0) {
        const rem = rule.remainderTo.includes('all') ? 'Shared' : rule.remainderTo.join(', ');
        parts.push(`Rest: ${rem}`);
      }
      return parts.join(' · ') || 'Quantity split';
    }
    case 'fixed': {
      const parts = (rule.shares || []).map((s) => `${s.person} $${s.value.toFixed(2)}`);
      if (rule.remainderTo && rule.remainderTo.length > 0) {
        const rem = rule.remainderTo.includes('all') ? 'Shared' : rule.remainderTo.join(', ');
        parts.push(`Rest: ${rem}`);
      }
      return parts.join(' · ') || 'Fixed amount';
    }
    case 'exclude': {
      const excl = (rule.excluded || []).join(', ');
      return excl ? `All except ${excl}` : 'Split equally';
    }
    case 'equal': {
      if (rule.shares && rule.shares.length > 0) {
        return rule.shares.map((s) => s.person).join(', ');
      }
      return 'Split equally';
    }
    default:
      return 'Split equally';
  }
}

/**
 * Deterministically computes each participant's exact integer-cent share of a single LedgerRow
 * using row.amountCents and row.allocationRule, applying Largest Remainder rounding so the sum
 * across participants for that row strictly equals row.amountCents.
 */
export function evaluateRowCents(row: LedgerRow, participants: string[]): Map<string, number> {
  const result = new Map<string, number>(participants.map((p) => [p, 0]));
  if (participants.length === 0 || row.amountCents <= 0) {
    return result;
  }

  const rawMap = new Map<string, number>(participants.map((p) => [p, 0]));
  const rule = row.allocationRule;

  if (rule) {
    switch (rule.mode) {
      case 'equal': {
        const targetNames = (rule.shares && rule.shares.length > 0)
          ? rule.shares.map((s) => s.person)
          : participants;
        const matched = targetNames
          .map((name) => resolvePerson(name, participants))
          .filter((p): p is string => Boolean(p));
        const targets = matched.length > 0 ? matched : participants;
        const perPerson = targets.length > 0 ? row.amountCents / targets.length : 0;
        for (const p of targets) {
          rawMap.set(p, (rawMap.get(p) ?? 0) + perPerson);
        }
        break;
      }

      case 'exclude': {
        const targets = participants.filter(
          (p) => !rule.excluded?.some((ex) => ex.toLowerCase() === p.toLowerCase())
        );
        const finalTargets = targets.length > 0 ? targets : participants;
        const perPerson = finalTargets.length > 0 ? row.amountCents / finalTargets.length : 0;
        for (const p of finalTargets) {
          rawMap.set(p, (rawMap.get(p) ?? 0) + perPerson);
        }
        break;
      }

      case 'percentage': {
        const pctMap = new Map<string, number>();
        let sumPct = 0;

        for (const s of rule.shares || []) {
          const matchedPerson = resolvePerson(s.person, participants);
          if (matchedPerson) {
            pctMap.set(matchedPerson, (pctMap.get(matchedPerson) ?? 0) + s.value);
            sumPct += s.value;
          }
        }

        const remainingPct = Math.max(0, 100 - sumPct);
        if (remainingPct > 0) {
          let remainderTargets: string[] = [];
          if (rule.remainderTo && rule.remainderTo.length > 0 && !rule.remainderTo.includes('all')) {
            remainderTargets = rule.remainderTo
              .map((r) => resolvePerson(r, participants))
              .filter((p): p is string => Boolean(p));
          }
          if (remainderTargets.length === 0) {
            const assignedNames = new Set(
              (rule.shares || []).map((s) => s.person.toLowerCase())
            );
            remainderTargets = participants.filter((p) => !assignedNames.has(p.toLowerCase()));
            if (remainderTargets.length === 0) remainderTargets = participants;
          }

          const perPersonPct = remainingPct / remainderTargets.length;
          for (const p of remainderTargets) {
            pctMap.set(p, (pctMap.get(p) ?? 0) + perPersonPct);
          }
        }

        for (const [p, pct] of pctMap.entries()) {
          rawMap.set(p, (rawMap.get(p) ?? 0) + row.amountCents * (pct / 100));
        }
        break;
      }

      case 'quantity': {
        const totalQty = Math.max(1, row.quantity || 1);
        const unitCents = row.amountCents / totalQty;
        let sumUnits = 0;

        for (const s of rule.shares || []) {
          const matchedPerson = resolvePerson(s.person, participants);
          if (matchedPerson) {
            rawMap.set(matchedPerson, (rawMap.get(matchedPerson) ?? 0) + s.value * unitCents);
            sumUnits += s.value;
          }
        }

        const remainingUnits = Math.max(0, totalQty - sumUnits);
        if (remainingUnits > 0) {
          let remainderTargets: string[] = [];
          if (rule.remainderTo && rule.remainderTo.length > 0 && !rule.remainderTo.includes('all')) {
            remainderTargets = rule.remainderTo
              .map((r) => resolvePerson(r, participants))
              .filter((p): p is string => Boolean(p));
          }
          if (remainderTargets.length === 0) remainderTargets = participants;

          const perPersonUnits = remainingUnits / remainderTargets.length;
          for (const p of remainderTargets) {
            rawMap.set(p, (rawMap.get(p) ?? 0) + perPersonUnits * unitCents);
          }
        }
        break;
      }

      case 'fixed': {
        let sumFixedCents = 0;

        for (const s of rule.shares || []) {
          const matchedPerson = resolvePerson(s.person, participants);
          const cents = Math.min(row.amountCents, Math.round(s.value * 100));
          if (matchedPerson) {
            rawMap.set(matchedPerson, (rawMap.get(matchedPerson) ?? 0) + cents);
            sumFixedCents += cents;
          }
        }

        const remainingCents = Math.max(0, row.amountCents - sumFixedCents);
        if (remainingCents > 0) {
          let remainderTargets: string[] = [];
          if (rule.remainderTo && rule.remainderTo.length > 0 && !rule.remainderTo.includes('all')) {
            remainderTargets = rule.remainderTo
              .map((r) => resolvePerson(r, participants))
              .filter((p): p is string => Boolean(p));
          }
          if (remainderTargets.length === 0) remainderTargets = participants;

          const perPersonRem = remainingCents / remainderTargets.length;
          for (const p of remainderTargets) {
            rawMap.set(p, (rawMap.get(p) ?? 0) + perPersonRem);
          }
        }
        break;
      }

      default: {
        const share = row.amountCents / participants.length;
        for (const p of participants) rawMap.set(p, share);
        break;
      }
    }
  } else {
    // Fallback: If row.assignedTo && row.assignedTo !== 'split'
    if (row.assignedTo && row.assignedTo !== 'split') {
      const matched = resolvePerson(row.assignedTo, participants);
      if (matched) {
        rawMap.set(matched, (rawMap.get(matched) ?? 0) + row.amountCents);
      } else {
        const parts = row.assignedTo
          .split(',')
          .map((s) => resolvePerson(s, participants))
          .filter((p): p is string => Boolean(p));
        const targets = parts.length > 0 ? parts : participants;
        const share = row.amountCents / targets.length;
        for (const p of targets) {
          rawMap.set(p, (rawMap.get(p) ?? 0) + share);
        }
      }
    } else {
      const share = participants.length > 0 ? row.amountCents / participants.length : 0;
      for (const p of participants) {
        rawMap.set(p, share);
      }
    }
  }

  // Scale the shares to the line amount and round with the Largest Remainder method, so the row always
  // sums exactly to row.amountCents, even when explicit shares add up to more than the line
  // (e.g. "Ali 2, Sara 1" on a 2x item, or 60% + 60%). Nobody can be billed more than the line.
  const weights = participants.map((p) => Math.max(0, rawMap.get(p) ?? 0));
  const cents = allocateCentsByWeight(row.amountCents, weights);
  return new Map<string, number>(participants.map((p, idx) => [p, cents[idx]]));
}

/**
 * Distributes an integer totalCents across an array of weights using the
 * Largest Remainder Method (Hamilton / Hare-Niemeyer method).
 * Guarantees that the returned integer array strictly sums to totalCents.
 */
export function allocateCentsByWeight(totalCents: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (totalCents === 0) return new Array(n).fill(0);

  const sumWeights = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const effectiveWeights = sumWeights > 0 ? weights.map((w) => Math.max(0, w)) : new Array(n).fill(1);
  const totalWeight = sumWeights > 0 ? sumWeights : n;

  const rawAllocations = effectiveWeights.map((w, idx) => {
    const raw = (totalCents * w) / totalWeight;
    const floor = Math.floor(raw);
    return {
      index: idx,
      floor,
      remainder: raw - floor,
    };
  });

  const sumFloor = rawAllocations.reduce((s, a) => s + a.floor, 0);
  let pennies = totalCents - sumFloor;

  const result = rawAllocations.map((a) => a.floor);

  if (pennies > 0) {
    const sorted = [...rawAllocations].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < Math.min(pennies, sorted.length); i++) {
      result[sorted[i].index] += 1;
    }
  } else if (pennies < 0) {
    const reverseSorted = [...rawAllocations].sort((a, b) => a.remainder - b.remainder);
    for (let i = 0; i < Math.min(Math.abs(pennies), reverseSorted.length); i++) {
      result[reverseSorted[i].index] = Math.max(0, result[reverseSorted[i].index] - 1);
    }
  }

  return result;
}

/**
 * Formats a numeric unit count strictly using whole numbers ("1×", "2×")
 * or clean decimal points ("0.3×", "0.5×", "0.25×", "1.25×") with zero slashes.
 */
export function formatQtyLabel(units: number): string {
  if (!Number.isFinite(units) || units <= 0) return '1×';
  const roundedInt = Math.round(units);
  if (Math.abs(units - roundedInt) < 0.04) return `${roundedInt}×`;

  // Keep quarters (0.25, 0.75, 1.25, 1.75) at 2 decimal places; all other splits (0.3, 0.5, 0.7, 1.5) at 1 decimal place
  const isQuarter = Math.abs(units * 4 - Math.round(units * 4)) < 0.06 && Math.abs(units * 2 - Math.round(units * 2)) >= 0.06;
  const formatted = isQuarter ? Number(units.toFixed(2)) : Number(units.toFixed(1));
  return `${formatted}×`;
}

/**
 * Computes transparent, penny-exact per-participant breakdown from TabLedger.
 * Evaluates row allocations deterministically and applies Largest Remainder rounding.
 */
export function computeSplit(ledger: TabLedger, participants: string[]): SplitResult[] {
  if (!ledger.rows || ledger.rows.length === 0 || participants.length === 0) {
    return participants.map((name) => ({
      participantName: name,
      foodCents: 0,
      discountCents: 0,
      serviceChargeCents: 0,
      taxCents: 0,
      tipCents: 0,
      amountCents: 0,
      taxRatePct: 0,
      items: [],
    }));
  }

  const foodMap = new Map<string, number>(participants.map((n) => [n, 0]));
  const itemMap = new Map<string, { description: string; qty: number; qtyLabel?: string; amountCents: number; ruleSummary?: string }[]>(
    participants.map((n) => [n, []])
  );

  for (const row of ledger.rows) {
    const rowShares = evaluateRowCents(row, participants);
    const rule = row.allocationRule;
    const nonZeroTargets = Array.from(rowShares.entries())
      .filter(([_, cents]) => cents > 0)
      .map(([p]) => p);
    const N = nonZeroTargets.length;
    const totalQty = Math.max(1, row.quantity || 1);

    for (const [p, shareCents] of rowShares.entries()) {
      if (shareCents <= 0) continue;

      // Count the money first: the code below only builds the item label.
      foodMap.set(p, (foodMap.get(p) ?? 0) + shareCents);

      let itemQty = 1;
      let itemQtyLabel = '1×';
      let itemDesc = row.description;
      let itemRuleSummary: string | undefined = undefined;

      if (rule?.mode === 'quantity') {
        let myUnits = 0;
        const explicitShare = rule.shares?.find(
          (s) => resolvePerson(s.person, participants)?.toLowerCase() === p.toLowerCase()
        );
        if (explicitShare) {
          myUnits += explicitShare.value;
        }

        const sumUnits = (rule.shares || []).reduce((acc, s) => (resolvePerson(s.person, participants) ? acc + s.value : acc), 0);
        const remainingUnits = Math.max(0, totalQty - sumUnits);
        if (remainingUnits > 0) {
          let remainderTargets: string[] = [];
          if (rule.remainderTo && rule.remainderTo.length > 0 && !rule.remainderTo.includes('all')) {
            remainderTargets = rule.remainderTo
              .map((r) => resolvePerson(r, participants))
              .filter((target): target is string => Boolean(target));
          }
          if (remainderTargets.length === 0) {
            remainderTargets = participants;
          }
          if (remainderTargets.some((rt) => rt.toLowerCase() === p.toLowerCase())) {
            myUnits += remainingUnits / remainderTargets.length;
          }
        }

        if (myUnits <= 0 && row.amountCents > 0) {
          myUnits = totalQty * (shareCents / row.amountCents);
        }

        itemQty = Math.round(myUnits * 100) / 100;
        itemQtyLabel = formatQtyLabel(myUnits);
        itemDesc = row.description;
      } else if (rule?.mode === 'percentage') {
        let myPct = 0;
        const explicitShare = rule.shares?.find(
          (s) => resolvePerson(s.person, participants)?.toLowerCase() === p.toLowerCase()
        );
        if (explicitShare) {
          myPct += explicitShare.value;
        }

        const sumPct = (rule.shares || []).reduce((acc, s) => (resolvePerson(s.person, participants) ? acc + s.value : acc), 0);
        const remainingPct = Math.max(0, 100 - sumPct);
        if (remainingPct > 0) {
          let remainderTargets: string[] = [];
          if (rule.remainderTo && rule.remainderTo.length > 0 && !rule.remainderTo.includes('all')) {
            remainderTargets = rule.remainderTo
              .map((r) => resolvePerson(r, participants))
              .filter((target): target is string => Boolean(target));
          }
          if (remainderTargets.length === 0) {
            const assignedNames = new Set((rule.shares || []).map((s) => s.person.toLowerCase()));
            remainderTargets = participants.filter((pt) => !assignedNames.has(pt.toLowerCase()));
            if (remainderTargets.length === 0) remainderTargets = participants;
          }
          if (remainderTargets.some((rt) => rt.toLowerCase() === p.toLowerCase())) {
            myPct += remainingPct / remainderTargets.length;
          }
        }

        if (myPct <= 0 && row.amountCents > 0) {
          myPct = (shareCents / row.amountCents) * 100;
        }

        const formattedPct = Math.round(myPct * 10) / 10;
        itemQty = 1;
        itemQtyLabel = `${formattedPct}%`;
        itemDesc = row.description;
      } else if (rule?.mode === 'fixed') {
        itemQty = 1;
        itemQtyLabel = '1×';
        itemDesc = row.description;
      } else {
        // Equal, exclude, or default shared split: compute exact unit fraction per person
        const myUnits = N > 1 ? totalQty / N : totalQty;
        itemQty = Math.round(myUnits * 100) / 100;
        itemQtyLabel = formatQtyLabel(myUnits);
        itemDesc = row.description;
      }

      itemMap.get(p)?.push({
        description: itemDesc,
        qty: itemQty,
        qtyLabel: itemQtyLabel,
        amountCents: shareCents,
        ruleSummary: itemRuleSummary,
      });
    }
  }

  const foodList = participants.map((p) => foodMap.get(p) ?? 0);
  const subtotalCents = foodList.reduce((a, b) => a + b, 0);

  const isTaxInclusive = ledger.isTaxInclusive ?? false;
  const discountShares = allocateCentsByWeight(ledger.discountCents || 0, foodList);
  const serviceShares = allocateCentsByWeight((ledger.serviceChargeCents || 0) + (ledger.roundOffCents || 0), foodList);
  const taxShares = allocateCentsByWeight(ledger.taxCents || 0, foodList);

  let tipShares: number[];
  if (ledger.tipAllocationRule && (ledger.tipCents || 0) > 0) {
    const tipRowMap = evaluateRowCents(
      {
        id: '__tip__',
        description: 'Tip',
        quantity: 1,
        amountCents: ledger.tipCents || 0,
        assignedTo: 'split',
        taxPct: 0,
        allocationRule: ledger.tipAllocationRule,
      },
      participants
    );
    tipShares = participants.map((p) => tipRowMap.get(p) ?? 0);
  } else {
    tipShares = allocateCentsByWeight(ledger.tipCents || 0, foodList);
  }

  const taxRatePct = subtotalCents > 0 && ledger.taxCents > 0
    ? Math.round((ledger.taxCents / subtotalCents) * 1000) / 10
    : 0;

  return participants.map((p, idx) => {
    const foodCents = foodList[idx];
    const discountCents = discountShares[idx];
    const serviceChargeCents = serviceShares[idx];
    const taxCents = taxShares[idx];
    const tipCents = tipShares[idx];

    const amountCents = isTaxInclusive
      ? Math.max(0, foodCents - discountCents + serviceChargeCents + tipCents)
      : Math.max(0, foodCents - discountCents + serviceChargeCents + taxCents + tipCents);

    return {
      participantName: p,
      foodCents,
      discountCents,
      serviceChargeCents,
      taxCents,
      tipCents,
      amountCents,
      taxRatePct,
      items: itemMap.get(p) ?? [],
    };
  });
}
