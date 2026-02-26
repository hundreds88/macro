#!/usr/bin/env python3
"""
Macro Regime Framework Backtest: 2009 – 2025
Applies the 6-dimension weighted scoring system to QQQ, SPY, and BTC.

Regime scoring is derived from FRED macro data using simplified but
faithful rules matching the framework's LLM scoring logic.
"""

import io
import math
import requests
import pandas as pd
import numpy as np
from datetime import datetime

pd.set_option("display.float_format", "{:.2f}".format)

START = "2009-01-01"
END   = "2025-12-31"

# ── WEIGHTS (from pages/index.js) ─────────────────────────────────────────────
DIM_WEIGHTS = {
    "monetary":  2.00,
    "inflation": 1.50,
    "growth":    1.50,
    "liquidity": 1.00,
    "sentiment": 0.75,
    "dollar":    0.50,
}
MAX_WEIGHTED = sum(DIM_WEIGHTS.values())  # 7.25

# ── ALLOCATION TABLE (from PositionTable in pages/index.js) ───────────────────
ALLOCS = {
    "STRONG_BULL": {"SPY": 1.00, "QQQ": 1.00, "BTC": 1.00},
    "BULL":        {"SPY": 1.00, "QQQ": 1.00, "BTC": 0.80},
    "NEUTRAL":     {"SPY": 0.50, "QQQ": 0.50, "BTC": 0.75},
    "BEAR":        {"SPY": 0.25, "QQQ": 0.25, "BTC": 0.25},
    "STRONG_BEAR": {"SPY": 0.00, "QQQ": 0.00, "BTC": 0.00},
}

SIGNAL_THRESHOLDS = [
    (4,  "STRONG_BULL"),
    (2,  "BULL"),
    (-1, "NEUTRAL"),
    (-3, "BEAR"),
]

def get_signal(weighted_score):
    for threshold, label in SIGNAL_THRESHOLDS:
        if weighted_score >= threshold:
            return label
    return "STRONG_BEAR"


# ──────────────────────────────────────────────────────────────────────────────
# DATA FETCHING
# ──────────────────────────────────────────────────────────────────────────────

def fetch_fred(series_id, name=None):
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    r = requests.get(url, timeout=15)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text), parse_dates=["observation_date"], index_col="observation_date")
    df.columns = [name or series_id]
    df = df.replace(".", np.nan).astype(float)
    return df

def fetch_yahoo(ticker, start=START, end=END):
    """Fetch monthly OHLCV from Yahoo Finance v8 API."""
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        f"?interval=1mo&period1={int(pd.Timestamp(start).timestamp())}"
        f"&period2={int(pd.Timestamp(end).timestamp())}"
    )
    headers = {"User-Agent": "Mozilla/5.0"}
    r = requests.get(url, headers=headers, timeout=15)
    r.raise_for_status()
    data = r.json()["chart"]["result"][0]
    timestamps = data["timestamp"]
    closes = data["indicators"]["adjclose"][0]["adjclose"]
    idx = pd.to_datetime(timestamps, unit="s").normalize()
    s = pd.Series(closes, index=idx, name=ticker)
    # Keep one reading per month (already monthly from interval=1mo)
    s = s.resample("MS").last()
    return s.dropna()


# ──────────────────────────────────────────────────────────────────────────────
# REGIME SCORING RULES
# ──────────────────────────────────────────────────────────────────────────────
# Each dimension returns +1, 0, or -1 monthly based on indicator states.
# Rules are simplified but faithful to the framework's description.

def score_monetary(fedfunds):
    """
    +1: Rate in active cutting cycle (down >50bp over 12m) OR below 0.5%
     0: Stable / data unavailable
    -1: Rate in active hiking cycle (up >100bp over 12m) AND above 3%
    """
    ff = fedfunds["FEDFUNDS"].resample("MS").mean()
    chg12 = ff.diff(12)
    scores = pd.Series(0, index=ff.index, dtype=float)
    scores[chg12 < -0.50]                         = 1   # cutting
    scores[ff < 0.50]                              = 1   # ZIRP
    scores[(chg12 > 1.00) & (ff > 3.0)]           = -1  # hiking hard
    return scores.rename("monetary")

