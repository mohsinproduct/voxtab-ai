/**
 * @file tab.ts
 * @description Core domain type definitions for the VoxTab ledger and split calculation system.
 *
 * All monetary amounts in the domain models are stored in integer cents (e.g., $10.50 = 1050)
 * to guarantee mathematical precision and prevent floating-point rounding errors.
 */

export type AllocationMode = 'equal' | 'exclude' | 'quantity' | 'percentage' | 'fixed';

export interface AllocationShare {
  /** Participant name (e.g. "Ali", "Me") */
  person: string;
  /**
   * Value depends on mode:
   * - 'percentage': 0 to 100 (e.g. 30 for 30%)
   * - 'quantity': unit count (e.g. 2 for 2 items)
   * - 'fixed': exact dollar amount (e.g. 5.50 for $5.50)
   * - 'equal': 1
   */
  value: number;
}

export interface AllocationRule {
  mode: AllocationMode;
  shares: AllocationShare[];
  /** Participant names excluded when mode === 'exclude' */
  excluded?: string[];
  /** Who splits the remaining percentage/units/dollars ('all' or participant names) */
  remainderTo?: string[];
}

/**
 * Represents a person participating in a shared expense tab.
 */
export interface Participant {
  /** Unique identifier for the participant */
  id: string;
  /** Display name of the participant */
  name: string;
  /** Accent color hex code used for avatar pills and visual grouping */
  color?: string;
  /** Whether this participant created or hosts the tab */
  isHost?: boolean;
}

/**
 * Standard categorized tags for line items to enable filtering and icons.
 */
export type ItemCategory =
  | 'food'
  | 'beverage'
  | 'groceries'
  | 'tech'
  | 'transport'
  | 'general';

/**
 * Represents an individual line item from a receipt.
 */
export interface ReceiptItem {
  /** Unique identifier for the item */
  id: string;
  /** Human-readable title or description of the product/service */
  name: string;
  /** Line total in integer cents (unit price × quantity, e.g. 2 × $6.25 = 1250) */
  priceCents: number;
  /** Quantity purchased (defaults to 1) */
  quantity: number;
  /** Array of participant IDs assigned to share the cost of this item */
  assignedTo: string[];
  /** Category tag for visual indicators */
  category?: ItemCategory;
  /** Whether this item price already includes tax */
  isTaxInclusive?: boolean;
  /** Structured allocation rule evaluated by TypeScript */
  allocationRule?: AllocationRule;
  /** Human-readable allocation rule summary */
  ruleSummary?: string;
}

/**
 * Flattened, grid-friendly representation of a receipt line item.
 * Used by the wizard's Review step (AG Grid) for inline editing.
 * `assignedTo` stores a participant name string or 'split' (equal share).
 */
export interface LedgerRow {
  /** Unique item identifier */
  id: string;
  /** Item description */
  description: string;
  /** Item quantity purchased */
  quantity?: number;
  /** Price in integer cents */
  amountCents: number;
  /** Participant name or 'split' for equal share */
  assignedTo: string;
  /** Tax rate as decimal (e.g. 0.09 for 9%) */
  taxPct: number;
  /** Whether this row price already includes tax */
  isTaxInclusive?: boolean;
  /** Structured allocation rule evaluated by TypeScript */
  allocationRule?: AllocationRule;
  /** Human-readable allocation rule summary */
  ruleSummary?: string;
}

/**
 * The complete ledger object representing a shared expense session.
 */
