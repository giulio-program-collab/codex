# CLAUDE.md — Project Constitution

This file governs all work in this repository. Read it at the start of every session.
Read `BLUEPRINT.md` for the full build specification.

---

## What this project is

A **research system** that determines whether a measurable, repeatable edge exists over
prediction market prices on Kalshi economics/Fed contracts. Execution is a downstream
consequence, not the goal.

The market price is a probability forecast produced by many participants with money at
stake. It is a strong baseline. Our job is to find out whether we can beat it after costs.
The default answer is no. The system must be built so that discovering "no" is cheap and
fast.

---

## Hard rules — never violate these

1. **No live order placement.** No code in this repository may submit a real order to any
   venue. The only broker implementation permitted is `DryRunBroker`. Do not create,
   scaffold, stub, or import a live broker. If a task seems to require one, stop and ask.

2. **No credentials in the repository.** Not in code, not in config, not in tests, not in
   `.env` files that are committed. Milestones M1–M10 use only public, unauthenticated
   market data endpoints.

3. **Never report gross P&L.** Every performance number is net of the full cost model
   (fees + spread + modelled slippage). Gross figures must not appear in any output,
   report, log line, or docstring example.

4. **Never weaken a failing test.** If a test fails, fix the code. Do not relax the
   assertion, add a tolerance, skip the test, or delete it. If a test appears genuinely
   wrong, stop and ask before changing it.

5. **Never relax cost assumptions to improve a result.** If a strategy is only profitable
   with lower fees or optimistic fills, the strategy is not profitable. Report it as such.

6. **Point-in-time access is enforced structurally.** Strategy and model code may access
   data only via `FeatureStore.as_of(t)`. Direct imports of raw or normalised stores from
   `strategy/`, `research/models/`, or `live/` are forbidden. Enforce with an import test.

7. **Every performance claim ships with a confidence interval.** Point estimates alone are
   forbidden in reports. Use the cluster bootstrap in `research/evaluate.py`.

8. **Raw data is immutable.** Never mutate, overwrite, or delete anything under `data/raw/`.
   Normalised data is always re-derivable from raw. Parsers change; recordings do not.

---

## Do not build these unless explicitly asked

- Live trading, order routing, or anything that touches real money
- A web dashboard or UI (before M10)
- Strategies not specified in `BLUEPRINT.md` §7
- Deep learning models. LightGBM and logistic regression only.
- Sentiment scraping, social media ingestion, or LLM probability estimation
- Notification systems, Telegram bots, alerting integrations
- Multi-venue support (Polymarket) — Kalshi only for now

If you think one of these is needed, say so and wait. Do not build it speculatively.

---

## Working style

- **One milestone at a time.** Milestones are defined in `BLUEPRINT.md` §4. Do not start
  M(n+1) until M(n)'s acceptance tests pass. Report gate status explicitly.
- **Tests before implementation** for anything in `store/`, `research/backtest/`, and
  `research/evaluate.py`. These are the components where a silent bug invalidates
  everything downstream.
- **Small commits**, one logical change each, with the milestone ID in the message.
- **Verify API details against live documentation** at `docs.kalshi.com` rather than
  trusting the notes in `BLUEPRINT.md` §9. Those notes were accurate as of August 2026 and
  APIs change. If reality differs from the blueprint, follow reality and flag the difference.
- **Ask when the spec is ambiguous.** Do not guess at financial logic.

---

## Definition of done for any milestone

- [ ] All acceptance tests in the milestone spec pass
- [ ] `ruff check` and `mypy --strict` clean
- [ ] No credentials, no live-order code paths introduced
- [ ] Test coverage on new modules ≥ 80%
- [ ] Gate criteria explicitly reported as PASS or FAIL, with numbers

---

## Red flags — stop and report rather than proceeding

- A backtest showing Sharpe > 3, or an equity curve that is close to a straight line
- A strategy whose P&L is concentrated in one market, one week, or one event
- A result that disappears when one extra tick of cost is added
- Model feature importance dominated by anything derived from the outcome
- Any apparent edge larger than 25 cents per contract

Each of these is far more likely to be a bug than a discovery. Investigate before reporting
as a result.
