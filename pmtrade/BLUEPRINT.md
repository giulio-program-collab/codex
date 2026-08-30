# BLUEPRINT.md — Build specification

Companion to `CLAUDE.md`, which holds the non-negotiable rules. This file holds
the design. Where the two conflict, `CLAUDE.md` wins.

Venue: **Kalshi**. Domain: **economics / Fed contracts**. Accurate as of August 2026.

---

## 1. Scope and definition of done

### What this builds

A research system that answers one question: **does a measurable, repeatable
edge exist over Kalshi's prices on economic contracts, after costs?**

The system is done when it can produce a defensible answer with a confidence
interval. "No edge found" is a complete and successful outcome. It is in fact
the most likely one, and the architecture is designed to reach it cheaply.

### What this does not build

Live order placement. Milestones M0–M10 use `DryRunBroker` only. Anything beyond
that requires a separate, human-authorised decision made after reviewing the M10
report, and is out of scope for this specification.

### Why the scope is drawn here

The plumbing — API clients, dashboards, sizing formulas — is perhaps 20% of the
work and none of the difficulty. The difficulty is that a strategy can look
excellent in backtest and be worthless live, and the gap is caused by four
things: lookahead in the data, optimistic fills, unmodelled costs, and too small
a sample. Sections 5, 6, 8 and 10 exist specifically to close those four gaps.
Treat them as the core of the project and the rest as scaffolding.

### The metric

**Brier Skill Score against the market price at decision time.**

```
BS_model  = mean( (q_model  - outcome)² )
BS_market = mean( (p_market - outcome)² )
BSS       = 1 - (BS_model / BS_market)
```

BSS > 0 means better calibrated than the market. Always reported with a cluster
bootstrap confidence interval (§10.2). Never report win rate as a performance
metric: in a binary market it is a function of what prices you buy at, and a 68%
win rate is exactly what fairly-priced 68c contracts produce with zero edge.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ INGEST — runs continuously from day one                      │
│  Kalshi client → normaliser → append-only Parquet            │
│  raw messages · books · trades · metadata · resolutions      │
└────────────────────────┬─────────────────────────────────────┘
                         │
        ┌────────────────┴────────────────┐
┌───────▼─────────┐              ┌────────▼──────────┐
│ RESEARCH        │              │ PAPER (M10)       │
│ FeatureStore    │              │ FeatureStore      │
│  .as_of(t)      │◄─same code──►│  .as_of(now)      │
│ backtest engine │              │ DryRunBroker      │
│ evaluation      │              │ risk gate         │
└───────┬─────────┘              └────────┬──────────┘
        └──────────►  REPORTING  ◄────────┘