export interface TabLedger {
  /** Unique session identifier */
  id: string;
  /** Descriptive title of the tab session */
  title: string;
  /** Merchant, store, or venue name */
  merchant: string;
  /** Date of transaction (YYYY-MM-DD) */
  date: string;
  /** List of extracted receipt line items */
  items: ReceiptItem[];
  /** Grid-friendly flat projection of items for the wizard Review step */
  rows: LedgerRow[];
  /** List of participants involved in the tab */
  participants: Participant[];
  /** Tax amount in integer cents */
  taxCents: number;
  /** Explicit tax percentage if printed on receipt (e.g. 16 for 16%) */
  taxPercentage?: number;
  /** Whether tax is already included in item prices (e.g. VAT / GST / retail) */
  isTaxInclusive?: boolean;
  /** Tax regime classification: inclusive, exclusive, or none */
  taxType?: 'inclusive' | 'exclusive' | 'none';
  /** Tip amount in integer cents */
  tipCents: number;
  tipAllocationRule?: AllocationRule;
  /** Service charge, delivery, or packaging fee in integer cents */
  serviceChargeCents?: number;
  /** Discount in integer cents (positive; does not include the round-off) */
  discountCents?: number;
  /** Round-off adjustment in integer cents (negative lowers the total, e.g. -40 for -0.40) */
  roundOffCents?: number;
  /** Data format version. 2 = discountCents excludes the round-off (missing = 1, upgraded on load). */
  schemaVersion?: number;
  /** Values as scanned, before any voice command: each voice command is applied to these. */
  scanBaseline?: { rows: LedgerRow[]; discountCents: number; tipCents: number };
  lastCommand?: string;
  /** Optional host PayPal Sandbox email address to receive split payouts */
  payeeEmail?: string;
  /** Sum of all line item sub-totals in cents */
  subtotalCents: number;
  /** Grand total in cents */
  totalCents: number;
  /** Creation timestamp in milliseconds */
  createdAt: number;
  /** Last updated timestamp in milliseconds */
  updatedAt: number;
}

/**
 * Request payload sent to the /api/parse-tab extraction endpoint.
 */
export interface ParseTabRequest {
  /** Optional existing tab ID to preserve identity across steps */
  tabId?: string;
  /** Base64 data URL of the receipt image (optional) */
  image?: string;
  /** Alternative key for base64 image */
  imageBase64?: string;
  /** Base64 data URL of audio recording (optional) */
  audio?: string;
  /** Spoken natural language split instruction or transcript */
  voiceTranscript?: string;
  /** Existing items if reassigning from Step 2 */
  existingItems?: {
    id: string;
    description?: string;
    name?: string;
    amountCents?: number;
    price?: number;
    quantity?: number;
    assignedTo?: string;
    category?: ItemCategory;
    allocationRule?: AllocationRule;
  }[];
  /** Existing participants list */
  existingParticipants?: {
    id: string;
    name: string;
    color?: string;
    isHost?: boolean;
  }[];
  payeeEmail?: string;
  merchant?: string;
  date?: string;
  taxCents?: number;
  taxPercentage?: number;
  isTaxInclusive?: boolean;
  taxType?: 'inclusive' | 'exclusive' | 'none';
  discountCents?: number;
  roundOffCents?: number;
  tipCents?: number;
  tipAllocationRule?: AllocationRule;
  serviceChargeCents?: number;
  totalCents?: number;
  /** Optional client-supplied Gemini API key */
  apiKey?: string;
}

/**
 * Structured response returned by the receipt parser adapter.
 */
export interface ParseTabResponse {
  /** Whether extraction succeeded */
  success: boolean;
  /** Merchant or venue extracted */
  merchant: string;
  /** Date of purchase */
  date: string;
  /** Extracted line items with initial assignments */
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
  }[];
  /** List of extracted participant names */
  participants: string[];
  /** Extracted tax amount in dollars */
  tax: number;
  /** Extracted tax percentage if explicitly printed (e.g. 10 or 16) */
  taxPercentage?: number;
  /** Whether tax is already included in item prices */
  isTaxInclusive?: boolean;
  /** Tax regime classification: inclusive, exclusive, or none */
  taxType?: 'inclusive' | 'exclusive' | 'none';
  /** Extracted discount / adjustment amount in dollars */
  discount?: number;
  /** Extracted service charge / fee in dollars */
  serviceCharge?: number;
  /** Extracted round off amount in dollars */
  roundOff?: number;
  /** Extracted tip amount in dollars */
  tip: number;
  /** Extracted grand total in dollars */
  total: number;
  /** Transcript used for item assignment */
  transcriptUsed?: string;
  /** The extraction adapter that processed the request */
  adapterUsed: string;
  /** Confidence score of extraction (0.0 to 1.0) */
  confidenceScore: number;
  /** Fully prepared TabLedger object ready for AG Grid */
  ledger?: TabLedger;
  /** Error code if failed */
  error?: string;
  /** Human-readable explanation */
  message?: string;
}
