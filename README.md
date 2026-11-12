# VoxTab

Snap any receipt, say who had what in plain English, and settle up through PayPal Sandbox checkout.

[![Next.js](https://img.shields.io/badge/Next.js-16_App_Router-black.svg)](https://nextjs.org/)
[![AG Grid](https://img.shields.io/badge/AG_Grid_React-36.2_Community-brightgreen.svg)](https://www.ag-grid.com/)

---

## Why VoxTab

Splitting a receipt at the table usually turns into a hassle:

1. **Passing the paper receipt around** and punching every price into a calculator takes too long.
2. **Account sign-ups and app downloads** make friends put off paying you back.
3. **LLMs can't do math reliably.** Asking a general AI chatbot to split a bill leads to made-up prices, miscalculated tax and tip shares, and missing pennies on uneven splits.

### How It Works

1. **Snap the receipt:** Take a photo, upload an image, or click **Try sample**. Every line item, quantity, tax line, and discount shows up automatically in a clean table.
2. **Say or type who had what:** Speak into the mic or type one natural sentence—for example:
   *"My name is Ali, I got the Artisan Pizza Pack, Sara took 1 Organic Cold Brew, Bilal and I shared the rest, add $5 tip split equally."*
   Everyone's share updates live on the receipt.
3. **Settle in one tap or QR scan:** Each person gets a breakdown card with a **Pay via PayPal** button, a scannable **PayPal QR code**, and a shareable group link. Friends don't need an app or a VoxTab account. Once someone pays, their card flips to **Paid** automatically.

> VoxTab runs in **PayPal Sandbox** mode for this hackathon demo. No real money is transferred and Live PayPal is disabled.

---

## Common Use Cases

VoxTab works on any receipt with line items:

- **Group dinners and cafes:** Individual entrees, shared appetizers, and custom or equal tip splits.
- **Roommate grocery runs:** Shared household supplies split equally alongside personal items.
- **Pharmacy and supply runs:** Quick voice assignment across multi-quantity items and discounts.
- **Road trips and group outings:** One link in the group chat so everyone pays their exact share.

---

## Under the Hood

VoxTab keeps **AI parsing** separate from **financial math** so totals always match the receipt:

| Part | File | Role |
| :--- | :--- | :--- |
| **Receipt & Voice Parsing** | `src/app/api/parse-tab/route.ts` | Uses Google Gemini (`gemini-3.5-flash-lite`) strictly to read printed receipt lines and turn spoken or typed commands into assignment rules—never to calculate prices—with a local keyword fallback for typed commands. |
| **Exact Cent Split Engine** | `src/lib/ledgerUtils.ts` | Calculates every item, proportional tax, discount, and tip in integer cents so individual shares add up to the exact receipt total with zero missing pennies. |
| **Share Links & PayPal Verification** | `src/app/api/shortlink/route.ts` & `src/app/api/paypal-order/route.ts` | Saves a server-backed bill snapshot (`/s/[code]`), creates PayPal Sandbox checkout orders for each person's share, and verifies capture completion before marking a share **Paid**. |
| **Currency & Local History** | `src/lib/i18n.tsx` & `src/lib/tabStorage.ts` | Formats supported PayPal currencies and keeps scanned bills saved locally in the browser under **Saved Bills**. |

---

## Sharing & Accounts

- **No VoxTab accounts:** Neither the host nor participants create an account or password.
- **Server-backed share links:** Sharing a bill creates a short link (`/s/[code]`) backed by Supabase so friends can open it on their phone and payment statuses stay synced across devices. A URL fragment fallback is used if the shortlink endpoint is unreachable.
- **PayPal Sandbox checkout:** Participants sign in with a **PayPal Sandbox Personal buyer account** to complete test checkout. VoxTab never sees or stores card numbers or PayPal passwords.

---

## Environment Variables

Set these variables in `.env.local` for local development (never commit `.env.local` or secrets to Git):

| Variable | Purpose |
| :--- | :--- |
| `GEMINI_API_KEY` | Google Generative AI API key for receipt image and voice extraction. |
| `PAYPAL_CLIENT_ID` | PayPal Sandbox REST app client ID. |
| `PAYPAL_CLIENT_SECRET` | PayPal Sandbox REST app client secret. |
| `SUPABASE_URL` | Supabase project URL for share links, orders, and verified payment statuses. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server-side only). |
| `NEXT_PUBLIC_APP_URL` | Optional origin override (e.g., `http://localhost:3000`); Vercel automatically uses the incoming HTTPS request origin in production. |

---

## Local Setup

### 1. Prerequisites

- Node.js 20.9 or later
- npm

### 2. Install Dependencies

```bash
npm install
3. Configure Environment & Database
Copy .env.example to .env.local and add your credentials (never commit .env.local).

Run supabase/schema.sql in your Supabase SQL Editor to create the short_links, paypal_orders, and payment_status_v2 tables.

4. Start the Dev Server
Bash
npm run dev
License
Licensed under the MIT License.


---