```

The single most important structural decision: **research and paper trading share
the same `Strategy` implementation and the same `FeatureStore` interface.** The
only difference is what `as_of()` returns. Two code paths that are supposed to
agree but are written separately will silently diverge, and the backtest becomes
fiction. One interface, two drivers.

---

## 3. Repository layout and stack

```
pmtrade/
├── CLAUDE.md
├── BLUEPRINT.md
├── pyproject.toml            # uv
├── configs/
│   ├── record.yaml
│   └── backtest.yaml
├── pmtrade/
│   ├── types.py              # canonical frozen dataclasses (§5.1)
│   ├── ingest/
│   │   ├── kalshi/
│   │   │   ├── client.py     # REST, cursor pagination, rate limiting
│   │   │   ├── stream.py     # WebSocket, reconnect, seq-gap detection
│   │   │   └── book.py       # order book state machine
│   │   ├── normalise.py      # venue → canonical
│   │   ├── recorder.py       # orchestrates, writes raw + normalised
│   │   ├── resolutions.py    # settlement capture
│   │   └── rates/
│   │       └── cme.py        # fed funds futures (§7.2)
│   ├── store/
│   │   ├── writer.py         # Parquet, rotation, atomic commit
│   │   ├── query.py          # DuckDB views
│   │   └── features.py       # FeatureStore.as_of — THE boundary (§6.1)
│   ├── research/
│   │   ├── backtest/
│   │   │   ├── engine.py
│   │   │   ├── fills.py
│   │   │   └── latency.py
│   │   ├── costs.py          # §8.1
│   │   ├── splits.py         # purged + embargoed CV
│   │   └── evaluate.py       # BSS, bootstrap, reliability
│   ├── strategy/
│   │   ├── base.py           # Strategy protocol — used by both drivers
│   │   ├── ladder.py         # S1 (§7.1)
│   │   └── rates_basis.py    # S2 (§7.2)
│   ├── risk/
│   │   ├── sizing.py         # §8.2
│   │   ├── clusters.py       # §8.3
│   │   └── limits.py         # §8.4
│   ├── execution/
│   │   └── dry_run.py        # DryRunBroker — the ONLY broker
│   └── reporting/
├── data/                     # gitignored, append-only
│   ├── raw/                  # verbatim venue messages, never parsed in place
│   └── normalised/
├── docs/milestones/
└── tests/
```

Stack: Python 3.12, `uv`, `polars`, `duckdb`, `httpx`, `websockets`, `lightgbm`,
`scikit-learn`, `pytest`, `hypothesis`, `ruff`, `mypy --strict`.

`data/raw/` holds verbatim venue payloads with a receipt timestamp and nothing
else. Normalised data is always re-derivable from it. Parsers have bugs;
recordings do not, and you only get one chance to record a given day.

---

## 4. Milestones

Do not begin M(n+1) until M(n)'s acceptance criteria pass and are reported with
numbers. Write `docs/milestones/M<n>.md` at the end of each, including a section
on what you are uncertain about.

### M0 — Scaffold

Repo, `uv` project, ruff, `mypy --strict`, pytest, CI, canonical types in
`types.py`. No business logic.
**Accept:** empty suite green, mypy strict clean, CI passes on a fresh clone.

### M1 — Kalshi discovery and metadata

REST client with cursor pagination and rate limiting. Pull `/series`, `/events`,
`/markets`. Capture full metadata including rules text, with `rules_hash`
versioning (§5.1).
**Accept:** every active economics series retrieved; a second run produces zero
spurious version rows; a deliberately altered rules text produces exactly one new
version row with correct `observed_at`.

### M2 — Recorder

Order book capture (see Open Question 1 for the WS-vs-REST decision), book state
machine, sequence gap detection, reconnect with backoff, raw message archival.
**Accept:** 24h continuous run, zero unhandled disconnects, zero undetected
sequence gaps, and replaying `data/raw/` reproduces the final book state exactly.

### M3 — Storage

Parquet writer with size/time rotation and atomic commit. DuckDB views. Daily
backup sync to object storage.
**Accept:** `kill -9` mid-write leaves no corrupt or partially visible partition;
a 24h aggregate query returns in under 2 seconds; backup restore verified.

### M4 — Resolutions

Settlement outcome capture, dispute flags, backfill for markets that closed
during the recording window.
**Accept:** every market observed as closed has either a resolution row or an
explicit unresolved reason. No silent gaps.

### M5 — Point-in-time boundary

`FeatureStore.as_of()` per §6.1, plus the import-boundary test.
**Accept:** hypothesis property test proves that for random `(market, t)` no
returned field derives from a record with `recv_ts > t`; the import test fails if
`strategy/` imports a raw store.

### M6 — Backtest engine

Event loop, fill model, latency model (§6.2, §6.3).
**Accept:** reproduces a hand-computed 10-event golden scenario exactly; partial
fills correct against limited depth; a maker order does not fill when the market
trades _at_ its level, only when it trades _through_.

### M7 — Cost model

§8.1.
**Accept:** fee function matches hand-computed values at 1c, 10c, 25c, 50c, 75c,
90c, 99c; rounding convention documented and conservative.

### M8 — Strategy S1, ladder consistency

§7.1, plus research report.
**Accept:** ladder detection ≥ 99% precision on 50 hand-labelled events; report
gives the time series distribution of ladder sums, the count of cost-exceeding
violations, achievable size at each, and a cluster-bootstrap CI on net expectancy.

### M9 — Strategy S2, rates basis

§7.2, including fed funds futures ingest and implied probability calculation.
**Accept:** the ZQ implied-probability calculation reproduces a published FedWatch
figure for a historical date to within 1 percentage point; basis series computed;
mean-reversion tested with a confidence interval.

### M10 — Evaluation harness and paper trading

§10, plus `DryRunBroker` running against live data.
**Accept:** BSS with cluster bootstrap, reliability curves, purged/embargoed CV
all implemented and tested; 30 consecutive days of paper trading with a daily
report; simulated fills verified achievable against recorded depth.

---

## 5. Canonical data model and storage

### 5.1 Types

All frozen dataclasses in `types.py`. All timestamps timezone-aware UTC. All
prices integer cents.

```python
@dataclass(frozen=True)
class Market:
    venue: str                      # "kalshi"
    market_id: str                  # canonical, stable
    venue_ticker: str
    series_ticker: str
    event_ticker: str
    title: str
    rules_text: str
    rules_hash: str                 # sha256 of rules_text
    resolution_source: str | None
    category: str
    open_ts: datetime
    close_ts: datetime
    expected_settle_ts: datetime | None
    tick_size_cents: int
    strike_type: str | None         # "greater" | "less" | "between"
    floor_strike: float | None
    cap_strike: float | None
    observed_at: datetime           # when WE first saw THIS version
