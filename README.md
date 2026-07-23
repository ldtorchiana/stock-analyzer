# Value Investing Analyzer — live edition

Type any stock ticker → the app pulls **live data** and runs it through a Real Numbers
dashboard, the 8 Pillars, and a fully adjustable Stock Analyzer (intrinsic value + expected
return). Modeled on the Everything Money process.

The live data comes from **Finnhub's free tier** through a tiny serverless function that keeps
your API key hidden on the server. Deploy it once (free) and it runs from any device, phone
included.

---

## What you get

- **Fetch by ticker** — one box at the top. Type `NVDA`, `MSFT`, anything, and hit *Fetch live*.
- **Real Numbers** — market cap, revenue, FCF, P/E, margins, ROIC, EV, 5-yr growth, all current.
- **8 Pillars** — the pass/fail health scan with a score.
- **Stock Analyzer** — edit Low / Mid / High assumptions and watch intrinsic value + return recalc live.
- Your stocks + assumptions save in your browser. Export / Import as JSON to back up or move them.

### What's live vs estimated (be honest with yourself)
Finnhub's free tier gives real-time price and a rich set of TTM metrics, so **price, market cap,
and every valuation multiple are dead-on current**. A few history-based inputs (5-yr averages,
"5 years ago" figures) are **estimated from published growth rates** — the app flags these with an
amber chip. Two balance-sheet items (long-term liabilities, shares 5 yrs ago) aren't on the free
tier, so the app marks them for a quick **manual entry**. Everything you type is preserved on refresh.
Upgrading to a paid Finnhub/FMP data plan later can fill those automatically.

---

## Deploy in ~5 minutes (Vercel, free)

### 1. Get a free Finnhub API key
Go to https://finnhub.io/register, sign up, copy the API key from your dashboard.

### 2. Put this folder on GitHub
Create a new repository and upload these files (or `git init`, commit, and push). The structure is:

```
value-analyzer-app/
├── index.html         ← the app
├── api/
│   └── stock.js       ← serverless data proxy (holds your key)
├── package.json
├── .env.example
└── README.md
```

### 3. Import into Vercel
1. Go to https://vercel.com, sign in (GitHub login is easiest), click **Add New → Project**.
2. Select your repository. Framework preset: **Other** (no build step needed).
3. Before deploying, open **Environment Variables** and add:
   - **Name:** `FINNHUB_API_KEY`  **Value:** *(your key from step 1)*
4. Click **Deploy**.

Vercel gives you a URL like `https://your-app.vercel.app`. Open it, type a ticker, done.
Bookmark it on your phone and desktop.

### Prefer the command line?
```bash
npm i -g vercel
cd value-analyzer-app
vercel               # follow prompts
vercel env add FINNHUB_API_KEY    # paste your key
vercel --prod
```

---

## How the valuation math works
For each Low/Mid/High scenario the analyzer projects revenue forward at your growth rate, applies
your margin to get future earnings and free cash flow, applies the multiple you'd assign years out,
then discounts **every year's cash flow back to today at your required return** — the present value of
all future cash flows. The "return at today's price" is the IRR you'd earn buying now. It's a faithful
reconstruction of the Everything Money method and lands within a few percent of their tool; it does
not factor in the balance sheet, so always apply your own margin of safety.

## Swapping data providers
Only Finnhub is wired up today. To add a paid provider (e.g. Financial Modeling Prep for full
statement history), add a `fromFMP()` function in `api/stock.js` mirroring `fromFinnhub()`, and set
`DATA_PROVIDER=fmp` plus that provider's key in your environment.

## Not investment advice
Educational tool for your own research.
