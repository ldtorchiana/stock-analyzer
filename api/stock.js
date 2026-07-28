// Serverless proxy: GET /api/stock?ticker=PLTR
// Hybrid data source:
//   • Finnhub (free)        -> real-time price, shares, current TTM metrics & margins
//   • Alpha Vantage (free)  -> full income / balance / cash-flow history for the 8 Pillars
//     (long-term liabilities, share count history, 5-yr averages, 5-yr ROIC)
//
// Env vars:
//   FINNHUB_API_KEY        (required)
//   ALPHAVANTAGE_API_KEY   (optional; when set, all 8 pillars fill from real statements)
//
// All $ figures returned in BILLIONS, share counts in BILLIONS, percentages as whole numbers.

const FINNHUB = "https://finnhub.io/api/v1";
const AV = "https://www.alphavantage.co/query";

/* ---------- helpers ---------- */
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v !== undefined && v !== null && v !== "" && isFinite(+v)) return +v;
  }
  return null;
}
function asPct(v) { return v === null ? null : (Math.abs(v) <= 1.5 ? v * 100 : v); }
// parse an Alpha Vantage string field ("394328000000" | "None" | "")
function num(v) {
  if (v === undefined || v === null || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}
const toB = v => (v === null ? null : v / 1e9); // dollars -> billions

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("provider " + r.status);
  return r.json();
}

/* ---------- Finnhub: live price + current TTM ---------- */
async function fromFinnhub(ticker, key) {
  const [quote, profile, basic] = await Promise.all([
    getJSON(`${FINNHUB}/quote?symbol=${ticker}&token=${key}`),
    getJSON(`${FINNHUB}/stock/profile2?symbol=${ticker}&token=${key}`),
    getJSON(`${FINNHUB}/stock/metric?symbol=${ticker}&metric=all&token=${key}`),
  ]);
  const m = (basic && basic.metric) || {};
  const meta = {};

  const price = isFinite(+quote.c) && +quote.c > 0 ? +quote.c : null;
  const sharesM = pick(profile, ["shareOutstanding"]);
  const shares = sharesM !== null ? sharesM / 1000 : null;
  const mcapM = pick(profile, ["marketCapitalization"]);
  let mktcap = mcapM !== null ? mcapM / 1000 : (price !== null && shares !== null ? price * shares : null);

  const peTTM = pick(m, ["peTTM", "peBasicExclExtraTTM", "peNormalizedAnnual"]);
  const psTTM = pick(m, ["psTTM", "psAnnual"]);
  const pfcfShare = pick(m, ["pfcfShareTTM", "pfcfShareAnnual"]);
  const grossMargin = asPct(pick(m, ["grossMarginTTM", "grossMarginAnnual"]));
  const netMargin = asPct(pick(m, ["netProfitMarginTTM", "netProfitMarginAnnual"]));
  const roic = asPct(pick(m, ["roiTTM", "roiAnnual", "roicTTM"]));
  const wk52high = pick(m, ["52WeekHigh"]);
  const wk52low = pick(m, ["52WeekLow"]);
  const revG1 = asPct(pick(m, ["revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy"]));
  const revG5 = asPct(pick(m, ["revenueGrowth5Y"]));
  const epsG5 = asPct(pick(m, ["epsGrowth5Y"]));
  const netMargin5 = asPct(pick(m, ["netProfitMargin5Y"]));

  let revTTM = null;
  const revPerShare = pick(m, ["revenuePerShareTTM", "revenuePerShareAnnual"]);
  if (revPerShare !== null && shares !== null) revTTM = revPerShare * shares;
  else if (psTTM && mktcap) revTTM = mktcap / psTTM;
  let niTTM = null;
  if (peTTM && mktcap) niTTM = mktcap / peTTM;
  else if (netMargin !== null && revTTM !== null) niTTM = revTTM * (netMargin / 100);
  let fcfTTM = null;
  if (pfcfShare && price !== null && shares !== null) fcfTTM = (price / pfcfShare) * shares;

  // Enterprise value can arrive in raw dollars, millions, or billions depending on the field.
  // Pick the scaling whose magnitude is closest to market cap (EV is always within ~2x of it).
  let ev = null;
  const evRaw = pick(m, ["enterpriseValue", "currentEv"]);
  if (evRaw !== null && evRaw > 0 && mktcap !== null && mktcap > 0) {
    ev = [evRaw, evRaw / 1e3, evRaw / 1e6, evRaw / 1e9]
      .filter(c => c > 0)
      .reduce((best, c) => Math.abs(Math.log10(c / mktcap)) < Math.abs(Math.log10(best / mktcap)) ? c : best);
  }

  // fallback estimates (used only if Alpha Vantage is absent / rate-limited)
  const backCast = (now, c, y = 5) => now === null || c === null ? null : now / Math.pow(1 + c / 100, y);
  const avgCagr = (now, c, y = 5) => {
    if (now === null || c === null) return null;
    let s = 0; for (let k = 0; k < y; k++) s += now / Math.pow(1 + c / 100, k); return s / y;
  };

  const stock = {
    ticker: ticker.toUpperCase(), name: profile.name || ticker.toUpperCase(),
    price, shares, revTTM, niTTM, fcfTTM,
    avgNI5: avgCagr(niTTM, epsG5 !== null ? epsG5 : revG5),
    avgFCF5: avgCagr(fcfTTM, revG5),
    rev5yrAgo: backCast(revTTM, revG5),
    ni5yrAgo: backCast(niTTM, epsG5 !== null ? epsG5 : revG5),
    fcf5yrAgo: backCast(fcfTTM, revG5),
    shares5yrAgo: null, roicTTM: roic, roic5yr: null, ltl: null, ev, divPaid: 0, grossMargin,
    revG1, revG5, pm1: netMargin, pm5: netMargin5,
    fcfm1: (fcfTTM !== null && revTTM) ? (fcfTTM / revTTM) * 100 : null, fcfm5: null,
    wk52high, wk52low,
  };
  // provisional coverage (Alpha Vantage upgrades these below)
  for (const f of ["price","shares","revTTM","niTTM","fcfTTM","grossMargin","roicTTM","wk52high","wk52low","revG1","revG5","pm1","ev"])
    meta[f] = stock[f] === null || stock[f] === undefined ? "missing" : "live";
  for (const f of ["avgNI5","avgFCF5","rev5yrAgo","ni5yrAgo","fcf5yrAgo"])
    meta[f] = stock[f] === null ? "missing" : "estimated";
  for (const f of ["shares5yrAgo","ltl","roic5yr","divPaid"]) meta[f] = "manual";
  return { stock, meta };
}