```

`Market` is versioned, not updated in place. Venues edit rules text after
listing, and a backtest that uses today's rules to evaluate a decision made
before an amendment is using information that did not exist. `as_of()` must
serve the version live at time `t`.

```python
@dataclass(frozen=True)
class BookSnapshot:
    market_id: str
    venue_ts: datetime
    recv_ts: datetime
    seq: int
    yes_levels: tuple[tuple[int, int], ...]   # (price_cents, size), bids on YES
    no_levels:  tuple[tuple[int, int], ...]   # (price_cents, size), bids on NO

@dataclass(frozen=True)
class Trade:
    market_id: str
    venue_ts: datetime
    recv_ts: datetime
    price_cents: int
    size: int
    taker_side: str                 # "yes" | "no"

@dataclass(frozen=True)
class Resolution:
    market_id: str
    settled_ts: datetime
    outcome: str                    # "yes" | "no" | "void"
    disputed: bool
    notes: str | None
```

**Book representation note.** Kalshi expresses a book as resting YES bids and
resting NO bids. A YES bid at 40c is economically a NO ask at 60c. Store the
venue-native form, derive the canonical two-sided view, and write a test that
asserts the derivation round-trips. Getting this wrong inverts your entire P&L
sign and the bug is easy to miss.

### 5.2 Layout

```
data/raw/kalshi/{stream}/dt=YYYY-MM-DD/hh=HH/part-NNNNN.jsonl.zst
data/normalised/kalshi/{table}/dt=YYYY-MM-DD/part-NNNNN.parquet
```

Write buffered, flush on 128MB or 15 minutes, fsync, then atomic rename into
place. A reader must never observe a partial file. Never mutate a committed file.

Expect a few hundred MB per day compressed for a few hundred economics markets.

---

## 6. Point-in-time boundary and backtest engine

### 6.1 The boundary

```python
class FeatureStore(Protocol):
    def as_of(self, market_id: str, t: datetime) -> FeatureVector: ...
    def universe_as_of(self, t: datetime) -> tuple[str, ...]: ...
