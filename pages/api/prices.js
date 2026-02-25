// Real-time price fetcher
// Yahoo Finance (no key) → SPX, VIX, DXY, 10Y Yield, 5Y Breakeven
// CoinGecko (no key)     → BTC, ETH
// Alternative.me (no key)→ Crypto Fear & Greed

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
  ]);

  // 10-minute cache hint for Vercel edge
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=60");
  return res.status(200).json(out);
}