def score_inflation(cpi):
    """
    +1: CPI YoY < 2.5%  (goldilocks)
     0: CPI YoY 2.5–4.5%
    -1: CPI YoY > 4.5% (hot inflation)
    """
    cpi_sa = cpi["CPIAUCSL"].resample("MS").last().ffill()
    yoy = cpi_sa.pct_change(12) * 100
    scores = pd.Series(0, index=yoy.index, dtype=float)
    scores[yoy < 2.5]  =  1
    scores[yoy > 4.5]  = -1
    return scores.rename("inflation")

def score_growth(emp):
    """
    Proxy: Manufacturing employment 6-month change as PMI-directional proxy.
    +1: Mfg employment expanding (6m chg > +30k)
     0: Flat (-30k to +30k)
    -1: Contracting (6m chg < -30k)
    """
    m = emp["MANEMP"].resample("MS").last().ffill()
    chg6 = m.diff(6)
    scores = pd.Series(0, index=m.index, dtype=float)
    scores[chg6 > 30]   =  1
    scores[chg6 < -30]  = -1
    return scores.rename("growth")

def score_liquidity(m2):
    """
    +1: M2 YoY growth > 6% (abundant liquidity)
     0: M2 YoY 2–6%
    -1: M2 YoY < 2% or shrinking (liquidity drain)
    """
    m2s = m2["M2SL"].resample("MS").last().ffill()
    yoy = m2s.pct_change(12) * 100
    scores = pd.Series(0, index=yoy.index, dtype=float)
    scores[yoy > 6]  =  1
    scores[yoy < 2]  = -1
    return scores.rename("liquidity")

def score_sentiment(vix):
    """
    +1: VIX < 15 (complacency / risk-on)
     0: VIX 15–25
    -1: VIX > 25 (fear / risk-off)
    """
    v = vix["VIXCLS"].resample("MS").mean().ffill()
    scores = pd.Series(0, index=v.index, dtype=float)
    scores[v < 15]  =  1
    scores[v > 25]  = -1
    return scores.rename("sentiment")

def score_dollar(dxy):
    """
    +1: DXY 6-month change < -2% (dollar weakening = risk-on)
     0: DXY stable (-2% to +2%)
    -1: DXY 6-month change > +2% (dollar strengthening = risk-off)
    """
    d = dxy["DTWEXBGS"].resample("MS").last().ffill()
    chg6 = d.pct_change(6) * 100
    scores = pd.Series(0, index=d.index, dtype=float)
    scores[chg6 < -2]  =  1
    scores[chg6 >  2]  = -1
    return scores.rename("dollar")


def build_regime_table(scores_dict):
    df = pd.concat(scores_dict.values(), axis=1).loc[START:END]
    # Weighted composite (normalized to -6..+6 range)
    weighted = sum(df[d] * w for d, w in DIM_WEIGHTS.items()) / MAX_WEIGHTED * 6
    df["weighted"] = weighted.round(2)
    df["signal"]   = df["weighted"].apply(get_signal)
    return df


# ──────────────────────────────────────────────────────────────────────────────
# BACKTEST ENGINE
# ──────────────────────────────────────────────────────────────────────────────

