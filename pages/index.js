import Head from "next/head";
import { useState, useCallback, useMemo } from "react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ALLOC_MATRIX = {
  STRONG_BULL: { btc: 100, eth: 100, spy: 100, qqq: 100, gld: 50 },
  BULL:        { btc: 100, eth: 100, spy: 100, qqq: 100, gld: 75 },
  NEUTRAL:     { btc: 75,  eth: 70,  spy: 50,  qqq: 50,  gld: 100 },
  BEAR:        { btc: 25,  eth: 20,  spy: 0,   qqq: 0,   gld: 100 },
  STRONG_BEAR: { btc: 0,   eth: 0,   spy: 0,   qqq: 0,   gld: 100 },
};

// Refined palette — deep navy base, calibrated signal tones
const SIGNAL_CONFIG = {
  STRONG_BULL: { color: "#00d4a8", label: "STRONG BULL", range: "≥ +4",    action: "Max exposure. Full leverage acceptable." },
  BULL:        { color: "#00a876", label: "BULL",        range: "+2 to +3", action: "Full long. Maintain current leverage." },
  NEUTRAL:     { color: "#f0a020", label: "NEUTRAL",     range: "-1 to +1", action: "Reduce to half. No new leverage." },
  BEAR:        { color: "#e07848", label: "BEAR",        range: "-2 to -3", action: "Exit equities. BTC to 25%. Reduce Aave debt." },
  STRONG_BEAR: { color: "#e03058", label: "STRONG BEAR", range: "≤ -4",    action: "Full cash + gold. Deleverage Aave immediately." },
};

const SC = {
  strong_bull: "#00d4a8",
  bull:        "#00a876",
  neutral:     "#f0a020",
  bear:        "#e07848",
  strong_bear: "#e03058",
};

function getSignalKey(c) {
  if (c >= 4)  return "STRONG_BULL";
  if (c >= 2)  return "BULL";
  if (c >= -1) return "NEUTRAL";
  if (c >= -3) return "BEAR";
  return "STRONG_BEAR";
}