/* ---------- Alpha Vantage: statement history for the pillars ---------- */
function sortDesc(reports) {
  return (reports || []).slice().sort((a, b) =>
    (b.fiscalDateEnding || "").localeCompare(a.fiscalDateEnding || ""));
}
async function fromAlphaVantage(ticker, key) {
  // Alpha Vantage's free tier allows only 1 request/second, so these must be
  // sequential with a gap — NOT Promise.all (which fires all three at once and gets throttled).
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const inc = await getJSON(`${AV}?function=INCOME_STATEMENT&symbol=${ticker}&apikey=${key}`);
  await sleep(1300);
  const bal = await getJSON(`${AV}?function=BALANCE_SHEET&symbol=${ticker}&apikey=${key}`);
  await sleep(1300);
  const cf = await getJSON(`${AV}?function=CASH_FLOW&symbol=${ticker}&apikey=${key}`);
  // Rate-limit / error responses carry Note/Information and no annualReports
  const income = sortDesc(inc.annualReports);
  const balance = sortDesc(bal.annualReports);
  const cash = sortDesc(cf.annualReports);
  if (!income.length || !balance.length || !cash.length) {
    const msg = inc.Note || inc.Information || bal.Note || bal.Information || cf.Note || cf.Information || "no statement data";
    return { ok: false, note: String(msg).slice(0, 160) };
  }
  const n = Math.min(5, income.length, cash.length); // window of up to 5 yrs
  const oldIdx = { inc: Math.min(n - 1, income.length - 1), cf: Math.min(n - 1, cash.length - 1), bal: Math.min(n - 1, balance.length - 1) };

  const niSeries = income.slice(0, n).map(r => num(r.netIncome)).filter(v => v !== null);
  const fcfSeries = cash.slice(0, n).map(r => {
    const op = num(r.operatingCashflow), capex = num(r.capitalExpenditures);
    return op === null ? null : op - Math.abs(capex || 0);
  }).filter(v => v !== null);

  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

  // 5-yr ROIC ≈ average of NOPAT / invested capital per year
  const roicYears = [];
  for (let i = 0; i < n; i++) {
    const I = income[i], B = balance[i];
    if (!I || !B) continue;
    const ebit = num(I.ebit) !== null ? num(I.ebit) : num(I.operatingIncome);
    const tax = num(I.incomeTaxExpense), pretax = num(I.incomeBeforeTax);
    let rate = tax !== null && pretax ? tax / pretax : 0.21;
    if (!(rate >= 0 && rate <= 0.5)) rate = 0.21;
    const equity = num(B.totalShareholderEquity);
    const debt = num(B.shortLongTermDebtTotal) !== null ? num(B.shortLongTermDebtTotal)
               : (num(B.longTermDebt) || 0) + (num(B.currentDebt) || 0);
    const nopat = ebit !== null ? ebit * (1 - rate) : num(I.netIncome);
    // ROIC = NOPAT / (debt + equity). Cash is intentionally NOT subtracted: for cash-rich
    // firms that drives invested capital toward zero and explodes the ratio.
    const invested = (equity || 0) + (debt || 0);
    if (nopat !== null && invested > equity * 0.2 && invested > 0) roicYears.push((nopat / invested) * 100);
  }

  const B0 = balance[0];
  let ltl = num(B0.totalNonCurrentLiabilities);
  if (ltl === null) {
    const tl = num(B0.totalLiabilities), cl = num(B0.totalCurrentLiabilities);
    ltl = tl !== null && cl !== null ? tl - cl : null;
  }
  // latest debt & cash for an accurate enterprise value (market cap + debt − cash)
  const debtLatest = num(B0.shortLongTermDebtTotal) !== null ? num(B0.shortLongTermDebtTotal)
                   : (num(B0.longTermDebt) || 0) + (num(B0.currentDebt) || 0);
  const cashLatest = num(B0.cashAndCashEquivalentsAtCarryingValue);

  const history = {
    avgNI5: toB(avg(niSeries)),
    avgFCF5: toB(avg(fcfSeries)),
    rev5yrAgo: toB(num((income[oldIdx.inc] || {}).totalRevenue)),
    ni5yrAgo: toB(num((income[oldIdx.inc] || {}).netIncome)),
    fcf5yrAgo: (() => {
      const r = cash[oldIdx.cf] || {}; const op = num(r.operatingCashflow), cx = num(r.capitalExpenditures);
      return op === null ? null : toB(op - Math.abs(cx || 0));
    })(),
    shares5yrAgo: toB(num((balance[oldIdx.bal] || {}).commonStockSharesOutstanding)),
    ltl: toB(ltl),
    roic5yr: roicYears.length >= 3 ? avg(roicYears) : null, // need 3+ valid yrs, else "not enough data"
    divPaid: toB(num((cash[0] || {}).dividendPayout)),
  };
  return { ok: true, history, years: n, debtLatest: toB(debtLatest), cashLatest: toB(cashLatest) };
}

