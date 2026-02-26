#!/usr/bin/env python3
"""
Focused 2024–2025 Backtest: BTC, QQQ, Gold
Month-by-month regime signals, entry/exit points, gold rotation timing.
"""

import io, math, requests
import pandas as pd
import numpy as np

pd.set_option("display.float_format", "{:.2f}".format)

START = "2023-06-01"   # 6-month lookback for indicator changes
SHOW  = "2024-01-01"
END   = "2025-12-31"

# ── WEIGHTS ───────────────────────────────────────────────────────────────────
DIM_WEIGHTS = {"monetary":2.0,"inflation":1.5,"growth":1.5,"liquidity":1.0,"sentiment":0.75,"dollar":0.5}
MAX_W = sum(DIM_WEIGHTS.values())  # 7.25

ALLOCS = {
    "STRONG_BULL": {"QQQ":1.00,"BTC":1.00,"GLD":0.50},
    "BULL":        {"QQQ":1.00,"BTC":0.80,"GLD":0.75},
    "NEUTRAL":     {"QQQ":0.50,"BTC":0.75,"GLD":1.00},
    "BEAR":        {"QQQ":0.25,"BTC":0.25,"GLD":1.00},
    "STRONG_BEAR": {"QQQ":0.00,"BTC":0.00,"GLD":1.00},
}

SIG_COLORS = {
    "STRONG_BULL": "🟢🟢",
    "BULL":        "🟢  ",
    "NEUTRAL":     "🟡  ",
    "BEAR":        "🔴  ",
    "STRONG_BEAR": "🔴🔴",
}

def get_signal(w):
    if w >= 4:  return "STRONG_BULL"
    if w >= 2:  return "BULL"
    if w >= -1: return "NEUTRAL"
    if w >= -3: return "BEAR"
    return "STRONG_BEAR"

# ── FETCH ──────────────────────────────────────────────────────────────────────
def fred(sid):
    r = requests.get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}", timeout=15)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text), parse_dates=["observation_date"], index_col="observation_date")
    df.columns = [sid]
    return df.replace(".", np.nan).astype(float)

def yahoo(ticker):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
           f"?interval=1mo&period1={int(pd.Timestamp(START).timestamp())}"
           f"&period2={int(pd.Timestamp(END).timestamp())}")
    r = requests.get(url, headers={"User-Agent":"Mozilla/5.0"}, timeout=15)
    r.raise_for_status()
    d = r.json()["chart"]["result"][0]
    s = pd.Series(d["indicators"]["adjclose"][0]["adjclose"],
                  index=pd.to_datetime(d["timestamp"], unit="s").normalize(),
                  name=ticker)
    return s.resample("MS").last().dropna()

# ── SCORING ────────────────────────────────────────────────────────────────────
def score_monetary(ff):
    s = ff["FEDFUNDS"].resample("MS").mean()
    chg3 = s.diff(3); chg12 = s.diff(12)
    sc = pd.Series(0.0, index=s.index)
    sc[s < 0.5]                          =  1   # ZIRP
    sc[(chg12 < -0.5) | (chg3 < -0.25)] =  1   # cutting
    sc[(chg12 > 1.0)  & (s > 3.0)]      = -1   # hiking hard
    return sc.rename("monetary")

def score_inflation(cpi):
    yoy = cpi["CPIAUCSL"].resample("MS").last().ffill().pct_change(12)*100
    sc = pd.Series(0.0, index=yoy.index)
    sc[yoy < 2.5]  =  1
    sc[yoy > 4.5]  = -1
    # 2.5-3.5 neutral; 3.5-4.5 = -0.5 (partial bear) — use 0 for simplicity
    return sc.rename("inflation")

def score_growth(emp):
    m = emp["MANEMP"].resample("MS").last().ffill()
    chg6 = m.diff(6)
    sc = pd.Series(0.0, index=m.index)
    sc[chg6 >  30] =  1
    sc[chg6 < -30] = -1
    return sc.rename("growth")

def score_liquidity(m2):
    yoy = m2["M2SL"].resample("MS").last().ffill().pct_change(12)*100
    sc = pd.Series(0.0, index=yoy.index)
    sc[yoy > 6] =  1
    sc[yoy < 2] = -1
    return sc.rename("liquidity")

def score_sentiment(vix):
    v = vix["VIXCLS"].resample("MS").mean().ffill()
    sc = pd.Series(0.0, index=v.index)
    sc[v < 15] =  1
    sc[v > 25] = -1
    return sc.rename("sentiment")