```

`FeatureVector` is a frozen dataclass of derived scalars only. It exposes no
arrays, no dataframes, and no handle back to the store. Strategy code receives
one and can reach nothing else. This makes lookahead structurally impossible
rather than a matter of discipline, which is the point: every team that relies on
discipline here eventually leaks.

Subtler leaks to explicitly test for:

- Metadata edited after listing (handled by versioning, §5.1)
- A market's lifetime volume or final liquidity used as a feature
- Universe selection that implicitly requires a market to have resolved cleanly
- Economic data used at its _current_ value rather than its **first published
  vintage** (§7.2 — this is the big one for macro, and ALFRED solves it)

### 6.2 Engine

Single-threaded, deterministic, replaying the merged event stream in `recv_ts`
order. On each event the strategy may emit an `OrderIntent`. The engine then
advances the clock by the latency model before evaluating the fill against the
book **as it exists at the later time**. Instant fills at the observed price are
the most common way a backtest lies.

### 6.3 Fill and latency models

| Order type | Rule                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Taker      | Walk levels from the top. Fill only against real depth. Partial fills are normal and must be modelled.                          |
| Maker      | Fill **only if the market trades through your price level**, not merely at it. On fill, mark the position at the post-trade mid, not your fill price. |

The maker adjustment is an adverse-selection penalty and it matters more than it
sounds. If a resting order fills instantly, it is often because someone better
informed hit it. Backtests that treat maker fills as free money generate
spectacular and entirely fictional Sharpe ratios.

Latency model default: 150ms constant plus N(0, 50ms), clipped at zero, replaced
with measured values once real fills exist. Also model order rejections, rate
limit responses, WebSocket disconnects, and venue downtime. These occur, and they
correlate with exactly the volatile moments the strategy cares about.

---

## 7. Strategies

Both strategies below are **structural**. Neither requires forecasting the Fed.
This is deliberate: economics markets have terrible sample-size properties for
directional bets (roughly 8 FOMC meetings, 12 CPI prints and 12 jobs reports a
year, against the ~1,700 trades §10.3 shows are needed to validate a 3c edge).
Both strategies below draw their statistical power from _continuous observation
of a constraint_ rather than from resolutions, which is what makes the domain
tractable at all.

Do not add a directional Fed-forecasting strategy without first reading §10.3 and
explaining how it will reach sample size.

### 7.1 S1 — Ladder consistency

Kalshi lists economic releases as ladders of mutually exclusive, collectively
exhaustive strike buckets (for example CPI year-over-year in bands, plus tails).
Their probabilities must sum to 1.

```
sum(yes_ask_i) < 100c - total_fees   →  buy every leg, guaranteed $1 payout
sum(yes_bid_i) > 100c + total_fees   →  sell every leg
```

Implementation requirements:

1. **Ladder detection.** Group by `event_ticker`, then verify from
   `strike_type`, `floor_strike` and `cap_strike` that the buckets are genuinely
   mutually exclusive and that their union covers the whole domain including both
   tails. A ladder with a gap is not an arbitrage. Detection precision is an
   acceptance criterion because a false positive here loses money with certainty.
2. **Legging risk.** Filling four legs of a six-leg ladder leaves an outright
   position, not an arbitrage. Size to the minimum depth across all legs, submit
   IOC, and implement an explicit unwind path for partial fills. Investigate
   whether Kalshi's multi-leg endpoints allow atomic submission; if so, prefer
   them.
3. **Log near-violations.** Record the ladder sum continuously even when it is
   not tradeable. The distribution of that sum over time is itself the research
   output: it tells you whether the venue is efficient at all, and it accumulates
   observations far faster than trades do.

### 7.2 S2 — Rates basis

Compare Kalshi's implied probability of an FOMC outcome against the probability
implied by CME 30-day fed funds futures (ZQ). The futures market is orders of
magnitude deeper. The research question is not "what will the Fed do" but "does
a shallow market track a deep one, and if not, does the gap close?"

**ZQ implied probability.** ZQ settles to the _average_ daily effective fed funds
rate over the contract month, so a meeting mid-month blends the pre- and
post-meeting rate:

```
r_avg = 100 - price

r_avg = [ (M-1)·r_before + (N-M+1)·r_after ] / N

r_after = [ N·r_avg - (M-1)·r_before ] / (N-M+1)

P(25bp cut) = clamp( (r_before - r_after) / 0.25, 0, 1 )
```

where `N` = days in the contract month and `M` = the day the new rate takes
effect (normally the day after the decision).

Traps to handle explicitly, all of which bias the result if ignored:

- **EFFR is not the target midpoint.** It typically trades a few basis points
  below. Use observed EFFR and its recent spread to the midpoint for `r_before`,
  not the midpoint itself.
- **Month-end and quarter-end EFFR distortions** contaminate the average.
- **Chaining meetings** requires successive contracts and a non-meeting month to
  anchor the clean rate.
- **Two-outcome assumption.** The formula above assumes a choice between hold and
  a single 25bp move. When a 50bp move is live, the decomposition is
  underdetermined from one contract and needs an explicit stated assumption.
  Document whichever you choose.

**Point-in-time macro data.** Use **ALFRED**, the FRED archive that stores every
release vintage as originally published. Economic series are revised, sometimes
substantially, and using current FRED values silently feeds revised numbers into
a backtest of a decision made before the revision existed. This is the single
most common macro backtest error.

**Data availability caveat.** Free intraday ZQ prices are hard to source; CME
daily settlements are readily available but delayed. If only daily data is
obtainable, S2 becomes a daily-frequency strategy and its sample size falls
accordingly. Resolve before building — see Open Question 2.

---

## 8. Cost model, sizing, and risk limits

### 8.1 Costs

Kalshi's published taker fee follows a probability-weighted formula of the form
`multiplier × P × (1 − P)` per contract, with the multiplier around 0.07 for
standard categories and higher for some premium ones. Fees peak near 50c and fall
to zero at the extremes. Maker fees are materially lower.

```python
def kalshi_taker_fee_cents(price_cents: int, contracts: int,
                           multiplier: float = 0.07) -> int:
    """Fee in whole cents.

    VERIFY the multiplier, category table, and rounding convention against the
    current schedule at kalshi.com/fee-schedule before trusting any backtest.
    Sources disagree on whether rounding is to-nearest or up; until confirmed,
    round UP, because the conservative error is the safe one.
    """
    p = price_cents / 100.0
    per_contract = math.ceil(multiplier * p * (1 - p) * 100)
    return per_contract * contracts