// ─── API CONFIG ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  {
    id: "markets", name: "MARKETS & PRICES", weight: "Feeds: Sentiment dimension",
    indicators: [
      { id: "spx",    name: "S&P 500",        query: "S&P 500 index price today" },
      { id: "ndx",    name: "Nasdaq 100",      query: "Nasdaq 100 index price today" },
      { id: "vix",    name: "VIX",             query: "VIX volatility index today" },
      { id: "dxy",    name: "DXY",             query: "US Dollar Index DXY today" },
      { id: "gold",   name: "Gold",            query: "gold price per ounce today" },
      { id: "us2y",   name: "2Y Yield",        query: "2 year US treasury yield today" },
      { id: "us10y",  name: "10Y Yield",       query: "10 year US treasury yield today" },
      { id: "spread", name: "2s10s Spread",    query: "2s10s yield curve spread today 2026" },
    ],
  },
  {
    id: "crypto", name: "CRYPTO", weight: "Feeds: Crypto Sentiment overlay",
    indicators: [
      { id: "btc",        name: "Bitcoin",         query: "Bitcoin BTC price today" },
      { id: "eth",        name: "Ethereum",        query: "Ethereum ETH price today" },
      { id: "btcdom",     name: "BTC Dominance",   query: "Bitcoin dominance percentage today 2026" },
      { id: "etf_flows",  name: "BTC ETF Flows",   query: "Bitcoin spot ETF net flows this week 2026" },
      { id: "funding",    name: "Funding Rate",    query: "Bitcoin perpetual funding rate today 2026" },
      { id: "eth_etf",    name: "ETH Staking ETF", query: "BlackRock Ethereum staking ETF approval 2026" },
      { id: "fear_greed", name: "Fear & Greed",    query: "crypto fear and greed index today 2026" },
    ],
  },
  {
    id: "liquidity", name: "GLOBAL LIQUIDITY", weight: "Core dimension: Liquidity",
    indicators: [
      { id: "fed_bs",    name: "Fed Balance Sheet", query: "Federal Reserve balance sheet total assets latest 2026" },
      { id: "rrp",       name: "Reverse Repo",      query: "Federal Reserve reverse repo balance latest 2026" },
      { id: "tga",       name: "TGA",               query: "Treasury General Account TGA balance latest 2026" },
      { id: "us_m2",     name: "US M2 YoY",         query: "US M2 money supply year over year growth latest 2026" },
      { id: "net_liq",   name: "Net Liquidity",     query: "US net liquidity Fed balance sheet minus TGA minus RRP 2026" },
      { id: "ecb_bs",    name: "ECB Balance Sheet", query: "ECB balance sheet total assets latest 2026" },
      { id: "boj_bs",    name: "BOJ Balance Sheet", query: "Bank of Japan balance sheet latest 2026" },
      { id: "pboc",      name: "PBOC Assets",       query: "PBOC total assets latest 2026" },
      { id: "global_m2", name: "Global M2",         query: "global M2 money supply USD terms latest 2026" },
    ],
  },
  {
    id: "fed", name: "FED POLICY", weight: "Core dimension: Monetary",
    indicators: [
      { id: "ffr",       name: "Fed Funds Rate",   query: "current federal funds rate 2026" },
      { id: "next_fomc", name: "Next FOMC",        query: "next FOMC meeting date rate decision 2026" },
      { id: "cut_prob",  name: "Cut Probability",  query: "CME FedWatch rate cut probability next meeting 2026" },
      { id: "cuts_2026", name: "2026 Cuts Priced", query: "total Fed rate cuts priced 2026 futures" },
      { id: "fed_chair", name: "Fed Chair",        query: "Kevin Warsh Fed chair transition 2026" },
    ],
  },
  {
    id: "inflation", name: "INFLATION", weight: "Core dimension: Inflation",
    indicators: [
      { id: "cpi",          name: "CPI YoY",        query: "latest CPI headline year over year 2026" },
      { id: "core_cpi",     name: "Core CPI YoY",   query: "latest core CPI year over year 2026" },
      { id: "pce",          name: "PCE YoY",        query: "latest PCE price index year over year 2026" },
      { id: "core_pce",     name: "Core PCE YoY ⚡", query: "latest core PCE year over year 2026" },
      { id: "core_pce_mom", name: "Core PCE MoM",   query: "latest core PCE month over month 2026" },
      { id: "breakeven5",   name: "5Y Breakeven",   query: "5 year breakeven inflation rate 2026" },
    ],
  },
  {
    id: "growth", name: "GROWTH & LABOR", weight: "Core dimension: Growth",
    indicators: [
      { id: "gdp",          name: "GDP",             query: "latest US GDP growth rate 2026" },
      { id: "unemployment", name: "Unemployment",    query: "US unemployment rate latest 2026" },
      { id: "nfp",          name: "Nonfarm Payrolls",query: "latest nonfarm payrolls 2026" },
      { id: "claims",       name: "Jobless Claims",  query: "latest initial jobless claims 2026" },
      { id: "pmi",          name: "PMI Composite",   query: "US PMI composite latest 2026" },
    ],
  },
  {
    id: "geopolitical", name: "GEOPOLITICAL", weight: "Modifier: can shift ±1",
    indicators: [
      { id: "tariffs",  name: "Tariff Status", query: "US tariff policy status 2026" },
      { id: "china",    name: "US-China",      query: "US China trade tensions 2026" },
      { id: "conflict", name: "Conflict Risk", query: "geopolitical conflict risk Iran Middle East 2026" },
    ],
  },
];

const API_SYSTEM =
  "You are a quant macro analyst. Return ONLY valid JSON. No markdown, no backticks, no text outside the JSON.";

