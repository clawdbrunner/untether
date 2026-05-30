# Untether v0.2.1 — Reliability & Observability PRD

> **Standalone fix-spec.** Covers three reliability defects found after the v0.2
> platform expansion. Assumes v0.1 + v0.2 as baseline. For product context,
> adapter contract, rate limiter, and persistence design, see `PRD.md` and the
> v0.2 PRD in the repo.

**Repo:** <https://github.com/clawdbrunner/untether> · **Baseline:** v0.2 · **Owner:** clawdbrunner

---

## 1. Problems

Three defects, observed after v0.2 shipped:

1. **Silent failure.** Retrieval and scrape errors are not reported. A platform that errored out and a platform that genuinely returned no matches look identical to the user — both are empty cells. There is no summary of which platforms were actually searched successfully.
2. **Slow.** Platforms are searched sequentially. A run waits for PeerTube to finish before starting Odysee, and so on, so wall-clock time is the *sum* of all platforms instead of the *max*.
3. **No retry.** When a retrieval or scrape fails, there is no safe retry. A transient blip (timeout, 503, momentary block) permanently loses that cell, and there is no backoff to avoid hammering — or getting banned by — a platform that's pushing back.

## 2. Root cause & guiding insight

All three share one root cause: **there is no per-(channel × platform) attempt record that distinguishes outcomes.** "Searched, found nothing", "never ran", "ran and failed", and "failed too many times, gave up" are all collapsed into the same empty result today.

Introduce an explicit attempt state per (channel × platform), and the three fixes fall out of it:
- Reporting = summarize attempt states by platform.
- Retry = re-run attempts in a retryable-failed state, with backoff.
- Parallelism = run attempts concurrently — **but bounded per source**, see §5.

**Critical interaction (read this before implementing parallelism):** "search platforms in parallel" must mean *parallel across platforms*, not *parallel across all requests*. Firing every Rumble request at once is exactly what trips Cloudflare bans — the same bans the backoff in issue 3 exists to prevent. The two features fight each other unless parallelism respects the existing per-source rate limiter. The rule: **fan out across sources concurrently; stay throttled within each source.**

These three issues are therefore specified together, in dependency order: the attempt-state model first (enables 1 and 3), then concurrency (2), then reporting (1) and retry (3) on top.

## 3. Scope

In scope:
- A per-(channel × platform) attempt-state model in the existing job/task store.
- Bounded-concurrency execution: parallel across sources, throttled within each source via the existing rate limiter.
- Error classification (transient vs. permanent vs. rate-limited vs. blocked).
- Safe retry with exponential backoff + jitter, capped attempts, honoring the existing circuit breaker.
- A run summary surfaced in the UI and CLI: per-platform searched / found / failed / skipped counts, with drill-down to per-channel errors.

Out of scope:
- Changing the matching engine, confidence model, adapters, or export formats.
- Adding new platforms.
- Changing the persistence backend choice (D1/SQLite stays).
- Any change to the plugin runtime's sandbox or trust model.

## 4. Attempt-state model

Add an explicit state to each unit of platform work. If v0.2 already has a `task` row per (channel × platform) search, extend it; if search is currently done inline without a task row, introduce one. Reuse the existing job/task store rather than adding a new store.

