// Real-time price fetcher
// Yahoo Finance (no key) → SPX, VIX, DXY, 10Y Yield, 5Y Breakeven
// CoinGecko (no key)     → BTC, ETH
// Alternative.me (no key)→ Crypto Fear & Greed
// FRED (FRED_API_KEY)    → HY Spreads, 2Y Yield, 10Y Yield, Real 10Y Yield

const YF_SYMBOLS = {
  spx:        "^GSPC",
  vix:        "^VIX",
  dxy:        "DX-Y.NYB",
  us10y:      "^TNX",
  breakeven5: "^T5YIE",
};

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json",
};

async function fetchYF(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const r = await fetch(url, { headers: YF_HEADERS });
  if (!r.ok) throw new Error(`YF ${symbol} ${r.status}`);
  const j = await r.json();
  const meta = j.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error(`YF ${symbol}: no price in response`);
  return {
    price: meta.regularMarketPrice,
    prev:  meta.chartPreviousClose ?? meta.regularMarketPrice,
  };
}

async function fetchCoinGecko() {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true";
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  return r.json();
}

// FRED — returns most recent non-missing observation value
// Requires FRED_API_KEY env var; returns null if key is absent (graceful fallback)
async function fetchFRED(seriesId) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&limit=10&sort_order=desc&file_type=json`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`FRED ${seriesId} ${r.status}`);
  const j = await r.json();
  // "." means missing (weekend/holiday); find most recent real value
  const obs = j.observations?.find(o => o.value !== ".");
  if (!obs) throw new Error(`FRED ${seriesId}: no valid observation`);
  return { value: parseFloat(obs.value), date: obs.date };
}

// FRED — returns array of recent non-missing observations (for YoY/MoM calcs)
async function fetchFREDObs(seriesId, limit = 15) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&limit=${limit}&sort_order=desc&file_type=json`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`FRED ${seriesId} ${r.status}`);
  const j = await r.json();
  return (j.observations ?? [])
    .filter(o => o.value !== ".")
    .map(o => ({ value: parseFloat(o.value), date: o.date }));
}

async function fetchFearGreed() {
  const r = await fetch("https://api.alternative.me/fng/?limit=1", {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`FearGreed ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const out = {};

  await Promise.allSettled([
    // Yahoo Finance symbols
    ...Object.entries(YF_SYMBOLS).map(([id, sym]) =>
      fetchYF(sym)
        .then(d => { out[id] = d; })
        .catch(() => {}) // silently skip; LLM will fall back
    ),

    // CoinGecko — BTC & ETH
    fetchCoinGecko()
      .then(j => {
        if (j.bitcoin)  out.btc = { price: j.bitcoin.usd,  change24h: j.bitcoin.usd_24h_change };
        if (j.ethereum) out.eth = { price: j.ethereum.usd, change24h: j.ethereum.usd_24h_change };
      })
      .catch(() => {}),

    // Alternative.me — Crypto Fear & Greed
    fetchFearGreed()
      .then(j => {
        const d = j.data?.[0];
        if (d) out.fear_greed = { value: +d.value, label: d.value_classification };
      })
      .catch(() => {}),

    // FRED — Fed Funds Target Rate upper bound (DFEDTARU)
    fetchFRED("DFEDTARU")
      .then(d => { if (d) out.ffr = d; })
      .catch(() => {}),

    // FRED — Unemployment Rate (UNRATE)
    fetchFRED("UNRATE")
      .then(d => { if (d) out.unemployment = d; })
      .catch(() => {}),

    // FRED — Core PCE Price Index → compute YoY and MoM (PCEPILFE, monthly)
    fetchFREDObs("PCEPILFE", 15)
      .then(obs => {
        if (!obs || obs.length < 2) return;
        const latest = obs[0];
        const prevMonth = obs[1];
        out.core_pce_mom = {
          value: parseFloat(((latest.value / prevMonth.value - 1) * 100).toFixed(2)),
          date: latest.date,
        };
        if (obs.length >= 13) {
          out.core_pce = {
            value: parseFloat(((latest.value / obs[12].value - 1) * 100).toFixed(2)),
            date: latest.date,
          };
        }
      })
      .catch(() => {}),

    // FRED — HY Credit Spreads with 4-week trend (BAMLH0A0HYM2, daily)
    // ~20 weekdays = 4 calendar weeks; change4w = leading signal (direction > level)
    fetchFREDObs("BAMLH0A0HYM2", 30)
      .then(obs => {
        if (!obs?.length) return;
        const current = obs[0];
        const prev4w  = obs[Math.min(19, obs.length - 1)];
        out.hy_spread = {
          value:    current.value,
          date:     current.date,
          prev4w:   prev4w.value,
          change4w: parseFloat((current.value - prev4w.value).toFixed(2)),
        };
      })
      .catch(() => {}),

    // FRED — Real 10Y Yield / TIPS (DFII10)
    fetchFRED("DFII10")
      .then(d => { if (d) out.real_yield = d; })
      .catch(() => {}),

    // FRED — 2Y-10Y Yield Curve (DGS2 + DGS10)
    Promise.all([
      fetchFRED("DGS2").catch(() => null),
      fetchFRED("DGS10").catch(() => null),
    ]).then(([y2, y10]) => {
      if (y2 && y10) {
        out.yield_curve = {
          spread: parseFloat((y10.value - y2.value).toFixed(2)),
          y2:     y2.value,
          y10:    y10.value,
        };
      }
    }),
  ]);

  // 10-minute cache hint for Vercel edge
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=60");
  return res.status(200).json(out);
}
