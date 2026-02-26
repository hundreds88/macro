import Head from "next/head";
import { useState, useCallback, useMemo, useEffect } from "react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ALLOC_MATRIX = {
  STRONG_BULL: { btc: 100, eth: 100, spy: 100, qqq: 100, gld: 50 },
  BULL:        { btc: 100, eth: 100, spy: 100, qqq: 100, gld: 75 },
  NEUTRAL:     { btc: 75,  eth: 70,  spy: 50,  qqq: 50,  gld: 100 },
  BEAR:        { btc: 25,  eth: 20,  spy: 0,   qqq: 0,   gld: 100 },
  STRONG_BEAR: { btc: 0,   eth: 0,   spy: 0,   qqq: 0,   gld: 100 },
};

// Futuristic high-contrast neon palette
const SIGNAL_CONFIG = {
  STRONG_BULL: { color: "#00ffd0", label: "STRONG BULL", range: "≥ +4",    action: "Max exposure. Full leverage acceptable." },
  BULL:        { color: "#00e890", label: "BULL",        range: "+2 to +3", action: "Full long. Maintain current leverage." },
  NEUTRAL:     { color: "#ffcc00", label: "NEUTRAL",     range: "-1 to +1", action: "Reduce to half. No new leverage." },
  BEAR:        { color: "#ff7040", label: "BEAR",        range: "-2 to -3", action: "Exit equities. BTC to 25%. Reduce Aave debt." },
  STRONG_BEAR: { color: "#ff2255", label: "STRONG BEAR", range: "≤ -4",    action: "Full cash + gold. Deleverage Aave immediately." },
};

const SC = {
  strong_bull: "#00ffd0",
  bull:        "#00e890",
  neutral:     "#ffcc00",
  bear:        "#ff7040",
  strong_bear: "#ff2255",
};

function getSignalKey(c) {
  if (c >= 4)  return "STRONG_BULL";
  if (c >= 2)  return "BULL";
  if (c >= -1) return "NEUTRAL";
  if (c >= -3) return "BEAR";
  return "STRONG_BEAR";
}

// ─── WEIGHTED SCORING ─────────────────────────────────────────────────────────
// Monetary dominates; Dollar is least predictive for this portfolio
const DIM_WEIGHTS   = { monetary: 2.0, inflation: 1.5, growth: 1.5, liquidity: 1.0, sentiment: 0.75, dollar: 0.5 };
const MAX_WEIGHTED  = Object.values(DIM_WEIGHTS).reduce((a, b) => a + b, 0); // 7.25

function computeWeightedComposite(dimensions) {
  if (!dimensions) return null;
  let sum = 0;
  for (const [dim, w] of Object.entries(DIM_WEIGHTS)) sum += (dimensions[dim]?.score ?? 0) * w;
  return Math.round((sum / MAX_WEIGHTED) * 6); // normalize to -6..+6
}

// ─── SCAN HISTORY ─────────────────────────────────────────────────────────────
const HISTORY_KEY = "macro_regime_history";
const MAX_HISTORY = 12; // ~3 months of weekly scans

// ─── CONFIRMATION PROTOCOL ───────────────────────────────────────────────────
// prevHistory = history.slice(1) — excludes the just-added current scan
function getConfirmation(prevHistory, currentKey) {
  if (!prevHistory?.length) return null;
  const prevKey = getSignalKey(prevHistory[0].weighted ?? prevHistory[0].raw ?? 0);
  if (prevKey !== currentKey) return { confirmed: false, streak: 1, isNew: true, prevKey };
  let streak = 2;
  for (let i = 1; i < prevHistory.length; i++) {
    if (getSignalKey(prevHistory[i].weighted ?? prevHistory[i].raw ?? 0) === currentKey) streak++;
    else break;
  }
  return { confirmed: true, streak, isNew: false };
}

// ─── HARD OVERRIDES ───────────────────────────────────────────────────────────
function getOverrides(livePrices) {
  const out = [];
  const vix = livePrices?.vix?.price;
  if (vix > 30)  out.push({ type: "BEAR",         label: `VIX ${vix.toFixed(1)} > 30`,              msg: "Force BEAR sizing" });
  const hy = livePrices?.hy_spread?.value;
  if (hy > 5.0)  out.push({ type: "BEAR",         label: `HY Spreads ${hy.toFixed(2)}% > 500bp`,   msg: "Force BEAR sizing" });
  const ry = livePrices?.real_yield?.value;
  if (ry > 3.0)  out.push({ type: "CRYPTO_REDUCE", label: `Real Yield ${ry.toFixed(2)}% > 3.0%`,   msg: "−30% crypto allocation" });
  return out;
}