def score_dollar(dxy):
    d = dxy["DTWEXBGS"].resample("MS").last().ffill()
    chg6 = d.pct_change(6)*100
    sc = pd.Series(0.0, index=d.index)
    sc[chg6 < -2] =  1
    sc[chg6 >  2] = -1
    return sc.rename("dollar")

def build_regimes(scores):
    df = pd.concat(scores, axis=1).loc[START:END]
    w = sum(df[d]*v for d,v in DIM_WEIGHTS.items()) / MAX_W * 6
    df["weighted"] = w.round(2)
    df["signal"]   = df["weighted"].apply(get_signal)
    return df

# ── BACKTEST ENGINE ────────────────────────────────────────────────────────────
def run(price_series, regime_df, asset, label):
    p  = price_series.resample("MS").last().ffill()
    mr = p.pct_change()
    idx = regime_df.loc[SHOW:].index.intersection(mr.index)

    sig   = regime_df["signal"].reindex(idx).shift(1)   # use previous month's signal
    ret   = mr.reindex(idx)
    alloc = sig.map(lambda s: ALLOCS.get(s, {}).get(asset, 0.5) if pd.notna(s) else 0.5)

    # Approximate cash yield per month (Fed Funds / 12)
    ff_monthly = regime_df.get("monetary_raw", pd.Series(5.0, index=idx))
    cash_yield = 0.05 / 12  # ~5% for 2024-2025 (SOFR era)

    strat = (alloc * ret + (1 - alloc) * cash_yield).fillna(0)
    bah   = ret.fillna(0)

    strat_eq = (1 + strat).cumprod() * 100
    bah_eq   = (1 + bah).cumprod()   * 100

    return pd.DataFrame({
        f"{label}_alloc":  alloc,
        f"{label}_strat":  strat,
        f"{label}_bah":    bah,
        f"{label}_strat_eq": strat_eq,
        f"{label}_bah_eq":   bah_eq,
    })

def fmt_pct(v):
    if math.isnan(v): return "   N/A  "
    s = f"{v*100:+.1f}%"
    return f"{s:>8}"

def fmt_alloc(v):
    if math.isnan(v): return "  ─  "
    return f"{v*100:.0f}%"