const API_PROMPT = `You are a macro-quant analyst scoring a 6-dimension regime model. Search the web for latest data on every indicator below, then produce scores.

THE 6 DIMENSIONS (each scored -1, 0, or +1):

1. MONETARY: Fed policy stance. Cutting/dovish=+1, Pause/mixed=0, Hiking/hawkish=-1
2. INFLATION: Trend direction. Cooling toward 2%=+1, Sticky/mixed=0, Reaccelerating=-1
3. GROWTH: Economic momentum. PMI expanding/jobs strong=+1, Mixed=0, Contracting/recession risk=-1
4. LIQUIDITY: Net liquidity conditions. Fed BS expanding/RRP draining/M2 growing/global CBs easing=+1, Mixed=0, QT/TGA building/M2 contracting=-1
5. DOLLAR: DXY direction. Weakening=+1 (bullish risk assets), Stable=0, Strengthening=-1
6. SENTIMENT: Risk appetite. VIX<15/spreads tight/flows positive=+1, Mixed=0, VIX>25/spreads wide/capitulation=-1

CRYPTO SENTIMENT OVERLAY (separate from macro, scored -2 to +2):
Score based on: BTC ETF flows, funding rates, fear&greed index, exchange reserves, BTC dominance trend.
+2: Extreme greed + massive inflows + positive funding
+1: Positive flows + neutral-to-positive sentiment
0: Mixed signals
-1: Outflows + fear + negative funding
-2: Capitulation + extreme fear + massive outflows

Return this JSON:
{
  "dimensions": {
    "monetary":  { "score": <-1|0|1>, "rationale": "<1 line>" },
    "inflation": { "score": <-1|0|1>, "rationale": "<1 line>" },
    "growth":    { "score": <-1|0|1>, "rationale": "<1 line>" },
    "liquidity": { "score": <-1|0|1>, "rationale": "<1 line>" },
    "dollar":    { "score": <-1|0|1>, "rationale": "<1 line>" },
    "sentiment": { "score": <-1|0|1>, "rationale": "<1 line>" }
  },
  "crypto_sentiment": { "score": <-2 to +2>, "rationale": "<1 line>" },
  "composite": <sum of 6 dimensions, range -6 to +6>,
  "indicators": {
    "<indicator_id>": {
      "value": "<number with units>",
      "trend": "<1 word>",
      "signal": "<strong_bull|bull|neutral|bear|strong_bear>",
      "note": "<1 sentence>"
    }
  },
  "regime": {
    "monetary":  { "state": "<SHORT LABEL>", "signal": "<bull|bear|neutral>", "detail": "<1 line>" },
    "fiscal":    { "state": "...", "signal": "...", "detail": "..." },
    "inflation": { "state": "...", "signal": "...", "detail": "..." },
    "growth":    { "state": "...", "signal": "...", "detail": "..." },
    "liquidity": { "state": "...", "signal": "...", "detail": "..." },
    "sentiment": { "state": "...", "signal": "...", "detail": "..." }
  },
  "liquidity_narrative": "<2-3 sentences>",
  "composite_narrative": "<2-3 sentences>",
  "trade_actions": "<2-3 sentences>",
  "key_dates": [
    { "date": "<MMM D>", "event": "<desc>", "importance": "<critical|high|medium>" }
  ],
  "aave_guidance": "<1-2 sentences>",
  "updated": "<today's date>"
}

INDICATORS TO SEARCH:
`;