**States** (per channel × platform):
- `pending` — not yet attempted.
- `in_flight` — currently running.
- `succeeded` — completed; result may be matches **or** a genuine zero-result. Both are success.
- `failed_retryable` — failed with a transient/rate-limited/blocked error; eligible for retry under backoff.
- `failed_permanent` — failed with a non-retryable error, or exhausted the retry cap.
- `skipped` — not attempted by design (e.g. source's circuit breaker is open, or platform deselected mid-run).

Fields per attempt:
- `attempts` (int), `last_error_class`, `last_error_detail` (truncated), `next_eligible_at` (for backoff), `updated_at`.

A genuine zero-result is `succeeded` with zero matches — **never** conflated with a failure. This single distinction is what fixes the silent-failure defect at the data layer.

## 5. Concurrency model (issue 2)

Two layers of concurrency control, both required:

**(a) Across sources — parallel.** Dispatch work for different sources concurrently. PeerTube, Odysee, Dailymotion, BitChute, and Rumble all make progress at once. Wall-clock time approaches the *slowest single platform* rather than the sum.

**(b) Within a source — bounded by the existing rate limiter.** Each source keeps its v0.1/v0.2 token-bucket + max-concurrency + backoff + circuit breaker. The concurrent executor submits work *through* the limiter, which remains the single dispatch point for outbound HTTP. The limiter — not the executor — decides when a given source's next request actually fires.

Concretely: a global scheduler holds a worklist of (channel × platform) attempts. It hands them to per-source queues. Each per-source queue drains at the rate its limiter permits, up to that source's max-concurrency. A global concurrency ceiling caps total simultaneous in-flight work across all sources (protects host resources and, on Cloudflare, subrequest limits).

**Defaults (overridable by config):**
- Per-source max-concurrency unchanged from v0.2 (e.g. `rumble`=1, `bitchute`=2, `dailymotion`=4, PeerTube per-instance, Odysee its own bucket).
- Global in-flight ceiling: start at 12; tune.
- On Cloudflare, respect the platform's subrequest cap; the global ceiling must stay well under it.

**Non-negotiable:** parallelism is never allowed to bypass a source's rate limiter. If the limiter says wait, the work waits. This is what keeps issue 2 from re-creating the bans issue 3 prevents.

## 6. Error classification

Every retrieval/scrape outcome is classified into exactly one class. Classification drives state transition and retry eligibility.

| Class | Examples | State on occurrence | Retryable |
|---|---|---|---|
| `ok` | 2xx with parseable result (incl. zero matches) | `succeeded` | n/a |
| `transient` | timeout, connection reset, 5xx, DNS blip | `failed_retryable` | Yes |
| `rate_limited` | 429, explicit quota signal | `failed_retryable` + signal limiter to back off the **whole source** | Yes (longer backoff) |
| `blocked` | 403, Cloudflare challenge/Turnstile, bot wall | `failed_retryable` + may trip circuit breaker | Yes (longest backoff; on hosted Rumble, surface "proxy needed") |
| `not_found` | 404 on resolve, valid empty search | `succeeded` (zero matches) | n/a |
| `permanent` | malformed/unparseable response, plugin threw a non-network error, bad request | `failed_permanent` | No |

Notes:
- `rate_limited` and `blocked` are **source-level** signals, not just attempt-level: they tell the limiter to slow or open the breaker for that source, so other channels' attempts on the same source also back off. This is the link between retry and ban-prevention.
- Plugin-backed sources (BitChute, Rumble) must map plugin errors into these classes in their shim. A plugin throwing because the upstream HTML changed is `permanent` (needs a plugin update, not a retry); a plugin's HTTP call timing out is `transient`.

## 7. Retry & backoff (issue 3)

- A retry pass selects attempts in `failed_retryable` whose `next_eligible_at` has passed, and re-submits them through the per-source queue (so retries are themselves rate-limited and concurrency-bounded).
- **Exponential backoff with full jitter**, per attempt: `delay = min(cap, base * 2^(attempts-1))`, then randomized in `[0, delay]`. Per-class base/cap:
  - `transient`: base 2s, cap 60s.
  - `rate_limited`: base 30s, cap 15min.
  - `blocked`: base 60s, cap 30min.
- **Attempt cap** per class (default): `transient` 5, `rate_limited` 4, `blocked` 3. On exhaustion → `failed_permanent`.
- Retries **honor the circuit breaker**: if a source's breaker is open, its retryable attempts move to (or stay) effectively deferred — they are not dispatched until the breaker half-opens. They are not counted as new attempts while deferred.
- **Idempotency / "don't redo successful work":** retries only ever touch `failed_retryable` attempts. `succeeded` attempts (including zero-result) and the v0.1 resource cache's "scrape once" guarantee are untouched — a successful scrape is never repeated by the retry logic. This preserves the existing pause/resume semantics.
- Retry can run automatically at the end of a run (a bounded number of automatic passes, e.g. up to 2) **and** be user-triggered ("Retry failed" button) for anything still `failed_retryable` afterward.

## 8. Reporting (issue 1)

A **run summary** produced from the attempt-state model, available in both UI and CLI.

**Per-platform summary (the headline):** for each selected platform, show counts:
- searched successfully (`succeeded`, regardless of match/zero),
- of which had ≥1 match vs. zero matches,
- failed retryable (will retry / can retry),
- failed permanent,
- skipped (and why — e.g. "circuit breaker open"),
- whether the source's circuit breaker tripped during the run.

This directly answers "which platforms were successfully searched" — the core ask. A platform that errored on every channel shows `0 succeeded / N failed`, visibly different from a platform that searched everyone and found few matches.

**Drill-down:** expand a platform to see the channels that failed, with the error class and a short detail. Group by error class so "all of Rumble failed `blocked`" reads as one actionable line (→ "configure a proxy") rather than 200 identical rows.

**UI surfaces:**
- A summary banner/panel at the top of the review grid after a run: per-platform chips (e.g. `Odysee ✓ 142/142`, `Rumble ⚠ 0/142 blocked`).
- In-grid cell states must visually distinguish: match found, searched-no-match, failed (retryable), failed (permanent), skipped. These are five distinct states, not the current two.
- A "Retry failed" action scoped to a platform or the whole run.

**CLI surface:** print the per-platform summary table at the end of a run; non-zero exit detail (or a `--report` flag) for failures. Useful for the self-host/headless path.

**Logging:** every attempt logs its final class with source attribution. Per-source aggregate counts (succeeded/failed/rate_limited/blocked) are logged at run end. Plugin errors include the plugin name.

## 9. Build sequence

1. **Attempt-state model.** Extend the task/job store with the §4 states and fields. Backfill: a run is now a set of attempts. No behavior change yet — just the data model and transitions wired into the existing (sequential) search path. *Acceptance:* after a run, every (channel × platform) has a terminal state; zero-results are `succeeded` with zero matches and are distinguishable from failures in the store.
2. **Error classification.** Implement the §6 classifier at the single point where adapter/plugin results and errors are handled. Map plugin shim errors into classes. *Acceptance:* induced errors (mock a 429, a 403, a timeout, a malformed response) each land in the correct class and state; `rate_limited`/`blocked` signal the source limiter.
3. **Bounded-concurrency executor.** Replace the sequential loop with the §5 scheduler: parallel across sources, throttled within each source through the existing limiter, global ceiling. *Acceptance:* a multi-platform run's wall-clock approaches the slowest single platform, not the sum; per-source request spacing under load still respects each limiter (verify Rumble never exceeds its concurrency=1 and spacing); no limiter is bypassed.
4. **Retry & backoff.** Add the retry pass (§7): selection by `next_eligible_at`, full-jitter exponential backoff per class, attempt caps, circuit-breaker honoring, automatic end-of-run passes + manual trigger. *Acceptance:* a source returning transient errors then recovering eventually succeeds without exceeding its caps; a source returning `blocked` backs off the whole source and stops after the cap → `failed_permanent`; successful/zero-result attempts are never re-run; pause/resume still works.
5. **Reporting.** Build the §8 run summary in UI and CLI; add the five-state cell rendering and the "Retry failed" action. *Acceptance:* a run where one platform is forced to fail on every channel shows `0 succeeded / N failed` for that platform and correct counts for the others; drill-down groups by error class; "Retry failed" re-runs only failed cells.
6. **Polish.** Copy for error classes (user-facing strings), the "proxy needed" hint on hosted-Rumble `blocked`, docs/README update describing the summary and retry behavior.

## 10. Acceptance criteria (end to end)

- **No silent failures:** every platform-search outcome is classified and reflected in the summary. A failed platform is never indistinguishable from a found-nothing platform.
- **Parallel but safe:** multi-platform runs are materially faster (wall-clock ≈ slowest platform), and no source's rate limiter or circuit breaker is bypassed under concurrency. Rumble at concurrency=1 stays at concurrency=1.
- **Safe retry:** transient failures recover automatically; rate-limited/blocked sources back off (whole-source) with jittered exponential delay and stop at the attempt cap; successful and zero-result work is never redone; the resource cache "scrape once" guarantee and pause/resume are preserved.
- **Actionable reporting:** the per-platform summary answers "which platforms were successfully searched" at a glance, with drill-down grouped by error class and a scoped "Retry failed" action, in both UI and CLI.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Parallelism re-creates bans by bypassing limiters | Hard rule (§5): executor submits *through* the per-source limiter; it never dispatches directly. Acceptance test asserts Rumble stays at concurrency=1 under load. |
| Retry storms after a mass failure | Whole-source backoff on `rate_limited`/`blocked` + circuit breaker + per-class attempt caps + full jitter to de-synchronize retries. |
| Misclassifying a permanent error as transient → wasted retries / bans | Conservative mapping: unknown/ambiguous → `transient` with low cap; plugin parse failures explicitly `permanent`. Tune from observed run logs. |
| Cloudflare subrequest limits hit under high global concurrency | Global in-flight ceiling kept well under the platform cap; configurable; documented. |
| State-model migration on existing self-host SQLite DBs | Provide a migration; attempts table is additive. Old jobs without attempt rows are treated as legacy/complete. |