# ── MAIN ───────────────────────────────────────────────────────────────────────
def main():
    print("=" * 78)
    print("  2024–2025 FOCUSED BACKTEST  |  BTC · QQQ · GOLD")
    print("=" * 78)

    print("\nFetching data...")
    ff  = fred("FEDFUNDS")
    cpi = fred("CPIAUCSL")
    emp = fred("MANEMP")
    m2  = fred("M2SL")
    vix = fred("VIXCLS")
    dxy = fred("DTWEXBGS")

    btc = yahoo("BTC-USD")
    qqq = yahoo("QQQ")
    gld = yahoo("GLD")

    print("  ✓ All data loaded\n")

    # Build regime table
    scores = [
        score_monetary(ff),
        score_inflation(cpi),
        score_growth(emp),
        score_liquidity(m2),
        score_sentiment(vix),
        score_dollar(dxy),
    ]
    reg = build_regimes(scores)

    # Run backtests
    btc_df = run(btc, reg, "BTC",  "BTC")
    qqq_df = run(qqq, reg, "QQQ",  "QQQ")
    gld_df = run(gld, reg, "GLD",  "GLD")

    # Combine
    all_df = pd.concat([reg.loc[SHOW:], btc_df, qqq_df, gld_df], axis=1)

    # ── MONTH-BY-MONTH SIGNAL TABLE ────────────────────────────────────────────
    dims = ["monetary","inflation","growth","liquidity","sentiment","dollar"]
    print(f"{'─'*78}")
    print("  MONTH-BY-MONTH REGIME SIGNALS  (score uses prior-month lag for trading)")
    print(f"{'─'*78}")
    print(f"  {'Month':<8} {'Signal':<13} {'Score':>6}  {'Mon':>4} {'Inf':>4} {'Gro':>4} {'Liq':>4} {'Sen':>4} {'Dol':>4}  "
          f"{'BTC%':>7} {'BTC alloc':>9}  {'QQQ%':>7} {'QQQ alloc':>9}  {'GLD%':>7} {'GLD alloc':>9}")
    print(f"  {'─'*8} {'─'*13} {'─'*6}  {'─'*4} {'─'*4} {'─'*4} {'─'*4} {'─'*4} {'─'*4}  "
          f"{'─'*7} {'─'*9}  {'─'*7} {'─'*9}  {'─'*7} {'─'*9}")

    prev_sig = None
    for dt, row in all_df.iterrows():
        sig    = row.get("signal", "─")
        score  = row.get("weighted", float("nan"))
        icon   = SIG_COLORS.get(sig, "   ")
        change = " ◄ REGIME CHANGE" if sig != prev_sig and prev_sig is not None else ""

        d_vals = "  ".join(f"{row.get(d, float('nan')):>+.0f}" for d in dims)

        btc_ret   = row.get("BTC_bah",  float("nan"))
        qqq_ret   = row.get("QQQ_bah",  float("nan"))
        gld_ret   = row.get("GLD_bah",  float("nan"))
        btc_alloc = row.get("BTC_alloc", float("nan"))
        qqq_alloc = row.get("QQQ_alloc", float("nan"))
        gld_alloc = row.get("GLD_alloc", float("nan"))

        mo = dt.strftime("%b %Y")
        score_s = f"{score:>+.2f}" if not math.isnan(score) else "  ─  "

        print(f"  {mo:<8} {icon}{sig:<11} {score_s}  "
              f"{row.get('monetary',0):>+.0f}  {row.get('inflation',0):>+.0f}  "
              f"{row.get('growth',0):>+.0f}  {row.get('liquidity',0):>+.0f}  "
              f"{row.get('sentiment',0):>+.0f}  {row.get('dollar',0):>+.0f}  "
              f"{fmt_pct(btc_ret)} {fmt_alloc(btc_alloc):>9}  "
              f"{fmt_pct(qqq_ret)} {fmt_alloc(qqq_alloc):>9}  "
              f"{fmt_pct(gld_ret)} {fmt_alloc(gld_alloc):>9}"
              f"{change}")
        prev_sig = sig

    # ── BTC NARRATIVE ──────────────────────────────────────────────────────────
    print(f"\n{'─'*78}")
    print("  BTC DEEP-DIVE: Entry/Exit signals 2024–2025")
    print(f"{'─'*78}")

    btc_price = btc.reindex(all_df.index).ffill()
    btc_alloc = all_df["BTC_alloc"]

    prev_alloc = None
    print(f"\n  {'Date':<10} {'Action':<32} {'BTC Price':>12} {'Allocation':>10}")
    print(f"  {'─'*10} {'─'*32} {'─'*12} {'─'*10}")
    for dt, alloc in btc_alloc.items():
        if math.isnan(alloc): continue
        price = btc_price.get(dt, float("nan"))
        price_s = f"${price:>10,.0f}" if not math.isnan(price) else f"{'N/A':>11}"

        if prev_alloc is None:
            action = f"Initial position"
            print(f"  {dt.strftime('%b %Y'):<10} {action:<32} {price_s} {alloc*100:.0f}%")
        elif abs(alloc - prev_alloc) > 0.01:
            delta = alloc - prev_alloc
            if alloc == 0:
                action = "🔴 EXIT FULL — move to cash"
            elif prev_alloc == 0:
                action = f"🟢 ENTER {alloc*100:.0f}% — regime turning"
            elif delta > 0:
                action = f"🟢 INCREASE {prev_alloc*100:.0f}% → {alloc*100:.0f}%"
            else:
                action = f"🔴 REDUCE   {prev_alloc*100:.0f}% → {alloc*100:.0f}%"
            print(f"  {dt.strftime('%b %Y'):<10} {action:<32} {price_s} {alloc*100:.0f}%")

        prev_alloc = alloc

    # ── GOLD ROTATION ──────────────────────────────────────────────────────────
    print(f"\n{'─'*78}")
    print("  GOLD ROTATION: When framework called max gold exposure")
    print(f"{'─'*78}")

    gld_price  = gld.reindex(all_df.index).ffill()
    gld_alloc  = all_df["GLD_alloc"]
    sig_series = all_df["signal"]

    prev_ga = None
    print(f"\n  {'Date':<10} {'Signal':<14} {'Gold Alloc':>10} {'GLD Price':>10} {'Action'}")
    print(f"  {'─'*10} {'─'*14} {'─'*10} {'─'*10} {'─'*30}")
    for dt in all_df.index:
        ga  = gld_alloc.get(dt, float("nan"))
        sig = sig_series.get(dt, "─")
        if math.isnan(ga): continue
        gp  = gld_price.get(dt, float("nan"))
        gp_s = f"${gp:.2f}" if not math.isnan(gp) else "N/A"

        note = ""
        if prev_ga is not None and abs(ga - prev_ga) > 0.01:
            if ga > prev_ga:   note = f"↑ Add gold ({prev_ga*100:.0f}%→{ga*100:.0f}%)"
            else:              note = f"↓ Trim gold ({prev_ga*100:.0f}%→{ga*100:.0f}%)"
        print(f"  {dt.strftime('%b %Y'):<10} {sig:<14} {ga*100:.0f}%{'':<8} {gp_s:>10}  {note}")
        prev_ga = ga

    # ── CUMULATIVE PERFORMANCE TABLE ───────────────────────────────────────────
    print(f"\n{'─'*78}")
    print("  CUMULATIVE PERFORMANCE (strategy vs buy-and-hold, base=100)")
    print(f"{'─'*78}")

    milestones = ["Jan 2024","Jun 2024","Sep 2024","Dec 2024","Mar 2025","Jun 2025","Sep 2025","Dec 2025"]
    print(f"\n  {'Date':<12} {'BTC Strat':>10} {'BTC B&H':>9}  {'QQQ Strat':>10} {'QQQ B&H':>9}  {'GLD Strat':>10} {'GLD B&H':>9}")
    print(f"  {'─'*12} {'─'*10} {'─'*9}  {'─'*10} {'─'*9}  {'─'*10} {'─'*9}")

    for mo_str in milestones:
        try:
            dt = pd.Timestamp(mo_str)
            # find closest month in index
            idx_arr = all_df.index
            closest = idx_arr[abs(idx_arr - dt).argmin()]
            row = all_df.loc[closest]
            bs = row.get("BTC_strat_eq",  float("nan"))
            bb = row.get("BTC_bah_eq",    float("nan"))
            qs = row.get("QQQ_strat_eq",  float("nan"))
            qb = row.get("QQQ_bah_eq",    float("nan"))
            gs = row.get("GLD_strat_eq",  float("nan"))
            gb = row.get("GLD_bah_eq",    float("nan"))
            def fe(v): return f"{v:>8.1f}" if not math.isnan(v) else "     N/A"
            print(f"  {closest.strftime('%b %Y'):<12} {fe(bs)}  {fe(bb)}   {fe(qs)}  {fe(qb)}   {fe(gs)}  {fe(gb)}")
        except Exception:
            pass

    # ── FINAL STATS ────────────────────────────────────────────────────────────
    print(f"\n{'─'*78}")
    print("  SUMMARY: 2024–2025 ONLY")
    print(f"{'─'*78}")

    for label, strat_col, bah_col in [
        ("BTC", "BTC_strat", "BTC_bah"),
        ("QQQ", "QQQ_strat", "QQQ_bah"),
        ("GLD", "GLD_strat", "GLD_bah"),
    ]:
        s = all_df[strat_col].dropna()
        b = all_df[bah_col].dropna()
        if s.empty: continue

        def summary(r):
            n    = len(r)
            tot  = (1+r).prod() - 1
            vol  = r.std() * math.sqrt(12)
            mdd  = ((1+r).cumprod() / (1+r).cumprod().cummax() - 1).min()
            wr   = (r>0).mean()
            return tot, vol, mdd, wr

        st, sv, smdd, swr = summary(s)
        bt, bv, bmdd, bwr = summary(b)

        print(f"\n  {label}")
        print(f"    {'':25} {'Strategy':>10} {'Buy-Hold':>10}")
        print(f"    {'Total Return':<25} {st*100:>+9.1f}% {bt*100:>+9.1f}%")
        print(f"    {'Ann. Volatility':<25} {sv*100:>9.1f}% {bv*100:>9.1f}%")
        print(f"    {'Max Drawdown':<25} {smdd*100:>9.1f}% {bmdd*100:>9.1f}%")
        print(f"    {'Win Rate (monthly)':<25} {swr*100:>9.0f}% {bwr*100:>9.0f}%")

    print(f"\n{'─'*78}")
    print("  KEY SIGNAL NOTES")
    print(f"{'─'*78}")
    print("""
  The 1-month signal lag means:
  • Jan 2024 allocation = based on Dec 2023 regime signal
  • Signal change in month M → allocation adjusts in month M+1

  Gold allocation logic (from framework):
  • STRONG_BULL → Gold 50%  (trim gold, buy risk)
  • BULL        → Gold 75%
  • NEUTRAL     → Gold 100% (max gold)
  • BEAR        → Gold 100% (max gold)
  • STRONG_BEAR → Gold 100% (max gold)
""")

if __name__ == "__main__":
    main()