// ─── STYLES ───────────────────────────────────────────────────────────────────
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700;800&family=Instrument+Sans:wght@700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body { background: #070d1a; }

  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-thumb { background: #1d2f4a; border-radius: 2px; }

  @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:.3} }
  @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }

  .data-section { animation: fadeIn 0.4s ease; }

  .scan-btn {
    background: linear-gradient(135deg, #091f15 0%, #071610 100%);
    border: 1px solid #1a4530;
    color: #00d4a8;
    padding: 13px 44px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 2px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.2s, box-shadow 0.2s;
    min-height: 46px;
  }
  .scan-btn:hover:not(:disabled) {
    border-color: #00d4a845;
    box-shadow: 0 0 28px #00d4a810, 0 0 8px #00d4a808;
  }
  .scan-btn:disabled { background: #0b1525; border-color: #1d2f4a; color: #253a55; cursor: not-allowed; }

  /* Responsive grids */
  .dim-grid    { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
  .pos-grid    { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .regime-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .dash-header { display: flex; justify-content: space-between; align-items: flex-start; }
  .gauge-num   { font-size: 52px; }

  @media (max-width: 640px) {
    .dim-grid    { grid-template-columns: repeat(3, 1fr); }
    .pos-grid    { grid-template-columns: repeat(3, 1fr); }
    .regime-grid { grid-template-columns: repeat(2, 1fr); }
    .dash-header { flex-direction: column; gap: 6px; }
    .gauge-num   { font-size: 34px !important; }
    .scan-btn    { width: 100%; padding: 14px; }
    .gauge-sub   { font-size: 10px !important; flex-direction: column; gap: 2px; align-items: center; }
  }
  @media (max-width: 400px) {
    .dim-grid { grid-template-columns: repeat(2, 1fr); }
    .pos-grid { grid-template-columns: repeat(2, 1fr); }
  }
`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const scoreColor = (s) => s > 0 ? "#00a876" : s < 0 ? "#e07848" : "#f0a020";
const scoreLabel = (s) => s > 0 ? "+1" : s < 0 ? "-1" : "0";
const regCol = { bull: "#00a876", bear: "#e07848", neutral: "#f0a020" };

// Card wrapper
function Card({ children, style, accent }) {
  return (
    <div style={{
      background: "#0b1525",
      border: `1px solid ${accent ? `${accent}20` : "#1d2f4a"}`,
      borderRadius: 8,
      padding: 16,
      marginBottom: 10,
      ...style,
    }}>
      {children}
    </div>
  );
}

function CardHeader({ children, color = "#3a5070" }) {
  return (
    <div style={{
      fontSize: 9, letterSpacing: 2, color, fontWeight: 700,
      marginBottom: 12, borderBottom: "1px solid #1d2f4a", paddingBottom: 9,
    }}>
      {children}
    </div>
  );
}

function Dot({ signal, size = 7 }) {
  const c = SC[signal] || "#f0a020";
  return (
    <span style={{
      display: "inline-block", width: size, height: size, borderRadius: "50%",
      background: c, boxShadow: `0 0 ${size + 3}px ${c}55`, flexShrink: 0,
    }} />
  );
}

// ─── DIMENSION BAR ───────────────────────────────────────────────────────────
function DimensionBar({ dimensions, cryptoSentiment }) {
  if (!dimensions) return null;
  const dims = [
    { key: "monetary",  label: "MON" },
    { key: "inflation", label: "INF" },
    { key: "growth",    label: "GRO" },
    { key: "liquidity", label: "LIQ" },
    { key: "dollar",    label: "USD" },
    { key: "sentiment", label: "SEN" },
  ];

  return (
    <Card>
      <CardHeader>6-DIMENSION REGIME SCORING</CardHeader>
      <div className="dim-grid">
        {dims.map((d) => {
          const dim = dimensions[d.key];
          if (!dim) return null;
          const c = scoreColor(dim.score);
          return (
            <div key={d.key} style={{
              textAlign: "center", background: "#0f1e36", borderRadius: 6,
              padding: "10px 4px", border: `1px solid ${c}18`,
            }}>
              <div style={{ fontSize: 8, color: "#3a5070", letterSpacing: 1.5 }}>{d.label}</div>
              <div style={{
                fontSize: 22, fontWeight: 800, color: c, lineHeight: 1.1,
                fontFamily: "'Instrument Sans', sans-serif", margin: "3px 0",
              }}>
                {scoreLabel(dim.score)}
              </div>
              <div style={{ fontSize: 8, color: "#4a6282", lineHeight: 1.35, minHeight: 22 }}>
                {dim.rationale}
              </div>
            </div>
          );
        })}
      </div>

      {cryptoSentiment && (
        <div style={{
          marginTop: 10, padding: "10px 12px", background: "#0f1e36", borderRadius: 6,
          border: `1px solid ${scoreColor(cryptoSentiment.score)}18`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          flexWrap: "wrap", gap: 6,
        }}>
          <div>
            <span style={{ fontSize: 9, color: "#3a5070", letterSpacing: 1.5 }}>CRYPTO SENTIMENT OVERLAY</span>
            <span style={{ fontSize: 8, color: "#1f3050", marginLeft: 8 }}>(modifies BTC/ETH allocation)</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 9, color: "#4a6282" }}>{cryptoSentiment.rationale}</span>
            <span style={{
              fontSize: 18, fontWeight: 800, color: scoreColor(cryptoSentiment.score),
              fontFamily: "'Instrument Sans', sans-serif",
            }}>
              {cryptoSentiment.score > 0 ? "+" : ""}{cryptoSentiment.score}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── COMPOSITE GAUGE ─────────────────────────────────────────────────────────
function CompositeGauge({ composite, narrative, signalKey }) {
  if (composite === null || composite === undefined) return null;
  const cfg = SIGNAL_CONFIG[signalKey];
  const pct = ((composite + 6) / 12) * 100;

  return (
    <div style={{ textAlign: "center", padding: "26px 0 18px" }}>
      <div style={{ fontSize: 9, letterSpacing: 3, color: "#2d4560", marginBottom: 8 }}>
        COMPOSITE REGIME SIGNAL
      </div>
      <div
        className="gauge-num"
        style={{
          fontWeight: 800, color: cfg.color, letterSpacing: -1,
          fontFamily: "'Instrument Sans', sans-serif", lineHeight: 1,
          textShadow: `0 0 50px ${cfg.color}28`,
        }}
      >
        {cfg.label}
      </div>

      <div
        className="gauge-sub"
        style={{ fontSize: 11, color: "#4a6282", marginTop: 8, display: "flex", justifyContent: "center", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      >
        <span>
          Composite:{" "}
          <span style={{ color: cfg.color, fontWeight: 700 }}>
            {composite > 0 ? "+" : ""}{composite}
          </span>{" "}
          / ±6
        </span>
        <span style={{ color: "#1d2f4a" }}>|</span>
        <span style={{ color: "#5a7898" }}>{cfg.action}</span>
      </div>

      {narrative && (
        <div style={{
          fontSize: 11, color: "#5a7898", marginTop: 12, lineHeight: 1.85,
          maxWidth: 620, margin: "12px auto 0",
        }}>
          {narrative}
        </div>
      )}

      {/* Gauge track */}
      <div style={{ margin: "20px auto 0", maxWidth: 500, padding: "0 16px" }}>
        <div style={{
          position: "relative", height: 6, borderRadius: 3,
          background: "linear-gradient(90deg, #e03058 0%, #e07848 22%, #f0a020 44%, #f0a020 56%, #00a876 78%, #00d4a8 100%)",
          boxShadow: "0 1px 8px #0006",
        }}>
          <div style={{
            position: "absolute", top: -5, left: `${Math.max(3, Math.min(97, pct))}%`,
            transform: "translateX(-50%)", width: 16, height: 16,
            background: cfg.color, borderRadius: "50%",
            border: "3px solid #070d1a",
            boxShadow: `0 0 14px ${cfg.color}80, 0 0 5px ${cfg.color}`,
            transition: "left 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
          }} />
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between",
          marginTop: 7, fontSize: 8, color: "#1f3050", letterSpacing: 1,
        }}>
          <span>−6 BEAR</span><span>0</span><span>BULL +6</span>
        </div>
      </div>
    </div>
  );
}

// ─── POSITION TABLE ───────────────────────────────────────────────────────────
function PositionTable({ signalKey, cryptoScore }) {
  if (!signalKey) return null;
  const allocs = ALLOC_MATRIX[signalKey];
  const assets = [
    { key: "btc", label: "BTC", color: "#f7931a" },
    { key: "eth", label: "ETH", color: "#8fa8f8" },
    { key: "spy", label: "SPY", color: "#00a876" },
    { key: "qqq", label: "QQQ", color: "#9c80f8" },
    { key: "gld", label: "GLD", color: "#e8c040" },
  ];
  const cryptoMod = cryptoScore || 0;

  return (
    <Card>
      <CardHeader>TARGET ALLOCATION — {SIGNAL_CONFIG[signalKey].label} REGIME</CardHeader>
      <div className="pos-grid">
        {assets.map((a) => {
          let base = allocs[a.key];
          let adjusted = base;
          if ((a.key === "btc" || a.key === "eth") && cryptoMod !== 0) {
            adjusted = Math.max(0, Math.min(100, base + cryptoMod * 15));
          }
          const isModified = adjusted !== base;
          return (
            <div key={a.key} style={{
              textAlign: "center", background: "#0f1e36", borderRadius: 6,
              padding: "12px 6px", border: `1px solid ${a.color}18`,
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: a.color, letterSpacing: 0.5 }}>{a.label}</div>
              <div style={{
                fontSize: 28, fontWeight: 800, lineHeight: 1,
                color: adjusted > 0 ? "#c5d5ee" : "#1f3050",
                margin: "6px 0",
                fontFamily: "'Instrument Sans', sans-serif",
              }}>
                {adjusted}%
              </div>
              {isModified && (
                <div style={{ fontSize: 8, color: cryptoMod > 0 ? "#00a876" : "#e07848", marginBottom: 4 }}>
                  base {base}% {cryptoMod > 0 ? "↑" : "↓"} overlay
                </div>
              )}
              <div style={{ width: "100%", height: 3, background: "#1d2f4a", borderRadius: 2, marginTop: 6 }}>
                <div style={{
                  width: `${adjusted}%`, height: "100%",
                  background: adjusted > 0 ? a.color : "#1d2f4a",
                  borderRadius: 2, transition: "width 0.4s ease",
                }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 9, color: "#253a55", marginTop: 10, textAlign: "center" }}>
        Crypto overlay shifts BTC/ETH ±15% per sentiment point · Cash portion earns T-bill rate
      </div>
    </Card>
  );
}

// ─── AAVE BOX ────────────────────────────────────────────────────────────────
function AaveBox({ guidance }) {
  if (!guidance) return null;
  return (
    <Card accent="#9c80f8">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, borderBottom: "1px solid #1d2f4a", paddingBottom: 9 }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#9c80f8", fontWeight: 700 }}>AAVE POSITION GUIDANCE</span>
        <span style={{ fontSize: 8, color: "#253a55" }}>wstETH / USDC</span>
      </div>
      <div style={{ fontSize: 11, color: "#7a90a8", lineHeight: 1.85 }}>{guidance}</div>
    </Card>
  );
}

// ─── TRADE ACTIONS ────────────────────────────────────────────────────────────
function TradeActions({ actions }) {
  if (!actions) return null;
  return (
    <div style={{
      background: "#08180f", border: "1px solid #00a87625",
      borderRadius: 8, padding: 16, marginBottom: 10,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: 2, color: "#00a876", fontWeight: 700,
        marginBottom: 10, borderBottom: "1px solid #0f2820", paddingBottom: 9,
      }}>
        THIS WEEK&apos;S ACTIONS
      </div>
      <div style={{ fontSize: 11, color: "#85a896", lineHeight: 1.85 }}>{actions}</div>
    </div>
  );
}

// ─── REGIME BOXES ─────────────────────────────────────────────────────────────
function Regimes({ regime }) {
  if (!regime) return null;
  return (
    <div className="regime-grid" style={{ marginBottom: 10 }}>
      {Object.entries(regime).map(([k, r]) => {
        const c = regCol[r.signal] || "#f0a020";
        return (
          <div key={k} style={{
            background: "#0b1525", padding: "10px 12px", borderRadius: 7,
            borderLeft: `3px solid ${c}`,
          }}>
            <div style={{ fontSize: 8, color: "#2d4560", letterSpacing: 1.5, textTransform: "uppercase" }}>{k}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: c, marginTop: 3, lineHeight: 1 }}>{r.state}</div>
            <div style={{ fontSize: 9, color: "#3a5272", marginTop: 4, lineHeight: 1.45 }}>{r.detail}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── LIQUIDITY BOX ───────────────────────────────────────────────────────────
function LiqBox({ text }) {
  if (!text) return null;
  return (
    <Card>
      <CardHeader>GLOBAL LIQUIDITY DECOMPOSITION</CardHeader>
      <div style={{ fontSize: 11, color: "#5a7898", lineHeight: 1.85 }}>{text}</div>
    </Card>
  );
}

// ─── KEY DATES ────────────────────────────────────────────────────────────────
function KeyDates({ dates }) {
  if (!dates?.length) return null;
  const ic = { critical: "#e03058", high: "#f0a020", medium: "#3a5272" };
  return (
    <Card>
      <CardHeader>UPCOMING CATALYSTS</CardHeader>
      {dates.map((d, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "5px 0",
          borderBottom: i < dates.length - 1 ? "1px solid #0f1e30" : "none",
        }}>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
            background: `${ic[d.importance] || "#3a5272"}15`,
            color: ic[d.importance] || "#3a5272",
            letterSpacing: 0.5, minWidth: 52, textAlign: "center",
          }}>
            {d.date}
          </span>
          <span style={{ fontSize: 10, color: "#7a90a8" }}>{d.event}</span>
        </div>
      ))}
    </Card>
  );
}

// ─── INDICATOR SECTION ────────────────────────────────────────────────────────
const SCORES_MAP = { strong_bull: 2, bull: 1, neutral: 0, bear: -1, strong_bear: -2 };

function Section({ category, indicators }) {
  if (!indicators) return null;
  const items = category.indicators
    .map((ind) => ({ ...ind, data: indicators[ind.id] }))
    .filter((i) => i.data);
  if (!items.length) return null;

  const sc = items.reduce((s, i) => s + (SCORES_MAP[i.data.signal] ?? 0), 0);
  const mx = items.length * 2;
  const p = ((sc + mx) / (mx * 2)) * 100;
  let sl, sclr;
  if (p > 62)      { sl = "BULL";  sclr = "#00a876"; }
  else if (p > 38) { sl = "MIXED"; sclr = "#f0a020"; }
  else             { sl = "BEAR";  sclr = "#e07848"; }

  return (
    <div style={{
      background: "#0b1525", border: "1px solid #1d2f4a",
      borderRadius: 8, padding: "12px 14px", marginBottom: 8,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        borderBottom: "1px solid #1d2f4a", paddingBottom: 9, marginBottom: 9,
        flexWrap: "wrap", gap: 6,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, letterSpacing: 2, color: "#4a6282", fontWeight: 700 }}>{category.name}</span>
          {category.weight && <span style={{ fontSize: 8, color: "#1f3050" }}>{category.weight}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 10, color: "#2d4560" }}>{sc > 0 ? "+" : ""}{sc}</span>
          <span style={{
            fontSize: 8, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
            background: `${sclr}12`, color: sclr, letterSpacing: 1,
          }}>
            {sl}
          </span>
        </div>
      </div>

      {items.map((item) => (
        <div key={item.id} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "5px 0", borderBottom: "1px solid #0c1828",
        }}>
          <div style={{ flex: 1, minWidth: 0, paddingRight: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "#a0b8d0" }}>{item.name}</span>
              <span style={{ fontSize: 10, color: "#4a6282", fontWeight: 600 }}>{item.data.value}</span>
            </div>
            <div style={{ fontSize: 8, color: "#253a52", marginTop: 2, lineHeight: 1.4 }}>{item.data.note}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 9, color: SC[item.data.signal] || "#f0a020" }}>{item.data.trend}</span>
            <Dot signal={item.data.signal} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── RULES REFERENCE ─────────────────────────────────────────────────────────
function RulesRef() {
  return (
    <Card>
      <CardHeader>TRADING RULES (BACKTESTED)</CardHeader>
      <div style={{ fontSize: 9, lineHeight: 2.3 }}>
        {[
          { color: "#00d4a8", label: "STRONG BULL (≥+4):", rule: "Max exposure all risk assets. Leverage acceptable. Gold 50%. Aave: maintain or increase debt." },
          { color: "#00a876", label: "BULL (+2 to +3):",   rule: "Full long all assets. Maintain leverage. Gold 75%. Aave: hold current position." },
          { color: "#f0a020", label: "NEUTRAL (-1 to +1):",rule: "SPY/QQQ to 50%. BTC/ETH to 75% (asymmetric upside). Gold full. No new leverage. Aave: consider partial repay." },
          { color: "#e07848", label: "BEAR (-2 to -3):",   rule: "Exit equities. BTC 25%, ETH 20%. Gold 100%. Aave: repay $200K+ debt immediately." },
          { color: "#e03058", label: "STRONG BEAR (≤-4):", rule: "Full cash + gold. Zero crypto. Aave: deleverage to <$400K debt or fully repay." },
        ].map((r) => (
          <div key={r.label} style={{ marginBottom: 4 }}>
            <span style={{ color: r.color }}>■</span>{" "}
            <strong style={{ color: "#5a7898" }}>{r.label}</strong>{" "}
            <span style={{ color: "#3a5272" }}>{r.rule}</span>
          </div>
        ))}
        <div style={{ color: "#253a52", marginTop: 6 }}>
          Crypto Overlay: BTC/ETH allocation shifts ±15% per crypto sentiment point.
          Review weekly. Rebalance on signal change, not on calendar.
        </div>
      </div>
    </Card>
  );
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const [data, setData]               = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [progress, setProgress]       = useState("");
  const [lastFetched, setLastFetched] = useState(null);

  const signalKey = useMemo(() => {
    if (data?.composite == null) return null;
    return getSignalKey(data.composite);
  }, [data]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setProgress("Searching 45+ indicators…");

    const allInds = CATEGORIES.flatMap((c) =>
      c.indicators.map((i) => `- ${i.id}: ${i.name} → "${i.query}"`)
    );
    const prompt = API_PROMPT + allInds.join("\n");

    try {
      setProgress("Querying live market data…");
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, system: API_SYSTEM }),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      setProgress("Computing regime signals…");
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      const text = result.text || "";
      let json = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const f = json.indexOf("{"), l = json.lastIndexOf("}");
      if (f !== -1 && l !== -1) json = json.slice(f, l + 1);
      setData(JSON.parse(json));
      setLastFetched(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProgress("");
    }
  }, []);

  return (
    <>
      <Head>
        <title>Macro Regime Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5" />
        <meta name="theme-color" content="#070d1a" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>
      <style>{STYLES}</style>

      <div style={{
        minHeight: "100vh", background: "#070d1a", color: "#a0b8d0",
        fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
        padding: "16px 14px", maxWidth: 900, margin: "0 auto",
      }}>
        {/* Header */}
        <div className="dash-header" style={{ marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 8, letterSpacing: 4, color: "#1d2f4a" }}>MACRO REGIME</div>
            <div style={{
              fontSize: 22, fontWeight: 800, letterSpacing: -0.5,
              fontFamily: "'Instrument Sans', sans-serif", color: "#eaf0ff",
            }}>
              TRADING DASHBOARD
            </div>
            <div style={{ fontSize: 9, color: "#1f3050", marginTop: 3 }}>
              6-dimension scoring · backtested Jan 2018 – Dec 2025 · weekly cadence
            </div>
          </div>
          {lastFetched && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 8, color: "#1d2f4a", letterSpacing: 1 }}>LAST SCAN</div>
              <div style={{ fontSize: 10, color: "#2d4560" }}>{lastFetched.toLocaleString()}</div>
            </div>
          )}
        </div>

        {/* Signal Legend */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", padding: "8px 0 10px", flexWrap: "wrap" }}>
          {Object.entries(SIGNAL_CONFIG).map(([k, v]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{
                display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                background: v.color, boxShadow: `0 0 5px ${v.color}55`,
              }} />
              <span style={{ fontSize: 8, color: "#253a55" }}>{v.label} ({v.range})</span>
            </div>
          ))}
        </div>

        {/* Scan Button */}
        <div style={{ textAlign: "center", padding: "10px 0 16px" }}>
          <button className="scan-btn" onClick={fetchData} disabled={loading}>
            {loading ? "SCANNING…" : data ? "REFRESH SCAN" : "RUN WEEKLY SCAN"}
          </button>
          {loading && progress && (
            <div style={{ fontSize: 9, color: "#253a55", marginTop: 8, animation: "pulse 1.5s infinite" }}>
              {progress}
            </div>
          )}
          {error && (
            <div style={{ fontSize: 10, color: "#e03058", marginTop: 8 }}>Error: {error}</div>
          )}
          {!data && !loading && (
            <div style={{ fontSize: 9, color: "#1d2f4a", marginTop: 8 }}>
              Searches 45+ indicators · scores 6 dimensions + crypto overlay · outputs position sizing
            </div>
          )}
        </div>

        {/* Data */}
        {data && (
          <div className="data-section">
            <CompositeGauge composite={data.composite} narrative={data.composite_narrative} signalKey={signalKey} />
            <TradeActions actions={data.trade_actions} />
            <PositionTable signalKey={signalKey} cryptoScore={data.crypto_sentiment?.score} />
            <AaveBox guidance={data.aave_guidance} />
            <DimensionBar dimensions={data.dimensions} cryptoSentiment={data.crypto_sentiment} />
            <Regimes regime={data.regime} />
            <LiqBox text={data.liquidity_narrative} />
            <KeyDates dates={data.key_dates} />
            {CATEGORIES.map((c) => (
              <Section key={c.id} category={c} indicators={data.indicators} />
            ))}
            <RulesRef />
            <div style={{ textAlign: "center", padding: "14px 0 8px", fontSize: 7, color: "#0f1e30", letterSpacing: 2 }}>
              BACKTESTED FRAMEWORK — HYPOTHETICAL — NOT FINANCIAL ADVICE
            </div>
          </div>
        )}
      </div>
    </>
  );
}