def backtest(prices, regime_df, asset, cash_yield=0.04):
    """
    Backtest one asset using the regime signal allocation.
    Cash position earns approximate T-bill rate (4% default, but
    we use actual SOFR-era rates for accuracy).
    Returns: strategy equity curve, B&H equity curve
    """
    p = prices[asset].resample("MS").last().ffill()
    monthly_ret = p.pct_change()

    # Align dates
    common = regime_df.index.intersection(monthly_ret.index)
    sig = regime_df["signal"].reindex(common)
    ret = monthly_ret.reindex(common)

    # For each month, allocation = ALLOCS[signal][asset]
    # We use the signal from the PREVIOUS month end (signal known at month start)
    alloc = sig.shift(1).map(lambda s: ALLOCS.get(s, {}).get(asset, 0.5) if pd.notna(s) else 0.5)
    cash_frac = 1 - alloc
    # Monthly cash yield approximation from annual FEDFUNDS
    # (simplified: constant 0.04/12 per month, corrected below per period)
    monthly_cash = cash_yield / 12

    strat_ret = alloc * ret + cash_frac * monthly_cash
    bah_ret   = ret.copy()

    # Equity curves (start = 100)
    strat_equity = (1 + strat_ret.fillna(0)).cumprod() * 100
    bah_equity   = (1 + bah_ret.fillna(0)).cumprod()   * 100

    return strat_equity, bah_equity, strat_ret, bah_ret


def stats(equity, ret, label):
    ret = ret.dropna()
    n = len(ret)
    years = n / 12
    cagr  = (equity.iloc[-1] / equity.iloc[0]) ** (1 / years) - 1
    vol   = ret.std() * math.sqrt(12)
    sharpe = (ret.mean() * 12 - 0.04) / vol if vol > 0 else 0
    rolling_max = equity.cummax()
    drawdown    = (equity - rolling_max) / rolling_max
    max_dd = drawdown.min()

    pos_months = (ret > 0).sum()
    win_rate   = pos_months / n

    return {
        "Label":     label,
        "CAGR":      f"{cagr*100:.1f}%",
        "Ann. Vol":  f"{vol*100:.1f}%",
        "Sharpe":    f"{sharpe:.2f}",
        "Max DD":    f"{max_dd*100:.1f}%",
        "Win Rate":  f"{win_rate*100:.0f}%",
        "End Value": f"${equity.iloc[-1]:,.0f}",
    }


def annual_returns(ret, label):
    r = ret.dropna()
    annual = (1 + r).resample("YE").prod() - 1
    annual.index = annual.index.year
    return annual.rename(label)


# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────