// ─── API CONFIG ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  {
    id: "markets", name: "MARKETS & PRICES", weight: "Feeds: Sentiment dimension",
    indicators: [
      { id: "spx",       name: "S&P 500",      query: "S&P 500 price today" },
      { id: "vix",       name: "VIX",          query: "VIX index today" },
      { id: "dxy",       name: "DXY",          query: "US Dollar Index today" },
      { id: "us10y",     name: "10Y Yield",    query: "10-year treasury yield today" },
      { id: "hy_spread", name: "HY Spreads",   query: "ICE BofA US high yield OAS credit spread 2026" },
    ],
  },
  {
    id: "crypto", name: "CRYPTO", weight: "Feeds: Crypto Sentiment overlay",
    indicators: [
      { id: "btc",        name: "Bitcoin",         query: "Bitcoin price today" },
      { id: "eth",        name: "Ethereum",        query: "Ethereum price today" },
      { id: "btc_mvrv",  name: "BTC MVRV ⚡",     query: "Bitcoin MVRV ratio on-chain 2026" },
      { id: "etf_flows",  name: "BTC ETF Flows",   query: "Bitcoin ETF net flows this week 2026" },
      { id: "funding",    name: "Funding Rate",    query: "Bitcoin perpetual funding rate 2026" },
      { id: "fear_greed", name: "Fear & Greed",    query: "crypto fear greed index 2026" },
    ],
  },
  {
    id: "liquidity", name: "GLOBAL LIQUIDITY", weight: "Core dimension: Liquidity",
    indicators: [
      { id: "fed_bs",    name: "Fed Balance Sheet", query: "Fed balance sheet total assets 2026" },
      { id: "rrp",       name: "Reverse Repo",      query: "Fed reverse repo balance 2026" },
      { id: "tga",       name: "TGA",               query: "Treasury General Account balance 2026" },
      { id: "global_m2", name: "Global M2 ⚡",      query: "global M2 money supply YoY growth 2026 sum US EU China Japan UK central banks USD-equivalent" },
      { id: "us_m2",     name: "US M2 YoY",         query: "US M2 money supply growth 2026" },
    ],
  },
  {
    id: "fed", name: "FED POLICY", weight: "Core dimension: Monetary",
    indicators: [
      { id: "ffr",         name: "Fed Funds Rate",   query: "federal funds rate 2026" },
      { id: "cut_prob",    name: "Cut Probability",  query: "CME FedWatch cut probability 2026" },
      { id: "cuts_2026",   name: "2026 Cuts Priced", query: "Fed rate cuts priced 2026 futures" },
      { id: "yield_curve", name: "2Y-10Y Curve",     query: "2-year 10-year treasury yield curve spread 2026" },
    ],
  },
  {
    id: "inflation", name: "INFLATION", weight: "Core dimension: Inflation",
    indicators: [
      { id: "core_pce",     name: "Core PCE YoY ⚡", query: "core PCE year over year 2026" },
      { id: "core_pce_mom", name: "Core PCE MoM",    query: "core PCE month over month 2026" },
      { id: "breakeven5",   name: "5Y Breakeven",    query: "5-year breakeven inflation 2026" },
      { id: "real_yield",   name: "Real 10Y Yield",  query: "10-year TIPS real yield 2026" },
    ],
  },
  {
    id: "growth", name: "GROWTH & LABOR", weight: "Core dimension: Growth",
    indicators: [
      { id: "pmi",           name: "PMI Composite",    query: "US PMI composite 2026" },
      { id: "ism_new_orders", name: "ISM New Orders ⚡", query: "ISM manufacturing new orders sub-index latest 2026" },
      { id: "nfp",           name: "Nonfarm Payrolls", query: "nonfarm payrolls latest 2026" },
      { id: "unemployment",  name: "Unemployment",     query: "US unemployment rate 2026" },
    ],
  },
];

const API_SYSTEM =
  "You are a quant macro analyst. Return ONLY valid JSON. No markdown, no backticks, no text outside the JSON. Never use apostrophes, quotes, or newlines inside string values — use plain text only.";

const API_PROMPT = `You are a macro-quant analyst scoring a 6-dimension regime model. Indicators marked LIVE VALUE are real-time data — use those exact values. For all other indicators, use your training knowledge to provide the most recent plausible value — never return "unknown". Always give a real value or a clearly-labelled estimate (e.g. "~4.3%").

THE 6 DIMENSIONS (each scored -1, 0, or +1):

1. MONETARY: Fed policy stance. Cutting/dovish=+1, Pause/mixed=0, Hiking/hawkish=-1
2. INFLATION: Trend direction. Cooling toward 2%=+1, Sticky/mixed=0, Reaccelerating=-1
3. GROWTH: Economic momentum. PMI>53+ISM New Orders>53+jobs strong=+1, Mixed=0, ISM New Orders<48+PMI contracting+rising unemployment=-1. NOTE: ISM New Orders leads PMI by 1-2 months — weight it heavily.
4. LIQUIDITY: Net liquidity conditions. Global M2 expanding+Fed BS growing+RRP draining=+1, Mixed=0, Global M2 contracting+QT active+TGA building=-1. NOTE: Global M2 (US+EU+China+Japan) leads risk assets by 12-16 weeks — weight it heavily.
5. DOLLAR: DXY direction. Weakening=+1 (bullish risk assets), Stable=0, Strengthening=-1
6. SENTIMENT: Risk appetite. VIX<15+HY spreads tightening+ETF inflows=+1, Mixed=0, VIX>25+HY spreads widening+outflows=-1. NOTE: HY spread DIRECTION (widening vs tightening) matters more than absolute level.

CRYPTO SENTIMENT OVERLAY (scored -2 to +2):
MVRV context: <1=historically undervalued, 1-2=fair value, 2-3=elevated, >3.5=overheated.
+2=MVRV<2+extreme greed+massive ETF inflows+positive funding, +1=MVRV<2.5+positive flows, 0=Mixed/MVRV 2-3, -1=MVRV>3+outflows+fear+negative funding, -2=MVRV>3.5+capitulation+extreme fear+massive outflows

Return ONLY valid JSON (no markdown, no backticks):
- dimensions: {monetary,inflation,growth,liquidity,dollar,sentiment} each {score:-1|0|1, rationale:string}
- crypto_sentiment: {score:-2..+2, rationale:string}
- composite: integer (-6 to +6)
- indicators: object keyed by indicator_id (use exact IDs from list below), each {value:string, trend:string, signal:strong_bull|bull|neutral|bear|strong_bear, note:string}
- regime: {monetary,fiscal,inflation,growth,liquidity,sentiment} each {state:string, signal:bull|bear|neutral, detail:string}
- liquidity_narrative: string (1-2 sentences)
- composite_narrative: string (1-2 sentences)
- trade_actions: string (1-2 sentences on THIS WEEK)
- key_dates: array of {date:"MMM D", event:string, importance:critical|high|medium} (top 4)
- aave_guidance: string (1 sentence on wstETH/USDC Aave position)
- updated: today's date

INDICATORS (use these exact IDs as JSON keys):
`;