```

The fee schedule is versioned config data, not a constant, so that a schedule
change is an update and old backtests stay reproducible.

Also model, because together they usually exceed fees:

- **Spread cost.** Crossing a 3c spread costs 1.5c against mid.
- **Slippage.** Depth-dependent, measured from paper fills and fed back.
- **Capital cost.** Money locked in a three-month contract has an opportunity
  cost, which is material for slow-converging positions at current short rates.

### 8.2 Sizing

For a binary contract at price `p` with estimate `q`:

```
f* = (q - p) / (1 - p)      # buy YES
f* = (p - q) / p            # buy NO
```

`f*` diverges as `p → 1`; cap it. Never size at full Kelly — it is optimal only
if `q` is exactly right, and betting twice Kelly has zero long-run growth even
with a real edge.

Two protective layers:

1. **Shrink toward the market.** `q_used = w·q_model + (1-w)·p_market`, where `w`
   comes from measured out-of-sample calibration, not judgement. Poor recent
   calibration then automatically collapses position size toward zero.
2. **Fractional Kelly.** Size at `λ·f*` with `λ = 0.10` initially.

Minimum edge threshold: 4c after costs. Below that, estimation error dominates
and you are paying fees to express noise.

### 8.3 Correlation clusters

Economics markets are full of positions that are the same bet wearing different
clothes. Every CPI bucket in one release is one bet. Every Fed market for a given
meeting is one bet. Twelve markets sized independently at 2% each is a 24%
position nobody chose to take.

Cluster key for this domain: `(series_ticker, reference_period)` — for example
all CPI markets for the September release, or all Fed markets for the December
meeting. Limits apply at cluster level, not market level. Cluster membership also
defines the bootstrap unit in §10.2.

### 8.4 Limits

| Limit                        | Initial value    |
| ---------------------------- | ---------------- |
| Max per market               | 2% of bankroll   |
| Max per cluster              | 6%               |
| Max total deployed           | 40%              |
| Max daily loss before halt   | 3%               |
| Max drawdown before full stop | 12%             |

Enforced as a hard gate every intent passes through in `risk/limits.py`. Not
advisory, not a warning log.

---

## 9. Kalshi API notes

**Verify everything here against `docs.kalshi.com` before implementing.** These
notes were accurate as of August 2026 and the API moves: the `ticker_v2`
WebSocket channel was retired on 2026-02-12. Where reality differs, follow
reality and flag the difference in the milestone doc.

- REST base `https://api.kalshi.com/trade-api/v2`, WebSocket
  `wss://api.kalshi.com/trade-api/ws/v2`. A separate demo environment exists and
  is the default for all non-production work.
- Auth is an API key pair plus a per-request RSA-PSS signature via
  `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE`.
  There is no login endpoint, session token, or JWT refresh.
- Market data endpoints are public. Orders, positions, balance and fills require
  signed headers.
- No official SDK. `httpx`, `cryptography` and `websockets` are sufficient; the
  only real work is a correct signing helper. Write its unit test first.
- Discovery hierarchy is `/series` → `/events` → `/markets`, plus an orderbook
  endpoint. Cursor-based pagination throughout; build a paginator that handles
  drift.
