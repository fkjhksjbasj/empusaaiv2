# PolyWhale — Trading Research Papers & Strategy Insights

> 15 academic papers + 6 prediction market studies = actionable edge for the Polymarket crypto scalper.
> Last updated: 2026-02-13

---

## Table of Contents

1. [Momentum Trading](#1-momentum-trading)
2. [Mean Reversion](#2-mean-reversion)
3. [Market Microstructure](#3-market-microstructure)
4. [Kelly Criterion for Binary Outcomes](#4-kelly-criterion)
5. [Prediction Market Efficiency](#5-prediction-market-efficiency)
6. [High-Frequency Crypto Trading](#6-high-frequency-crypto-trading)
7. [Technical Indicators for Scalping](#7-technical-indicators)
8. [Sentiment & News Trading](#8-sentiment--news)
9. [Statistical Arbitrage](#9-statistical-arbitrage)
10. [Risk Management](#10-risk-management)
11. [Volatility-Based Strategies](#11-volatility-strategies)
12. [Prediction Market Pricing & Structure](#12-prediction-market-pricing)
13. [Top 10 Actionable Insights](#top-10-actionable-insights)

---

## 1. Momentum Trading

### 1.1 Time-Series and Cross-Sectional Momentum in Crypto
- **Authors:** Han, Kang, Ryu | **Year:** 2023
- **Source:** SSRN 4675565
- **Finding:** Crypto momentum is profitable over 1-4 week formation periods (much shorter than equities). Buy when look-back return is in top third → Sharpe ratio 1.51.
- **Application:** For 5m/15m markets, track last 6-12 candles. If recent returns are in the top third historically, bet YES on "up". Momentum persistence is ~1 week for daily, compress proportionally for intraday.

### 1.2 Volume-Weighted Momentum
- **Authors:** Huang, Sangiorgi, Urquhart | **Year:** 2024
- **Source:** SSRN 4825389
- **Finding:** Volume-weighted returns provide stronger momentum signals than price-only. Volume confirms trend reliability.
- **Application:** Weight momentum signals by volume. High-volume moves are more reliable directional indicators. Implement volume-weighted moving average as primary signal.

### 1.3 Risk-Managed Momentum
- **Authors:** ScienceDirect | **Year:** 2025
- **Finding:** Crypto momentum crashes hard. Volatility-managed momentum (scale position inversely with volatility) improves risk-adjusted returns significantly.
- **Application:** `bet_size = base_size * (target_vol / realized_vol)`. When volatility spikes, reduce bets automatically. Prevents large losses during reversals — critical for 5m binary markets.

---

## 2. Mean Reversion

### 2.1 Trend-Following vs Mean-Reversion in Bitcoin
- **Authors:** Beluska, Vojtko | **Year:** 2024
- **Source:** QuantPedia / SSRN 4955617
- **Finding:** MAX strategy (buy at 10-day highs) outperformed MIN (buy at 10-day lows) post-2021. Trend-following is the dominant regime now.
- **Application:** Favor trend-following over mean-reversion for 1d markets. Only deploy mean-reversion during clearly range-bound periods (low ADX, narrow Bollinger Bands). For 5m/15m, mean reversion works within microstructure noise.

### 2.2 Pairs Trading in Crypto (5-minute frequency)
- **Authors:** Fil, Kristoufek | **Year:** 2020
- **Source:** IEEE Xplore 9200323
- **Finding:** At 5-minute frequency, pairs trading generated 236% total returns. Higher frequency >> daily frequency (-0.07% monthly).
- **Application:** Track spread between BTC and ETH Polymarket positions. When one deviates from the other, bet on convergence. Direct stat-arb at 5-minute timeframe.

### 2.3 Copula-Based Pairs Trading
- **Authors:** Financial Innovation, Springer | **Year:** 2024
- **Finding:** Copula-based 5-minute pairs trading: 75.2% annualized returns, Sharpe 3.77.
- **Application:** If BTC 5m goes up but ETH 5m hasn't yet, and they're historically correlated, bet YES on ETH up. Cross-asset mean reversion.

---

## 3. Market Microstructure

### 3.1 Order Flow Imbalance — #1 Short-Term Predictor
- **Authors:** arXiv 2602.00776 | **Year:** 2026
- **Finding:** Three dominant predictors: (1) Order flow imbalance — the single most important, near-linear effect; (2) Bid-ask spreads — wider = less predictable; (3) VWAP-to-mid deviations.
- **Application:** Before every 5m bet, check exchange order book imbalance. Strong buy-side = bet YES. Wide spreads = reduce size or skip. Act early in the window (signal decays fast).

### 3.2 VPIN — Predicting Price Jumps
- **Authors:** North American J. of Economics & Finance | **Year:** 2025
- **Finding:** VPIN (Volume-Synchronized Probability of Informed Trading) predicts BTC price jumps. Elevated VPIN = informed traders are active, large move imminent.
- **Application:** Track buy/sell volume imbalance in fixed volume buckets. VPIN > 0.7 = jump coming. For 5m markets near close, high VPIN means strong directional conviction — follow the imbalance direction.

### 3.3 Order Flow and Returns
- **Authors:** Cont, Kukanov, Stoikov (foundational) | **Year:** 2019-2026
- **Finding:** Order flow imbalance has near-linear relationship with short-horizon price changes. Effect is short-lived (seconds to minutes).
- **Application:** Calculate real-time order flow at 1-second intervals. Strongly positive in first 1-2 minutes of 5m window = bet YES. Signal decays rapidly, so act early.

---

## 4. Kelly Criterion

### 4.1 Kelly for Prediction Markets (DIRECTLY APPLICABLE)
- **Authors:** arXiv 2412.14144 | **Year:** 2024
- **Finding:** For binary contract with market price `p` and your probability `q`: `f* = (Q - P) / (1 + Q)` where `Q = q/(1-q)`, `P = p/(1-p)`. Market prices ≠ true probabilities — exploitable gaps exist.
- **Application:** Before every bet: compute your model's probability `q`, get market price `p`, compute Kelly fraction. Only bet when `q > p` (YES) or `q < p` (NO). Use fractional Kelly.

### 4.2 Fractional Kelly
- **Authors:** Thorp (2008), MacLean et al. (2004)
- **Finding:** Half-Kelly reduces volatility ~75% while sacrificing only ~25% growth. Full Kelly has 50% chance of 50% drawdown. Most pros use quarter-to-half Kelly.
- **Application:** **NEVER use full Kelly.** Implement quarter-Kelly (f*/4). With $1 bets and many trades/day, keeps individual bets tiny relative to bankroll, ensuring survival.

### 4.3 Kelly as Model Evaluation
- **Authors:** arXiv 2602.09982 | **Year:** 2025
- **Finding:** Track cumulative log-wealth of Kelly-sized bets as real-time model accuracy measure. Declining log-wealth = miscalibrated model.
- **Application:** If cumulative log-wealth declines over 50 trades, model is making systematically wrong probability estimates. Auto-reduce bet sizes or halt.

---

## 5. Prediction Market Efficiency

### 5.1 Polymarket Accuracy Study
- **Authors:** Reichenbach, Walther | **Year:** 2025
- **Source:** SSRN 5910522
- **Finding:** Polymarket Brier score 0.05-0.06 within one day of settlement (vs 0.21 for sports models). Slight YES overtrade bias. No longshot bias.
- **Application:** Exploitable window is early in market life. For 5m markets, first 1-2 minutes have widest mispricings. YES overtrade bias = slight systematic value on NO bets.

### 5.2 $40M Arbitrage Profits on Polymarket
- **Authors:** Saguillo et al. | **Year:** 2025
- **Source:** arXiv 2508.03474 / AFT 2025
- **Finding:** 86 million bets analyzed. Two arb types: (1) Market Rebalancing — YES+NO < $1.00 = free money; (2) Combinatorial — cross-market logical dependencies. Top 10 arbers captured $8.18M.
- **Application:** Continuously monitor YES+NO price sum. If YES=$0.52, NO=$0.46 (sum=$0.98), buy both for guaranteed $0.02. Also check cross-timeframe dependencies (if BTC 1h up, at least one 15m sub-period must be up).

### 5.3 Longshot Bias
- **Authors:** QuantPedia | **Year:** 2024-2025
- **Finding:** Favorites lose -3.64% vs longshots lose -26.08%. Favorites are systematically underpriced.
- **Application:** Bet WITH momentum at extremes. When YES is at 80c+, the 20c NO is a longshot trap — avoid it. Go with the crowd at extreme prices.

---

## 6. High-Frequency Crypto Trading

### 6.1 Automatic Crypto Scalping System
- **Authors:** ResearchGate | **Year:** 2024
- **Finding:** EMA+VWAP scalping bot achieved 86.7% win rate, 120 USDT profit in 2 hours. 15-50ms latency. WebSocket for real-time data.
- **Application:** Target 85%+ win rate with small per-trade profits. EMA+VWAP as baseline signals. The latency benchmark is achievable in a JS service worker.

### 6.2 Latency Arbitrage
- **Authors:** Alexander | **Year:** 2025
- **Source:** SSRN 5143158
- **Finding:** Arb opportunities have decreased on major exchanges but still exist on newer/less liquid platforms. Execution speed is the primary determinant.
- **Application:** Polymarket 5m markets are relatively new + thin liquidity = latency advantages exist. Pre-sign transactions, maintain hot wallet, use CLOB API directly. Being 1-2s faster than manual traders captures edge.

### 6.3 Dynamic Fees on Polymarket (CRITICAL)
- **Source:** Finance Magnates | **Year:** 2025-2026
- **Finding:** One wallet turned $313→$414,000 in one month via latency arb on 15m crypto markets. Dynamic taker fee: ~1.56-3.15% at 50c, ~0.20% at extremes. Maker orders = 0% fee + rebates. Break-even win rate: 52-53%.
- **Application:**
  - **Use maker orders** (free + earn rebates) instead of taker orders
  - **Trade at extreme prices** (20c or 80c) where fees are minimal
  - **Market-making strategy viable**: post YES@48c + NO@52c, earn spread + rebates
  - **Need 55%+ win rate** after fees to be profitable

---

## 7. Technical Indicators

### 7.1 VWAP + Bollinger + RSI Triple Filter
- **Source:** FMZQuant | **Year:** 2024
- **Finding:** RSI identifies overbought/oversold, Bollinger defines volatility envelope, VWAP acts as trend filter. Triple-confirmation reduces false signals significantly.
- **Application:** For 1h markets: RSI>70 + price touching upper band + above VWAP = bet YES. RSI<30 + lower band + below VWAP = bet NO.

### 7.2 Ultra-Short RSI Settings
- **Source:** FXOpen | **Year:** 2026
- **Finding:** For 1-minute scalping: RSI period=4, thresholds 80/20 (not standard 70/30). Bollinger 20-period SMA, 2 SD.
- **Application:** For 5m Polymarket markets, use RSI(4) not RSI(14). Tighter 80/20 thresholds. RSI(4)>80 + breaks upper BB + above VWAP = strong YES signal.

---

## 8. Sentiment & News

### 8.1 Twitter Sentiment Impact
- **Source:** MDPI | **Year:** 2025
- **Finding:** Negative sentiment causes IMMEDIATE volatility spikes. Positive sentiment has delayed but lasting effect. Sentiment > fundamentals for crypto volatility.
- **Application:** Negative news = bet "down" immediately (instant impact). Positive news = wait then bet "up" (delayed effect). For 1h/1d markets, monitor sentiment shift early in window.

### 8.2 Keyword-Weighted Sentiment
- **Authors:** J. of International Financial Markets | **Year:** 2024
- **Finding:** Not all sentiment equal. "hack", "SEC", "ban", "crash" have 3-5x price impact vs generic sentiment. "ETF", "adoption", "institutional" carry extra positive weight.
- **Application:** Build keyword-weighted model. Specific fear words >> generic negative. Specific adoption words >> generic positive.

### 8.3 Whales + Sentiment Alignment
- **Source:** ScienceDirect | **Year:** 2025
- **Finding:** Whale trades + social media sentiment create predictable volatility waves. Combined signal is strongest.
- **Application:** When whale trades AND sentiment align = strongest signal. Whale tracker IS the edge — combine with sentiment for maximum conviction.

---

## 9. Statistical Arbitrage

### 9.1 Cross-Exchange BTC Arbitrage
- **Authors:** Kristoufek, Bouri | **Year:** 2023
- **Finding:** Price discrepancies persist longer during high blockchain congestion.
- **Application:** Monitor Polygon network congestion. High congestion = Polymarket prices lag behind Binance spot = information asymmetry window for the bot.

### 9.2 Crypto Derivatives Arbitrage
- **Source:** ScienceDirect | **Year:** 2024
- **Finding:** Spot and futures markets are highly segmented with recurrent cross-market inefficiencies.
- **Application:** Compare Polymarket YES/NO prices to Deribit options implied probabilities. If Deribit implies 60% BTC up but Polymarket YES is at $0.55, there's a 5-cent edge.

---

## 10. Risk Management

### 10.1 Position Sizing & Stop Discipline
- **Authors:** Blotnick | **Year:** 2025
- **Source:** SSRN 5498759
- **Finding:** Daily loss limits + per-trade max loss + pre-determined exits prevent catastrophic drawdowns. Binary markets simplify this: position size IS the stop-loss.
- **Application:** Daily loss limit (10% bankroll). After 5 consecutive losses, halt for cooldown. The $1 bet size = $1 max loss per trade.

### 10.2 Drawdown Control via Worst-Case Sizing
- **Authors:** Strub | **Year:** 2018
- **Finding:** Size positions for worst-case, not average case. Track worst historical losing streak and ensure survival through 2x repeat.
- **Application:** If worst streak = 8 losses, ensure 8×max_bet < 50% bankroll. With $100 bankroll: max bet = $6.25. With $1 bets: extremely safe.

### 10.3 ATR-Based Dynamic Sizing
- **Source:** Semantic Scholar / LuxAlgo | **Year:** 2024
- **Finding:** ATR-based trailing stops with multiplier 1.5-2x reduce whipsaw exits by 40-60%.
- **Application:** Calculate 5m ATR on underlying crypto. ATR > 2x mean = too volatile, skip or reduce size. ATR normal = signals reliable, normal size.

---

## 11. Volatility Strategies

### 11.1 Regime-Switching
- **Source:** Applied Economics | **Year:** 2023
- **Finding:** Two regimes: low-vol (trending, predictable) and high-vol (chaotic, correlated). Diversification least effective during high-vol.
- **Application:** Low-vol regime → momentum/trend-following, normal bets. High-vol regime → reduce bets 50-75%, switch to mean-reversion or skip. Detector: if 1h realized vol > 2x 24h average = high-vol regime.

### 11.2 Asymmetric Volatility
- **Source:** Virtual Economics | **Year:** 2025
- **Finding:** EGARCH shows bad news increases volatility MORE than good news (asymmetric). Down moves are larger and more predictable.
- **Application:** Bet "down" with higher confidence after negative catalysts than "up" after positive ones. The asymmetry means bearish signals are more reliable.

### 11.3 Adaptive Strategy Selection
- **Authors:** Palazzi | **Year:** 2025
- **Finding:** Momentum dominated pre-2021, BTC-neutral mean-reversion excels post-2021. Strategy must adapt to regime.
- **Application:** Strategy router: ADX>25 → momentum. ADX<20 → mean-reversion. Extreme vol → skip/reduce. Adaptive approach captures regime switching.

---

## 12. Prediction Market Pricing

### 12.1 Black-Scholes for Prediction Markets
- **Authors:** Shaw Dalen | **Year:** 2025
- **Source:** arXiv 2510.15205
- **Finding:** Logit jump-diffusion model with three tradable risk factors: belief volatility, jump intensity, cross-event dependence. Creates implied vol surface for prediction markets.
- **Application:** If a 50c contract hasn't moved despite BTC trending strongly for 10 minutes, that's a quantifiable mispricing. The model prices what the contract SHOULD be worth given time elapsed and underlying movement.

### 12.2 Volatility Time-Decay in Binary Markets
- **Authors:** Luckner, Weinhardt | **Year:** 2008
- **Source:** NYU CeDER-08-07
- **Finding:** Volatility ∝ 1/√(time-to-expiry). At price=50c: near expiry = EXTREME volatility. At price=90c: low volatility regardless of time.
- **Application:** 15m market at minute 12 with price at 50c → volatility exploding. 5m market at minute 3 → "volatility explosion zone" begins. Either take a directional position on micro-momentum or market-make both sides.

### 12.3 Large Trades Predict Returns
- **Authors:** Ng, Peng, Tao, Zhou | **Year:** 2026
- **Source:** SSRN 5331995
- **Finding:** Net order imbalance from large trades strongly predicts subsequent returns. Polymarket leads Kalshi in price discovery.
- **Application:** Monitor order book for sudden large buys on YES/NO. Whale $5K+ order at minute 2 of a 15m market → price discovery says market continues that direction. Academic justification for whale-following / copy-trading.

### 12.4 Bad Model Can Beat the Market
- **Authors:** Hubacek, Sir | **Year:** 2023
- **Source:** arXiv 2010.12508 / Int'l J. of Forecasting
- **Finding:** You do NOT need better predictions than the market. You need DECORRELATED errors. Structural advantage of being a market taker (choose when to trade).
- **Application:** Don't predict BTC direction better than the market — find where market pricing is systematically wrong. If market under-reacts to 3-minute momentum (stays near 50c), that's a decorrelated edge.

### 12.5 Market Manipulation Detection
- **Authors:** Rasooly, Rozzi | **Year:** 2025
- **Source:** arXiv 2503.03312
- **Finding:** 817-market experiment: manipulation effects visible 60 days later. Thin markets more susceptible. More traders = harder to manipulate.
- **Application:** In thin 15m markets, whale orders can push price 50c→65c with no BTC move = manipulation → fade it. If whale trade IS backed by BTC spot move = information → follow it. Compare Polymarket move vs Binance spot simultaneously.

### 12.6 Informed vs Noise Traders (Kyle Model)
- **Authors:** Bossaerts et al. | **Year:** 2024
- **Source:** J. of Financial Markets Vol 68
- **Finding:** Only a small subset (~5-10%) of traders drive price accuracy. Rest are noise.
- **Application:** Track which whales' trades consistently (1) move the market AND (2) are correct at resolution. Those are informed traders — follow them. Whales who move prices but lose = manipulators — fade them.

---

## Top 10 Actionable Insights

| Priority | Insight | Source | How to Implement |
|----------|---------|--------|-----------------|
| 1 | **Quarter-Kelly bet sizing** | Thorp, arXiv 2024 | `bet = bankroll * 0.25 * (Q-P)/(1+Q)` |
| 2 | **Order flow imbalance** = #1 predictor | arXiv 2026 | Monitor Binance order book in real-time |
| 3 | **Volume-weighted momentum** > price-only | Huang 2024 | Weight signals by volume; high-vol moves = reliable |
| 4 | **Volatility regime detection** | Multiple papers | Low vol = momentum; High vol = reduce or skip |
| 5 | **YES+NO price sum arbitrage** | AFT 2025 | If sum < $1.00, buy both for risk-free profit |
| 6 | **Use maker orders** (0% fee + rebates) | Finance Magnates | Post limit orders, avoid taker fees at 50c |
| 7 | **Trend-following > mean-reversion** post-2021 | Beluska 2024 | Favor momentum; mean-revert only in range-bound |
| 8 | **RSI(4) + BB + VWAP** for 5m markets | FXOpen 2026 | Fast RSI, tight 80/20 thresholds |
| 9 | **Negative sentiment = instant impact** | MDPI 2025 | Bad news → bet "down" immediately |
| 10 | **Track Kelly log-wealth** for model health | arXiv 2025 | Declining over 50 trades = halt and recalibrate |

---

## References

1. Han, Kang, Ryu — SSRN 4675565 (2023)
2. Huang, Sangiorgi, Urquhart — SSRN 4825389 (2024)
3. Beluska, Vojtko — SSRN 4955617 (2024)
4. Fil, Kristoufek — IEEE 9200323 (2020)
5. arXiv 2602.00776 — Crypto Microstructure (2026)
6. arXiv 2412.14144 — Kelly for Prediction Markets (2024)
7. Thorp — Kelly Capital Growth (2008)
8. Reichenbach, Walther — SSRN 5910522 (2025)
9. Saguillo et al. — arXiv 2508.03474 (2025)
10. Alexander — SSRN 5143158 (2025)
11. Shaw Dalen — arXiv 2510.15205 (2025)
12. Luckner, Weinhardt — NYU CeDER-08-07 (2008)
13. Ng, Peng, Tao, Zhou — SSRN 5331995 (2026)
14. Hubacek, Sir — arXiv 2010.12508 (2023)
15. Rasooly, Rozzi — arXiv 2503.03312 (2025)
16. Bossaerts et al. — J. Financial Markets Vol 68 (2024)
17. QuantPedia — Systematic Edges Survey (2025)
18. Finance Magnates — Polymarket Dynamic Fees (2025)
19. MDPI 2306-5729 — Crypto Sentiment (2025)
20. Blotnick — SSRN 5498759 (2025)
21. Palazzi — J. Futures Markets (2025)
