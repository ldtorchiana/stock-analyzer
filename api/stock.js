// Serverless proxy: GET /api/stock?ticker=PLTR
// Holds the data-provider API key server-side and returns a normalized, analyzer-ready object.
// Default provider: Finnhub (free tier). Set FINNHUB_API_KEY in your environment.
//
// Response shape:
//   { ok:true, ticker, asOf, provider, stock:{...analyzer fields...}, meta:{ field: "live"|"estimated"|"missing" } }
// All $ figures are returned in BILLIONS and share counts in BILLIONS, to match the analyzer.

const FINNHUB = "https://finnhub.io/api/v1";

// pick the first present, finite candidate from the metric object
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v !== undefined && v !== null && v !== "" && isFinite(+v)) return +v;
  }
  return null;
}
// Finnhub margins/growth are sometimes ratios (0.43) and sometimes percents (43). Normalize to percent.
function asPct(v) {
  if (v === null) return null;
  return Math.abs(v) <= 1.5 ? v * 100 : v;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("provider " + r.status);
  return r.json();
}

async function fromFinnhub(ticker, key) {
  const [quote, profile, basic] = await Promise.all([
    getJSON(`${FINNHUB}/quote?symbol=${ticker}&token=${key}`),
    getJSON(`${FINNHUB}/stock/profile2?symbol=${ticker}&token=${key}`),
    getJSON(`${FINNHUB}/stock/metric?symbol=${ticker}&metric=all&token=${key}`),
  ]);
  const m = (basic && basic.metric) || {};
  const meta = {};

  // ---- primary, live figures ----
  const price = isFinite(+quote.c) && +quote.c > 0 ? +quote.c : null;
  const sharesM = pick(profile, ["shareOutstanding"]);          // in millions
  const shares = sharesM !== null ? sharesM / 1000 : null;      // -> billions
  const mcapM = pick(profile, ["marketCapitalization"]);        // in millions
  let mktcap = mcapM !== null ? mcapM / 1000 : (price !== null && shares !== null ? price * shares : null);

  const peTTM = pick(m, ["peTTM", "peBasicExclExtraTTM", "peNormalizedAnnual"]);
  const psTTM = pick(m, ["psTTM", "psAnnual"]);
  const pfcfShare = pick(m, ["pfcfShareTTM", "pfcfShareAnnual"]);
  const grossMargin = asPct(pick(m, ["grossMarginTTM", "grossMarginAnnual"]));
  const netMargin = asPct(pick(m, ["netProfitMarginTTM", "netProfitMarginAnnual"]));
  const roic = asPct(pick(m, ["roiTTM", "roiAnnual", "roicTTM"]));
  const roe = asPct(pick(m, ["roeTTM", "roeAnnual"]));
  const wk52high = pick(m, ["52WeekHigh"]);
  const wk52low = pick(m, ["52WeekLow"]);

  const revG1 = asPct(pick(m, ["revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy"]));
  const revG5 = asPct(pick(m, ["revenueGrowth5Y"]));
  const epsG5 = asPct(pick(m, ["epsGrowth5Y"]));
  const netMargin5 = asPct(pick(m, ["netProfitMargin5Y"]));

  // ---- derive absolute-dollar TTM figures (billions) ----
  let revTTM = null;
  const revPerShare = pick(m, ["revenuePerShareTTM", "revenuePerShareAnnual"]);
  if (revPerShare !== null && shares !== null) revTTM = revPerShare * shares;
  else if (psTTM && mktcap) revTTM = mktcap / psTTM;

  let niTTM = null;
  if (peTTM && mktcap) niTTM = mktcap / peTTM;
  else if (netMargin !== null && revTTM !== null) niTTM = revTTM * (netMargin / 100);

  let fcfTTM = null;
  if (pfcfShare && price !== null && shares !== null) fcfTTM = (price / pfcfShare) * shares;

  // ---- enterprise value ----
  let ev = pick(m, ["enterpriseValue", "currentEv"]);
  if (ev !== null && ev > 100000) ev = ev / 1e9;      // if returned in raw dollars
  else if (ev !== null && ev > 1000) ev = ev / 1000;  // if returned in millions
  // (kept null if provider doesn't supply it; analyzer falls back to market cap)

  // ---- 5-year-ago values, estimated from growth CAGRs (flagged) ----
  const backCast = (now, cagrPct, yrs = 5) =>
    now === null || cagrPct === null ? null : now / Math.pow(1 + cagrPct / 100, yrs);
  const avgFromCagr = (now, cagrPct, yrs = 5) => {
    if (now === null || cagrPct === null) return null;
    let sum = 0;
    for (let k = 0; k < yrs; k++) sum += now / Math.pow(1 + cagrPct / 100, k);
    return sum / yrs;
  };
  const rev5yrAgo = backCast(revTTM, revG5);
  const ni5yrAgo = backCast(niTTM, epsG5 !== null ? epsG5 : revG5);
  const fcf5yrAgo = backCast(fcfTTM, revG5);
  const avgNI5 = avgFromCagr(niTTM, epsG5 !== null ? epsG5 : revG5);
  const avgFCF5 = avgFromCagr(fcfTTM, revG5);

  const stock = {
    ticker: ticker.toUpperCase(),
    name: profile.name || ticker.toUpperCase(),
    price, shares,
    revTTM, niTTM, fcfTTM,
    avgNI5, avgFCF5,
    rev5yrAgo, ni5yrAgo, fcf5yrAgo,
    shares5yrAgo: null,   // not available on free tier -> manual
    roicTTM: roic, roic5yr: null,
    ltl: null,            // long-term liabilities not on free tier -> manual
    ev,
    divPaid: 0,
    grossMargin,
    revG1, revG5,
    pm1: netMargin, pm5: netMargin5,
    fcfm1: (fcfTTM !== null && revTTM) ? (fcfTTM / revTTM) * 100 : null,
    fcfm5: null,
    wk52high, wk52low,
  };

  // ---- coverage map ----
  const liveFields = ["price", "shares", "revTTM", "niTTM", "fcfTTM", "grossMargin", "roicTTM", "wk52high", "wk52low", "revG1", "revG5", "pm1", "ev"];
  const estFields = ["avgNI5", "avgFCF5", "rev5yrAgo", "ni5yrAgo", "fcf5yrAgo"];
  const manualFields = ["shares5yrAgo", "ltl", "roic5yr", "divPaid"];
  for (const f of liveFields) meta[f] = stock[f] === null || stock[f] === undefined ? "missing" : "live";
  for (const f of estFields) meta[f] = stock[f] === null || stock[f] === undefined ? "missing" : "estimated";
  for (const f of manualFields) meta[f] = "manual";

  return { stock, meta };
}

export { fromFinnhub };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  const ticker = (req.query.ticker || req.query.symbol || "").toString().trim().toUpperCase();
  if (!ticker || !/^[A-Z.\-]{1,10}$/.test(ticker)) {
    return res.status(400).json({ ok: false, error: "Provide a valid ticker, e.g. ?ticker=PLTR" });
  }
  const provider = (process.env.DATA_PROVIDER || "finnhub").toLowerCase();
  const key = process.env.FINNHUB_API_KEY;
  if (provider === "finnhub" && !key) {
    return res.status(500).json({ ok: false, error: "FINNHUB_API_KEY is not set on the server." });
  }
  try {
    let result;
    if (provider === "finnhub") result = await fromFinnhub(ticker, key);
    else return res.status(500).json({ ok: false, error: "Unknown DATA_PROVIDER: " + provider });

    if (result.stock.price === null && result.stock.mktcap === null) {
      return res.status(404).json({ ok: false, error: "No data for " + ticker + " (unknown ticker or provider limit reached)." });
    }
    return res.status(200).json({
      ok: true, ticker, provider,
      asOf: new Date().toISOString(),
      ...result,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Provider error: " + (e.message || "unknown") });
  }
}