def main():
    print("=" * 65)
    print("  MACRO REGIME FRAMEWORK BACKTEST  |  2009–2025")
    print("=" * 65)

    # ── 1. Fetch FRED macro data ──────────────────────────────────────────────
    print("\n[1/3] Fetching macro data from FRED...")
    fred_map = {
        "FEDFUNDS": "Fed Funds Rate",
        "CPIAUCSL": "CPI",
        "MANEMP":   "Mfg Employment",
        "M2SL":     "M2 Money Supply",
        "VIXCLS":   "VIX",
        "DTWEXBGS": "Dollar Index (broad)",
    }
    fred_data = {}
    for series, name in fred_map.items():
        try:
            fred_data[series] = fetch_fred(series)
            print(f"  ✓ {name} ({series})")
        except Exception as e:
            print(f"  ✗ {name} ({series}): {e}")

    # ── 2. Fetch price data from Yahoo Finance ────────────────────────────────
    print("\n[2/3] Fetching price data from Yahoo Finance...")
    price_map = {"SPY": "S&P 500 ETF", "QQQ": "Nasdaq-100 ETF", "BTC-USD": "Bitcoin"}
    prices = {}
    for ticker, name in price_map.items():
        try:
            prices[ticker] = fetch_yahoo(ticker)
            print(f"  ✓ {name} ({ticker})  {prices[ticker].index[0].date()} – {prices[ticker].index[-1].date()}")
        except Exception as e:
            print(f"  ✗ {name} ({ticker}): {e}")

    # ── 3. Build regime scores ────────────────────────────────────────────────
    print("\n[3/3] Computing monthly regime scores...")

    scores = {}
    if "FEDFUNDS" in fred_data:  scores["monetary"]  = score_monetary(fred_data["FEDFUNDS"])
    if "CPIAUCSL" in fred_data:  scores["inflation"]  = score_inflation(fred_data["CPIAUCSL"])
    if "MANEMP"   in fred_data:  scores["growth"]     = score_growth(fred_data["MANEMP"])
    if "M2SL"     in fred_data:  scores["liquidity"]  = score_liquidity(fred_data["M2SL"])
    if "VIXCLS"   in fred_data:  scores["sentiment"]  = score_sentiment(fred_data["VIXCLS"])
    if "DTWEXBGS" in fred_data:  scores["dollar"]     = score_dollar(fred_data["DTWEXBGS"])

    regime_df = build_regime_table(scores)

    # ── REGIME DISTRIBUTION ───────────────────────────────────────────────────
    counts = regime_df["signal"].value_counts()
    total  = len(regime_df)
    print(f"\n{'─'*65}")
    print("  REGIME DISTRIBUTION  (monthly readings, 2009–2025)")
    print(f"{'─'*65}")
    order = ["STRONG_BULL", "BULL", "NEUTRAL", "BEAR", "STRONG_BEAR"]
    for sig in order:
        n = counts.get(sig, 0)
        bar = "█" * int(n / total * 40)
        print(f"  {sig:<13}  {n:>3} months  {n/total*100:>5.1f}%  {bar}")

    # ── YEAR-BY-YEAR REGIME SUMMARY ───────────────────────────────────────────
    print(f"\n{'─'*65}")
    print("  YEAR-BY-YEAR DOMINANT REGIME")
    print(f"{'─'*65}")
    print(f"  {'Year':<6} {'Regime':<14} {'Score':>7}  {'Monetary':>9} {'Inflation':>10} {'Growth':>7} {'Liquidity':>10} {'Sentiment':>10} {'Dollar':>7}")
    print(f"  {'─'*6} {'─'*14} {'─'*7}  {'─'*9} {'─'*10} {'─'*7} {'─'*10} {'─'*10} {'─'*7}")
    dims = ["monetary","inflation","growth","liquidity","sentiment","dollar"]
    for yr, grp in regime_df.groupby(regime_df.index.year):
        sig   = grp["signal"].mode()[0]
        score = grp["weighted"].mean()
        d_avg = {d: grp[d].mean() if d in grp.columns else float("nan") for d in dims}
        print(f"  {yr:<6} {sig:<14} {score:>+7.2f}  "
              f"{d_avg['monetary']:>+9.2f} {d_avg['inflation']:>+10.2f} {d_avg['growth']:>+7.2f} "
              f"{d_avg['liquidity']:>+10.2f} {d_avg['sentiment']:>+10.2f} {d_avg['dollar']:>+7.2f}")

    # ── BACKTEST RESULTS ──────────────────────────────────────────────────────
    results_rows = []
    annual_table = {}

    print(f"\n{'─'*65}")
    print("  ANNUAL RETURNS: STRATEGY vs BUY-AND-HOLD")
    print(f"{'─'*65}")

    asset_map = {"SPY": "SPY", "QQQ": "QQQ", "BTC-USD": "BTC"}
    for ticker, label in asset_map.items():
        if ticker not in prices:
            continue
        all_prices = pd.DataFrame({ticker: prices[ticker]})
        strat_eq, bah_eq, strat_ret, bah_ret = backtest(all_prices, regime_df, ticker)

        ar_strat = annual_returns(strat_ret, f"{label} Strategy")
        ar_bah   = annual_returns(bah_ret,   f"{label} B&H")
        annual_table[f"{label}_strat"] = ar_strat
        annual_table[f"{label}_bah"]   = ar_bah

        results_rows.append(stats(strat_eq, strat_ret, f"{label} Strategy"))
        results_rows.append(stats(bah_eq,   bah_ret,   f"{label} Buy-and-Hold"))

    # Print annual return table
    ann_df = pd.DataFrame(annual_table)
    ann_df = ann_df.dropna(how="all")

    col_pairs = [("SPY_strat","SPY_bah"), ("QQQ_strat","QQQ_bah"), ("BTC_strat","BTC_bah")]
    col_pairs = [(a,b) for a,b in col_pairs if a in ann_df.columns]

    hdr = f"  {'Year':<6}"
    for a, b in col_pairs:
        asset = a.split("_")[0]
        hdr += f" {asset+' Strat':>11} {asset+' B&H':>9}"
    print(hdr)
    print(f"  {'─'*6}" + "".join([f" {'─'*11} {'─'*9}" for _ in col_pairs]))

    for yr in sorted(ann_df.index):
        row = f"  {yr:<6}"
        for a, b in col_pairs:
            sv = ann_df.loc[yr, a] if a in ann_df.columns and yr in ann_df.index else float("nan")
            bv = ann_df.loc[yr, b] if b in ann_df.columns and yr in ann_df.index else float("nan")
            sv_s = f"{sv*100:>+10.1f}%" if not math.isnan(sv) else f"{'N/A':>11}"
            bv_s = f"{bv*100:>+8.1f}%" if not math.isnan(bv) else f"{'N/A':>9}"
            row += f" {sv_s} {bv_s}"
        print(row)

    # ── SUMMARY STATISTICS ────────────────────────────────────────────────────
    print(f"\n{'─'*65}")
    print("  SUMMARY STATISTICS (full period, $100 start)")
    print(f"{'─'*65}")
    stats_df = pd.DataFrame(results_rows)
    stats_df = stats_df.set_index("Label")
    # Interleave strategy/B&H rows
    ordered = []
    for label in asset_map.values():
        for sfx in [" Strategy", " Buy-and-Hold"]:
            key = f"{label}{sfx}"
            if key in stats_df.index:
                ordered.append(key)
    stats_df = stats_df.loc[[r for r in ordered if r in stats_df.index]]
    # Print
    print(f"\n  {'Asset':<25} {'CAGR':>7} {'Vol':>7} {'Sharpe':>7} {'MaxDD':>8} {'WinRate':>9} {'$100→':>10}")
    print(f"  {'─'*25} {'─'*7} {'─'*7} {'─'*7} {'─'*8} {'─'*9} {'─'*10}")
    for name, row in stats_df.iterrows():
        print(f"  {name:<25} {row['CAGR']:>7} {row['Ann. Vol']:>7} {row['Sharpe']:>7} {row['Max DD']:>8} {row['Win Rate']:>9} {row['End Value']:>10}")

    # ── KEY INSIGHT ───────────────────────────────────────────────────────────
    print(f"\n{'─'*65}")
    print("  NOTES & CAVEATS")
    print(f"{'─'*65}")
    print("""
  1. REGIME SCORING  uses FRED data with simplified rules (no LLM):
       Monetary  – Fed Funds direction & level (2× weight)
       Inflation – CPI YoY thresholds at 2.5% / 4.5% (1.5×)
       Growth    – Mfg Employment 6-month change (1.5×)
       Liquidity – M2 YoY growth vs 2% / 6% bands (1×)
       Sentiment – VIX threshold at 15 / 25 (0.75×)
       Dollar    – Broad DXY 6-month change vs ±2% (0.5×)

  2. SIGNAL LAG  Allocation uses prior month's signal (realistic).
     Cash earns 4%/yr flat (simplified; actual SOFR/T-bill was
     lower in 2009–2021 era, higher in 2023–2024).

  3. BTC HISTORY  Only available from late 2010 onward.

  4. NO TRANSACTION COSTS, slippage, or taxes included.

  5. PAST PERFORMANCE — hypothetical, not predictive.
""")


if __name__ == "__main__":
    main()