export { fromFinnhub, fromAlphaVantage };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1200");
  const ticker = (req.query.ticker || req.query.symbol || "").toString().trim().toUpperCase();
  if (!ticker || !/^[A-Z.\-]{1,10}$/.test(ticker)) {
    return res.status(400).json({ ok: false, error: "Provide a valid ticker, e.g. ?ticker=PLTR" });
  }
  const fkey = process.env.FINNHUB_API_KEY;
  const avkey = process.env.ALPHAVANTAGE_API_KEY;
  if (!fkey) return res.status(500).json({ ok: false, error: "FINNHUB_API_KEY is not set on the server." });

  try {
    const { stock, meta } = await fromFinnhub(ticker, fkey);
    if (stock.price === null && stock.mktcap === null) {
      return res.status(404).json({ ok: false, error: "No data for " + ticker + " (unknown ticker or Finnhub limit reached)." });
    }

    let provider = "finnhub";
    let warning = null;

    if (avkey) {
      try {
        const av = await fromAlphaVantage(ticker, avkey);
        if (av.ok) {
          for (const [k, v] of Object.entries(av.history)) {
            if (v !== null && v !== undefined && isFinite(v)) { stock[k] = v; meta[k] = "live"; }
          }
          // accurate enterprise value = market cap + total debt − cash
          const mc = (stock.price !== null && stock.shares !== null) ? stock.price * stock.shares : null;
          if (mc && Number.isFinite(av.debtLatest) && Number.isFinite(av.cashLatest)) {
            stock.ev = mc + (av.debtLatest || 0) - (av.cashLatest || 0);
            meta.ev = "live";
          }
          provider = "finnhub + alphavantage";
        } else {
          warning = "Alpha Vantage unavailable (" + av.note + ") — pillar history is estimated. It resets daily.";
        }
      } catch (e) {
        warning = "Alpha Vantage error — pillar history is estimated. " + (e.message || "");
      }
    } else {
      warning = "ALPHAVANTAGE_API_KEY not set — some pillar fields are estimated or need manual entry.";
    }

    return res.status(200).json({ ok: true, ticker, provider, asOf: new Date().toISOString(), warning, stock, meta });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Provider error: " + (e.message || "unknown") });
  }
}