- Rate limits are tiered, with a basic tier around 20 reads and 10 writes per
  second. The WebSocket feed is read-only.
- Public WS channels include `ticker`, `trade`, and `market_lifecycle_v2`. The
  `orderbook_delta` channel is documented as requiring connection-level
  authentication, because its payload is enriched with your own
  `client_order_id`, even though the underlying book data is public. See Open
  Question 1.
- Heartbeats are server-driven: a Ping roughly every 10 seconds that the client
  must Pong or be disconnected. Python's `websockets` handles this automatically;
  do not hand-roll it.

---

## 10. Evaluation harness

### 10.1 Reports

Every strategy report contains, in this order: net expectancy per contract with
CI, BSS against market with CI, reliability curve, P&L attribution by cluster,
realised-versus-modelled slippage, and the count of effective independent
observations. No gross figures anywhere.

### 10.2 Cluster bootstrap

Resample **whole clusters** (§8.3), not individual trades. Trades within a
cluster are strongly dependent, so an iid bootstrap will produce confidence
intervals several times too narrow and make noise look like edge. This is the
single most important line in the evaluation module.

### 10.3 Sample size

Per-trade P&L standard deviation near 50c is about 0.5. To detect edge `e` at 95%
confidence with 80% power:

```
n ≈ ((1.645 + 0.84) · 0.5 / e)²
```

| Edge per contract | Independent observations needed |
| ----------------- | ------------------------------- |
| 2c                | ~3,900                          |
| 3c                | ~1,700                          |
| 5c                | ~620                            |
| 8c                | ~240                            |

"Independent" means clusters, not trades. Report effective sample size alongside
every result. If a strategy cannot plausibly reach these numbers, say so in the
milestone doc rather than reporting an underpowered result as a finding.

### 10.4 Cross-validation

Purged and embargoed time-forward splits. Standard k-fold leaks badly here
because overlapping markets share information: purge training samples whose
resolution window overlaps the test window, then embargo a buffer afterwards.
Calibration is fitted on a third split, separate from both training and
evaluation.

### 10.5 Multiple testing

Every strategy variant evaluated must be logged in `docs/experiments.md` with its
result, including the abandoned ones. If twenty variants are tried and the best
reported, its apparent edge is inflated by selection. Either pre-register before
touching the test set, or apply a correction, and state which was done.

---

## 11. Operational runbook

- Recorder runs on a small always-on VM: 2 vCPU, 4GB RAM, 80GB SSD, US-East
  region to keep latency low and stable and to avoid migrating later. Research
  and training run on the local machine; only ingest needs to be continuous.
- `systemd` unit with `Restart=always`, journald logging, structured JSON.
- Alert on: any sequence gap, any disconnect exceeding 60 seconds, disk above
  80%, or no writes in 10 minutes. Economic markets concentrate their information
  into the 8:30am and 2:00pm ET windows; a gap there costs a month of data.
- Daily backup sync of `data/` to object storage, with a restore test monthly.
  Recorded data is irreplaceable and is the entire asset.

---

## 12. Open questions for the human

Do not guess at these. Stop and ask.

1. **Order book depth access.** `orderbook_delta` appears to require an
   authenticated WebSocket connection, which sits awkwardly against the rule that
   M1–M10 use only public unauthenticated endpoints. Options: (a) poll the public
   REST orderbook endpoint on an interval, losing intra-poll detail; (b) create an
   unfunded account with a read-only API key held in an environment variable,
   which places no money at risk and adds no live-order code path. Recommendation
   is (b), but it is a rule change and needs explicit approval.

2. **Intraday ZQ data source.** Required before M9. If only daily CME settlements
   are available, S2 drops to daily frequency and §10.3 sample size suffers
   accordingly.

3. **Account eligibility.** Kalshi expanded internationally in October 2025 but
   holds no local licences outside the US, and the restricted list has been
   moving through 2026. Confirm eligibility in your jurisdiction before any
   account is created. This does not block M1–M8 if Open Question 1 resolves to
   option (a).

4. **Sample size insurance.** Economics alone may not produce enough independent
   observations within a reasonable window. Consider recording a
   higher-frequency domain in parallel from M2, purely to have the data available
   later. Recording is cheap; not having recorded is unfixable.