// ─── STYLES ───────────────────────────────────────────────────────────────────
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;500;600;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body { background: #0e0c1c; color: #a8a4cc; }

  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-thumb { background: #2c2848; border-radius: 2px; }

  @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:.3} }
  @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
  @keyframes scanPulse { 0%,100%{box-shadow:0 0 20px #00ffd010} 50%{box-shadow:0 0 40px #00ffd022} }

  .data-section { animation: fadeIn 0.35s ease; }

  .scan-btn {
    background: #0e0c1c;
    border: 1px solid #00ffd030;
    color: #00ffd0;
    padding: 14px 48px;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 2px;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    transition: border-color 0.2s, box-shadow 0.2s, color 0.2s;
    min-height: 48px;
    text-transform: uppercase;
  }
  .scan-btn:hover:not(:disabled) {
    border-color: #00ffd060;
    color: #00ffd0;
    box-shadow: 0 0 32px #00ffd018, 0 0 12px #00ffd00a, inset 0 0 24px #00ffd006;
  }
  .scan-btn:disabled { background: #161428; border-color: #2c2848; color: #2c2848; cursor: not-allowed; }

  /* Responsive grids */
  .dim-grid    { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
  .pos-grid    { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .regime-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .dash-header { display: flex; justify-content: space-between; align-items: flex-start; }
  .gauge-num   { font-size: 52px; }

  @media (max-width: 640px) {
    .dim-grid    { grid-template-columns: repeat(3, 1fr); }
    .pos-grid    { grid-template-columns: repeat(3, 1fr); }
    .regime-grid { grid-template-columns: repeat(2, 1fr); }
    .dash-header { flex-direction: column; gap: 6px; }
    .gauge-num   { font-size: 36px !important; }
    .scan-btn    { width: 100%; padding: 14px; }
    .gauge-sub   { font-size: 12px !important; flex-direction: column; gap: 4px; align-items: center; }
  }
  @media (max-width: 400px) {
    .dim-grid { grid-template-columns: repeat(2, 1fr); }
    .pos-grid { grid-template-columns: repeat(2, 1fr); }
  }
`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const scoreColor = (s) => s > 0 ? "#00e890" : s < 0 ? "#ff7040" : "#ffcc00";
const scoreLabel = (s) => s > 0 ? "+1" : s < 0 ? "-1" : "0";
const regCol = { bull: "#00e890", bear: "#ff7040", neutral: "#ffcc00" };

// Card wrapper
function Card({ children, style, accent }) {
  return (
    <div style={{
      background: "#161428",
      border: `1px solid ${accent ? `${accent}22` : "#2c2848"}`,
      borderRadius: 7,
      padding: 16,
      marginBottom: 10,
      ...style,
    }}>
      {children}
    </div>
  );
}

function CardHeader({ children, color = "#3d6080" }) {
  return (
    <div style={{
      fontSize: 11, letterSpacing: 1.2, color, fontWeight: 700,
      marginBottom: 12, borderBottom: "1px solid #201c38", paddingBottom: 9,
      fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase",
    }}>
      {children}
    </div>
  );
}

function Dot({ signal, size = 7 }) {
  const c = SC[signal] || "#ffcc00";
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
    { key: "monetary",  label: "MON", w: 2.0 },
    { key: "inflation", label: "INF", w: 1.5 },
    { key: "growth",    label: "GRO", w: 1.5 },
    { key: "liquidity", label: "LIQ", w: 1.0 },
    { key: "dollar",    label: "USD", w: 0.5 },
    { key: "sentiment", label: "SEN", w: 0.75 },
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
              textAlign: "center", background: "#1e1c35", borderRadius: 6,
              padding: "12px 6px", border: `1px solid ${c}25`,
            }}>
              <div style={{ fontSize: 10, color: "#7878a8", letterSpacing: 0.5, fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 600 }}>{d.label} <span style={{ color: "#2d4560", fontSize: 9 }}>{d.w}×</span></div>
              <div style={{
                fontSize: 24, fontWeight: 800, color: c, lineHeight: 1.1,
                fontFamily: "'JetBrains Mono', monospace", margin: "4px 0",
              }}>
                {scoreLabel(dim.score)}
              </div>
              <div style={{ fontSize: 10, color: "#7878a8", lineHeight: 1.4, minHeight: 24, fontFamily: "'Inter', system-ui, sans-serif" }}>
                {dim.rationale}
              </div>
            </div>
          );
        })}
      </div>

      {cryptoSentiment && (
        <div style={{
          marginTop: 10, padding: "12px 14px", background: "#1e1c35", borderRadius: 6,
          border: `1px solid ${scoreColor(cryptoSentiment.score)}25`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          flexWrap: "wrap", gap: 8,
        }}>
          <div>
            <div style={{ fontSize: 11, color: "#7878a8", fontWeight: 600, fontFamily: "'Inter', system-ui, sans-serif" }}>Crypto Sentiment Overlay</div>
            <div style={{ fontSize: 12, color: "#9898cc", marginTop: 2, fontFamily: "'Inter', system-ui, sans-serif" }}>{cryptoSentiment.rationale}</div>
          </div>
          <span style={{
            fontSize: 22, fontWeight: 800, color: scoreColor(cryptoSentiment.score),
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {cryptoSentiment.score > 0 ? "+" : ""}{cryptoSentiment.score}
          </span>
        </div>
      )}
    </Card>
  );
}

// ─── COMPOSITE GAUGE ─────────────────────────────────────────────────────────
function CompositeGauge({ composite, weightedComposite, narrative, signalKey, confirmation }) {
  if (composite === null || composite === undefined) return null;
  const displayScore = weightedComposite ?? composite;
  const cfg = SIGNAL_CONFIG[signalKey];
  const pct = ((displayScore + 6) / 12) * 100;

  return (
    <div style={{ textAlign: "center", padding: "26px 0 18px" }}>
      <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#5a7898", marginBottom: 8, fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 600, textTransform: "uppercase" }}>
        Composite Regime Signal
      </div>
      <div
        className="gauge-num"
        style={{ fontWeight: 800, color: cfg.color, letterSpacing: -1, fontFamily: "'Instrument Sans', sans-serif", lineHeight: 1, textShadow: `0 0 50px ${cfg.color}28` }}
      >
        {cfg.label}
      </div>

      <div
        className="gauge-sub"
        style={{ fontSize: 13, color: "#7878a8", marginTop: 8, display: "flex", justifyContent: "center", alignItems: "center", gap: 10, flexWrap: "wrap", fontFamily: "'Inter', system-ui, sans-serif" }}
      >
        <span>
          Weighted:{" "}
          <span style={{ color: cfg.color, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
            {displayScore > 0 ? "+" : ""}{displayScore}
          </span>
          {weightedComposite != null && weightedComposite !== composite && (
            <span style={{ color: "#2d4560", fontSize: 11 }}> (raw {composite > 0 ? "+" : ""}{composite})</span>
          )}
          {" "}/ ±6
        </span>
        <span style={{ color: "#2d4560" }}>·</span>
        <span style={{ color: "#9898cc" }}>{cfg.action}</span>
      </div>

      {/* Confirmation badge */}
      {confirmation && (
        <div style={{ marginTop: 10, display: "flex", justifyContent: "center" }}>
          {confirmation.isNew ? (
            <span style={{ fontSize: 11, padding: "4px 12px", borderRadius: 4, background: "#1c1800", border: "1px solid #ffcc0050", color: "#ffcc00", fontFamily: "'Inter', system-ui, sans-serif" }}>
              ⚠ New regime · 1st reading · confirm next scan before acting
            </span>
          ) : (
            <span style={{ fontSize: 11, padding: "4px 12px", borderRadius: 4, background: "#0c1a10", border: "1px solid #00e89040", color: "#00e890", fontFamily: "'Inter', system-ui, sans-serif" }}>
              ✓ Confirmed · {confirmation.streak} consecutive readings
            </span>
          )}
        </div>
      )}

      {narrative && (
        <div style={{ fontSize: 14, color: "#9898cc", marginTop: 14, lineHeight: 1.7, maxWidth: 620, margin: "14px auto 0", fontFamily: "'Inter', system-ui, sans-serif" }}>
          {narrative}
        </div>
      )}

      {/* Gauge track */}
      <div style={{ margin: "20px auto 0", maxWidth: 500, padding: "0 16px" }}>
        <div style={{ position: "relative", height: 6, borderRadius: 3, background: "linear-gradient(90deg, #ff2255 0%, #ff7040 22%, #ffcc00 44%, #ffcc00 56%, #00e890 78%, #00ffd0 100%)", boxShadow: "0 1px 8px #0006" }}>
          <div style={{
            position: "absolute", top: -5, left: `${Math.max(3, Math.min(97, pct))}%`,
            transform: "translateX(-50%)", width: 16, height: 16,
            background: cfg.color, borderRadius: "50%", border: "3px solid #0e0c1c",
            boxShadow: `0 0 14px ${cfg.color}80, 0 0 5px ${cfg.color}`,
            transition: "left 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
          }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontSize: 8, color: "#0c1c30", letterSpacing: 1 }}>
          <span>−6 BEAR</span><span>0</span><span>BULL +6</span>
        </div>
      </div>
    </div>
  );
}

// ─── POSITION TABLE ───────────────────────────────────────────────────────────
function PositionTable({ signalKey, cryptoScore, overrides }) {
  if (!signalKey) return null;
  const bearOverride   = overrides?.some(o => o.type === "BEAR");
  const cryptoReduce   = overrides?.some(o => o.type === "CRYPTO_REDUCE");
  // Cap at BEAR if override fires and regime is better than BEAR
  const effectiveKey   = bearOverride && signalKey !== "STRONG_BEAR" && signalKey !== "BEAR" ? "BEAR" : signalKey;
  const overrideActive = effectiveKey !== signalKey;
  const allocs         = ALLOC_MATRIX[effectiveKey];
  const assets = [
    { key: "btc", label: "BTC", color: "#f7931a" },
    { key: "eth", label: "ETH", color: "#8fa8f8" },
    { key: "spy", label: "SPY", color: "#00e890" },
    { key: "qqq", label: "QQQ", color: "#9c80f8" },
    { key: "gld", label: "GLD", color: "#e8c040" },
  ];
  const cryptoMod = cryptoScore || 0;

  return (
    <Card>
      <CardHeader>
        TARGET ALLOCATION — {SIGNAL_CONFIG[effectiveKey].label} REGIME
        {overrideActive && (
          <span style={{ color: "#ff2255", marginLeft: 8, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
            ⚠ overridden from {SIGNAL_CONFIG[signalKey].label}
          </span>
        )}
      </CardHeader>
      <div className="pos-grid">
        {assets.map((a) => {
          let base = allocs[a.key];
          let adjusted = base;
          if ((a.key === "btc" || a.key === "eth") && cryptoMod !== 0) {
            adjusted = Math.max(0, Math.min(100, base + cryptoMod * 15));
          }
          if ((a.key === "btc" || a.key === "eth") && cryptoReduce) {
            adjusted = Math.round(adjusted * 0.7);
          }
          const isModified = adjusted !== base;
          return (
            <div key={a.key} style={{ textAlign: "center", background: "#1e1c35", borderRadius: 6, padding: "12px 6px", border: `1px solid ${a.color}18` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: a.color, fontFamily: "'JetBrains Mono', monospace" }}>{a.label}</div>
              <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, color: adjusted > 0 ? "#c5d5ee" : "#0c1c30", margin: "6px 0", fontFamily: "'Instrument Sans', sans-serif" }}>
                {adjusted}%
              </div>
              {isModified && (
                <div style={{ fontSize: 11, color: cryptoMod > 0 ? "#00e890" : "#ff7040", marginBottom: 4, fontFamily: "'Inter', system-ui, sans-serif" }}>
                  base {base}% {cryptoMod > 0 ? "↑" : "↓"} overlay
                </div>
              )}
              <div style={{ width: "100%", height: 3, background: "#201c38", borderRadius: 2, marginTop: 6 }}>
                <div style={{ width: `${adjusted}%`, height: "100%", background: adjusted > 0 ? a.color : "#201c38", borderRadius: 2, transition: "width 0.4s ease" }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: "#3a5272", marginTop: 10, textAlign: "center", fontFamily: "'Inter', system-ui, sans-serif" }}>
        Crypto overlay ±15% per sentiment point · Real yield {">"}3% −30% crypto · Cash earns T-bill rate
      </div>
    </Card>
  );
}

// ─── AAVE BOX ────────────────────────────────────────────────────────────────
function AaveBox({ guidance }) {
  if (!guidance) return null;
  return (
    <Card accent="#9c80f8">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, borderBottom: "1px solid #201c38", paddingBottom: 9 }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#9c80f8", fontWeight: 700 }}>AAVE POSITION GUIDANCE</span>
        <span style={{ fontSize: 8, color: "#253a55" }}>wstETH / USDC</span>
      </div>
      <div style={{ fontSize: 14, color: "#9898cc", lineHeight: 1.7, fontFamily: "'Inter', system-ui, sans-serif" }}>{guidance}</div>
    </Card>
  );
}

// ─── TRADE ACTIONS ────────────────────────────────────────────────────────────
function TradeActions({ actions }) {
  if (!actions) return null;
  return (
    <div style={{
      background: "#0e1510", border: "1px solid #00e89028",
      borderRadius: 8, padding: 16, marginBottom: 10,
    }}>
      <div style={{
        fontSize: 11, letterSpacing: 0.5, color: "#00e890", fontWeight: 700,
        marginBottom: 10, borderBottom: "1px solid #081610", paddingBottom: 9,
        fontFamily: "'Inter', system-ui, sans-serif", textTransform: "uppercase",
      }}>
        This Week&apos;s Actions
      </div>
      <div style={{ fontSize: 14, color: "#90b8a0", lineHeight: 1.7, fontFamily: "'Inter', system-ui, sans-serif" }}>{actions}</div>
    </div>
  );
}

// ─── REGIME BOXES ─────────────────────────────────────────────────────────────
function Regimes({ regime }) {
  if (!regime) return null;
  return (
    <div className="regime-grid" style={{ marginBottom: 10 }}>
      {Object.entries(regime).map(([k, r]) => {
        const c = regCol[r.signal] || "#ffcc00";
        return (
          <div key={k} style={{
            background: "#161428", padding: "12px 14px", borderRadius: 7,
            borderLeft: `3px solid ${c}`,
          }}>
            <div style={{ fontSize: 10, color: "#7878a8", letterSpacing: 0.5, textTransform: "uppercase", fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 600 }}>{k}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: c, marginTop: 4, lineHeight: 1.1, fontFamily: "'Inter', system-ui, sans-serif" }}>{r.state}</div>
            <div style={{ fontSize: 12, color: "#9898cc", marginTop: 5, lineHeight: 1.5, fontFamily: "'Inter', system-ui, sans-serif" }}>{r.detail}</div>
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
      <CardHeader>Global Liquidity</CardHeader>
      <div style={{ fontSize: 14, color: "#9898cc", lineHeight: 1.7, fontFamily: "'Inter', system-ui, sans-serif" }}>{text}</div>
    </Card>
  );
}

// ─── KEY DATES ────────────────────────────────────────────────────────────────
function KeyDates({ dates }) {
  if (!dates?.length) return null;
  const ic = { critical: "#ff2255", high: "#ffcc00", medium: "#3a5272" };
  return (
    <Card>
      <CardHeader>UPCOMING CATALYSTS</CardHeader>
      {dates.map((d, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "5px 0",
          borderBottom: i < dates.length - 1 ? "1px solid #0f1e30" : "none",
        }}>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 3,
            background: `${ic[d.importance] || "#3a5272"}20`,
            color: ic[d.importance] || "#5a7898",
            minWidth: 58, textAlign: "center",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {d.date}
          </span>
          <span style={{ fontSize: 13, color: "#9898cc", fontFamily: "'Inter', system-ui, sans-serif" }}>{d.event}</span>
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
  if (p > 62)      { sl = "BULL";  sclr = "#00e890"; }
  else if (p > 38) { sl = "MIXED"; sclr = "#ffcc00"; }
  else             { sl = "BEAR";  sclr = "#ff7040"; }

  return (
    <div style={{
      background: "#161428", border: "1px solid #201c38",
      borderRadius: 8, padding: "12px 14px", marginBottom: 8,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        borderBottom: "1px solid #201c38", paddingBottom: 10, marginBottom: 10,
        flexWrap: "wrap", gap: 6,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, letterSpacing: 0.5, color: "#9898cc", fontWeight: 700, fontFamily: "'Inter', system-ui, sans-serif" }}>{category.name}</span>
          {category.weight && <span style={{ fontSize: 11, color: "#4a6282", fontFamily: "'Inter', system-ui, sans-serif" }}>{category.weight}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 13, color: "#5a7898", fontFamily: "'JetBrains Mono', monospace" }}>{sc > 0 ? "+" : ""}{sc}</span>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 3,
            background: `${sclr}18`, color: sclr, letterSpacing: 0.5,
            fontFamily: "'Inter', system-ui, sans-serif",
          }}>
            {sl}
          </span>
        </div>
      </div>

      {items.map((item) => (
        <div key={item.id} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 0", borderBottom: "1px solid #161428",
        }}>
          <div style={{ flex: 1, minWidth: 0, paddingRight: 10 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "#c0d4e8", fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 500 }}>{item.name}</span>
              <span style={{ fontSize: 13, color: "#7ab8e8", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{item.data.value}</span>
            </div>
            {item.data.note && (
              <div style={{ fontSize: 11, color: "#5a7898", marginTop: 3, lineHeight: 1.45, fontFamily: "'Inter', system-ui, sans-serif" }}>{item.data.note}</div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: SC[item.data.signal] || "#ffcc00", fontFamily: "'Inter', system-ui, sans-serif" }}>{item.data.trend}</span>
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
      <div style={{ fontSize: 13, lineHeight: 2.1, fontFamily: "'Inter', system-ui, sans-serif" }}>
        {[
          { color: "#00ffd0", label: "STRONG BULL (≥+4):", rule: "Max exposure all risk assets. Leverage acceptable. Gold 50%. Aave: maintain or increase debt." },
          { color: "#00e890", label: "BULL (+2 to +3):",   rule: "Full long all assets. Maintain leverage. Gold 75%. Aave: hold current position." },
          { color: "#ffcc00", label: "NEUTRAL (-1 to +1):",rule: "SPY/QQQ to 50%. BTC/ETH to 75% (asymmetric upside). Gold full. No new leverage. Aave: consider partial repay." },
          { color: "#ff7040", label: "BEAR (-2 to -3):",   rule: "Exit equities. BTC 25%, ETH 20%. Gold 100%. Aave: repay $200K+ debt immediately." },
          { color: "#ff2255", label: "STRONG BEAR (≤-4):", rule: "Full cash + gold. Zero crypto. Aave: deleverage to <$400K debt or fully repay." },
        ].map((r) => (
          <div key={r.label} style={{ marginBottom: 4 }}>
            <span style={{ color: r.color }}>■</span>{" "}
            <strong style={{ color: "#9898cc" }}>{r.label}</strong>{" "}
            <span style={{ color: "#5a7898" }}>{r.rule}</span>
          </div>
        ))}
        <div style={{ color: "#4a6282", marginTop: 8 }}>
          Crypto Overlay: BTC/ETH allocation shifts ±15% per crypto sentiment point.
          Review weekly. Rebalance on signal change, not on calendar.
        </div>
      </div>
    </Card>
  );
}

// ─── LIVE PRICE FORMATTER ────────────────────────────────────────────────────
function fmtLive(id, d) {
  if (!d) return null;
  // ── FRED series (no prev close available) ─────────────────────────────────
  if (id === "hy_spread") {
    if (d.change4w != null) {
      const dir  = d.change4w > 0.05 ? "widening" : d.change4w < -0.05 ? "tightening" : "stable";
      const sign = d.change4w >= 0 ? "+" : "";
      return `${d.value.toFixed(2)}% OAS (${sign}${d.change4w.toFixed(2)}% 4-wk — ${dir})`;
    }
    return `${d.value.toFixed(2)}% OAS`;
  }
  if (id === "real_yield")      return `${d.value.toFixed(2)}%`;
  if (id === "ffr")             return `${d.value.toFixed(2)}%`;
  if (id === "unemployment")    return `${d.value.toFixed(1)}%`;
  if (id === "core_pce")        return `${d.value.toFixed(2)}% YoY`;
  if (id === "core_pce_mom")    return `${d.value.toFixed(2)}% MoM`;
  if (id === "yield_curve") {
    const sign   = d.spread >= 0 ? "+" : "";
    const status = d.spread < 0 ? "inverted" : "normal";
    return `${sign}${d.spread.toFixed(2)}% ${status} (2Y ${d.y2.toFixed(2)}%, 10Y ${d.y10.toFixed(2)}%)`;
  }
  // ── Crypto ─────────────────────────────────────────────────────────────────
  if (id === "btc" || id === "eth") {
    const sign = (d.change24h ?? 0) >= 0 ? "+" : "";
    return `$${Math.round(d.price).toLocaleString("en-US")} (${sign}${(d.change24h ?? 0).toFixed(1)}% 24h)`;
  }
  if (id === "fear_greed") return `${d.value} - ${d.label}`;
  // ── Yahoo Finance yield series (stored as pct points, not price) ───────────
  if (id === "us10y" || id === "breakeven5") {
    const bp   = Math.round((d.price - d.prev) * 100);
    const sign = bp >= 0 ? "+" : "";
    return `${d.price.toFixed(2)}% (${sign}${bp}bp today)`;
  }
  // ── Yahoo Finance price series (spx, vix, dxy) ────────────────────────────
  const chg  = ((d.price - d.prev) / d.prev) * 100;
  const sign = chg >= 0 ? "+" : "";
  const pStr = id === "spx"
    ? `$${d.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : d.price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${pStr} (${sign}${chg.toFixed(2)}% today)`;
}

// ─── SCAN HISTORY BAR ────────────────────────────────────────────────────────
function ScanHistoryBar({ history, onClear }) {
  if (!history?.length) return null;
  const items   = [...history].reverse(); // oldest → newest (L→R)
  const latest  = history[0];
  const prev    = history[1];
  const latestW = latest.weighted ?? latest.raw ?? 0;
  const prevW   = prev != null ? (prev.weighted ?? prev.raw ?? 0) : null;
  const delta   = prevW !== null ? latestW - prevW : null;

  return (
    <div style={{ background: "#161428", border: "1px solid #2c2848", borderRadius: 7, padding: "12px 16px", marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
        <span style={{ fontSize: 10, letterSpacing: 1.5, color: "#1e3858", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>
          Scan History · {history.length} saved
        </span>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {delta !== null && (
            <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: delta > 0 ? "#00e890" : delta < 0 ? "#ff7040" : "#ffcc00", fontWeight: 700 }}>
              {delta > 0 ? "↑" : delta < 0 ? "↓" : "→"} {delta > 0 ? "+" : ""}{delta} vs prev
            </span>
          )}
          <button onClick={onClear} style={{ fontSize: 10, color: "#1a3050", background: "none", border: "none", cursor: "pointer", fontFamily: "'Inter', system-ui, sans-serif", letterSpacing: 0.5, padding: "2px 4px" }}>
            clear
          </button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "flex-end" }}>
        {items.map((entry, i) => {
          const score    = entry.weighted ?? entry.raw ?? 0;
          const key      = getSignalKey(score);
          const cfg      = SIGNAL_CONFIG[key];
          const d        = new Date(entry.ts);
          const isLatest = i === items.length - 1;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <div style={{
                background: isLatest ? `${cfg.color}1e` : `${cfg.color}08`,
                border:     `1px solid ${cfg.color}${isLatest ? "55" : "20"}`,
                borderRadius: 4, padding: "3px 9px", minWidth: 38, textAlign: "center",
                fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                color: isLatest ? cfg.color : `${cfg.color}70`,
                fontWeight: isLatest ? 700 : 400,
                boxShadow: isLatest ? `0 0 12px ${cfg.color}18` : "none",
              }}>
                {score > 0 ? "+" : ""}{score}
              </div>
              <div style={{ fontSize: 9, color: isLatest ? "#2a4868" : "#111e30", fontFamily: "'Inter', system-ui, sans-serif" }}>
                {`${d.getMonth() + 1}/${d.getDate()}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── OVERRIDE BANNER ─────────────────────────────────────────────────────────
function OverrideBanner({ overrides }) {
  if (!overrides?.length) return null;
  return (
    <div style={{ background: "#1c0c1c", border: "1px solid #ff225535", borderRadius: 7, padding: "12px 16px", marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: "#ff2255", fontWeight: 700, letterSpacing: 1.5, marginBottom: 8, textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>
        ⚠ Override Alerts — Sizing Adjusted
      </div>
      {overrides.map((o, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 4, padding: "5px 0", borderTop: i > 0 ? "1px solid #1a0810" : "none" }}>
          <span style={{ fontSize: 13, color: "#ff7040", fontFamily: "'JetBrains Mono', monospace" }}>{o.label}</span>
          <span style={{ fontSize: 12, color: "#a03020", fontFamily: "'Inter', system-ui, sans-serif" }}>{o.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ─── JSON REPAIR ─────────────────────────────────────────────────────────────
function repairJson(str) {
  // Remove trailing commas before } or ]
  str = str.replace(/,(\s*[}\]])/g, "$1");
  // Close any unclosed braces/brackets (handles truncated output)
  const stack = [];
  for (const ch of str) {
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  return str + stack.reverse().join("");
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const [data, setData]               = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [progress, setProgress]       = useState("");
  const [lastFetched, setLastFetched] = useState(null);
  const [history, setHistory]         = useState([]);
  const [overrides, setOverrides]     = useState([]);

  // Load scan history from localStorage on mount
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
      if (Array.isArray(saved)) setHistory(saved);
    } catch {}
  }, []);

  // Weighted composite: normalize dim scores → -6..+6 range
  const weightedComposite = useMemo(() => {
    if (!data?.dimensions) return null;
    return computeWeightedComposite(data.dimensions);
  }, [data]);

  const weightedSignalKey = useMemo(() => {
    if (weightedComposite == null) return null;
    return getSignalKey(weightedComposite);
  }, [weightedComposite]);

  // Fall back to raw LLM composite if dimensions unavailable
  const rawSignalKey = useMemo(() => {
    if (data?.composite == null) return null;
    return getSignalKey(data.composite);
  }, [data]);

  const signalKey = weightedSignalKey ?? rawSignalKey;

  // Confirmation: history[0]=current scan, slice(1)=previous scans
  const confirmation = useMemo(() => {
    if (!weightedSignalKey || history.length < 2) return null;
    return getConfirmation(history.slice(1), weightedSignalKey);
  }, [history, weightedSignalKey]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setOverrides([]);

    try {
      // ── Step 1: fetch real-time prices ───────────────────────────────────
      setProgress("Fetching live market prices…");
      let livePrices = {};
      try {
        const pr = await fetch("/api/prices");
        if (pr.ok) livePrices = await pr.json();
      } catch {} // non-fatal

      // ── Step 2: build prompt with live values injected ───────────────────
      const allInds = CATEGORIES.flatMap((c) =>
        c.indicators.map((i) => {
          const live = fmtLive(i.id, livePrices[i.id]);
          if (live) return `- ${i.id}: ${i.name} → LIVE VALUE: ${live} [use this exact value, do not search]`;
          return `- ${i.id}: ${i.name} → estimate: "${i.query}"`;
        })
      );
      const prompt = API_PROMPT + allInds.join("\n");

      // ── Step 3: LLM scoring ───────────────────────────────────────────────
      setProgress("Scoring macro regime…");
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, system: API_SYSTEM }),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      setProgress("Finalizing signals…");
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      const text = result.text || "";
      let json = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const f = json.indexOf("{"), l = json.lastIndexOf("}");
      if (f !== -1 && l !== -1) json = json.slice(f, l + 1);
      let parsed;
      try { parsed = JSON.parse(json); }
      catch { parsed = JSON.parse(repairJson(json)); }

      // ── Step 4: save to localStorage history ─────────────────────────────
      const wc = computeWeightedComposite(parsed.dimensions);
      setHistory(prev => {
        const entry = {
          ts:       Date.now(),
          weighted: wc,
          raw:      parsed.composite,
          dims: {
            monetary:  parsed.dimensions?.monetary?.score  ?? 0,
            inflation: parsed.dimensions?.inflation?.score ?? 0,
            growth:    parsed.dimensions?.growth?.score    ?? 0,
            liquidity: parsed.dimensions?.liquidity?.score ?? 0,
            dollar:    parsed.dimensions?.dollar?.score    ?? 0,
            sentiment: parsed.dimensions?.sentiment?.score ?? 0,
          },
          crypto: parsed.crypto_sentiment?.score ?? 0,
        };
        const updated = [entry, ...prev].slice(0, MAX_HISTORY);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(updated)); } catch {}
        return updated;
      });

      // ── Step 5: hard override check ───────────────────────────────────────
      setOverrides(getOverrides(livePrices));
      setData(parsed);
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
        <meta name="theme-color" content="#0e0c1c" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>
      <style>{STYLES}</style>

      <div style={{ minHeight: "100vh", background: "#0e0c1c", color: "#a8a4cc", fontFamily: "'Inter', system-ui, sans-serif", padding: "16px 14px", maxWidth: 900, margin: "0 auto" }}>

        {/* Header */}
        <div className="dash-header" style={{ marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 9, letterSpacing: 2.5, color: "#00ffd020", fontWeight: 700, textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>Macro Regime</div>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5, color: "#d0e8ff", marginTop: 2 }}>
              Trading Dashboard
            </div>
            <div style={{ fontSize: 10, color: "#152436", marginTop: 3, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>
              weighted 6-dim · backtested 2018–2025 · weekly
            </div>
          </div>
          {lastFetched && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "#0a1828", letterSpacing: 1.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>Last scan</div>
              <div style={{ fontSize: 10, color: "#1a3050", fontFamily: "'JetBrains Mono', monospace" }}>{lastFetched.toLocaleString()}</div>
            </div>
          )}
        </div>

        {/* Accent line under header */}
        <div style={{ height: 1, background: "linear-gradient(90deg, transparent 0%, #00ffd015 30%, #00ffd015 70%, transparent 100%)", margin: "10px 0 12px" }} />

        {/* Signal Legend */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", padding: "2px 0 10px", flexWrap: "wrap" }}>
          {Object.entries(SIGNAL_CONFIG).map(([k, v]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: v.color, boxShadow: `0 0 6px ${v.color}80` }} />
              <span style={{ fontSize: 10, color: "#1a3050", fontFamily: "'JetBrains Mono', monospace" }}>{v.label} ({v.range})</span>
            </div>
          ))}
        </div>

        {/* Scan History — persists from localStorage between sessions */}
        {history.length > 0 && (
          <ScanHistoryBar history={history} onClear={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]); }} />
        )}

        {/* Scan Button */}
        <div style={{ textAlign: "center", padding: "10px 0 16px" }}>
          <button className="scan-btn" onClick={fetchData} disabled={loading}>
            {loading ? "SCANNING…" : data ? "REFRESH SCAN" : "RUN WEEKLY SCAN"}
          </button>
          {loading && progress && (
            <div style={{ fontSize: 10, color: "#0e2238", marginTop: 8, animation: "pulse 1.5s infinite", fontFamily: "'JetBrains Mono', monospace" }}>
              {progress}
            </div>
          )}
          {error && <div style={{ fontSize: 12, color: "#ff2255", marginTop: 8 }}>Error: {error}</div>}
          {!data && !loading && (
            <div style={{ fontSize: 10, color: "#0a1828", marginTop: 8, fontFamily: "'JetBrains Mono', monospace" }}>
              22 indicators · weighted 6-dim · crypto overlay · position sizing
            </div>
          )}
        </div>

        {/* Data section */}
        {data && (
          <div className="data-section">
            <CompositeGauge
              composite={data.composite}
              weightedComposite={weightedComposite}
              narrative={data.composite_narrative}
              signalKey={signalKey}
              confirmation={confirmation}
            />
            <OverrideBanner overrides={overrides} />
            <TradeActions actions={data.trade_actions} />
            <PositionTable signalKey={signalKey} cryptoScore={data.crypto_sentiment?.score} overrides={overrides} />
            <AaveBox guidance={data.aave_guidance} />
            <DimensionBar dimensions={data.dimensions} cryptoSentiment={data.crypto_sentiment} />
            <Regimes regime={data.regime} />
            <LiqBox text={data.liquidity_narrative} />
            <KeyDates dates={data.key_dates} />
            {CATEGORIES.map((c) => (
              <Section key={c.id} category={c} indicators={data.indicators} />
            ))}
            <RulesRef />
            <div style={{ textAlign: "center", padding: "14px 0 8px", fontSize: 10, color: "#0a1828", letterSpacing: 1.5, fontFamily: "'JetBrains Mono', monospace" }}>
              BACKTESTED FRAMEWORK — HYPOTHETICAL — NOT FINANCIAL ADVICE
            </div>
          </div>
        )}
      </div>
    </>
  );
}
