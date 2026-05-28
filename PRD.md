# PRD — Cross-Platform Creator Finder (working title: *Untether*)

> A web app that takes a YouTube subscription export and finds the same creators on
> alternative platforms (PeerTube, Odysee, later Rumble), then exports a
> subscription list compatible with Grayjay and yt-dlp-based tools.
> Deployable to Cloudflare and easily self-hostable.

**Status:** Draft for review · **Owner:** clawdbrunner · **Last updated:** 2026-05-28

---

## 1. Problem & motivation

People trying to de-Google want to keep following their favorite creators without
YouTube. Many creators already cross-post to PeerTube, Odysee, or Rumble, but there
is no easy way to discover *which* of your subscriptions exist elsewhere and bulk-import
them into a privacy-respecting client. Doing it by hand — searching each creator on each
platform and weeding out impersonators and re-uploaders — is tedious and error-prone.

This tool automates the discovery and disambiguation, and produces a clean import file.

## 2. Goals / non-goals

**Goals**
- Ingest a standard YouTube/Google Takeout subscription export.
- For each subscribed channel, find candidate matches on the user-selected alternative platforms.
- Distinguish real matches from impersonators/re-uploaders with a transparent confidence model.
- Let the user review and confirm matches in a grid, then export a working subscription file.
- Run on Cloudflare *and* self-host from one codebase.

**Non-goals (for MVP)**
- Playing or downloading video (that's Grayjay/MeTube's job — we only produce import files).
- Account-based sync or ongoing monitoring of new creators.
- Rumble support (deferred to v2).
- Migrating playlists, watch history, or likes (subscriptions only).

## 3. Target users

Privacy-focused / de-Googling viewers who already use or intend to use Grayjay, NewPipe/
Tubular, FreeTube, or a yt-dlp-based downloader (e.g. MeTube), and who are comfortable
producing a Google Takeout export.

## 4. Decisions locked in this round

1. **Declared-link extraction is in the MVP** (it's the precision backbone).
2. **One codebase, two targets:** Cloudflare deployment + easy self-host.
3. **Direct adapters first**, behind a stable interface so the Grayjay plugin ecosystem can be plugged in later.
4. **Rumble deferred to v2.**
5. **YouTube enrichment auth:** optional BYO API key, with **yt-dlp fallback** for enrichment when no key is given or for fields the API doesn't expose.
6. **About-page scraping (formal Links section) is in the MVP.**
7. **Avatar perceptual-hash (pHash) matching is in the MVP.**

## 5. Key correction baked into the design

The YouTube "Links" section (the social/website links shown on the channel page) is **not
returned by the YouTube Data API and not extracted by yt-dlp.** Therefore declared-link
extraction has three independent sources, with different reliability and different fetch paths:

| Source | Where it comes from | Reliability | Fetch path |
|---|---|---|---|
| Description links | `snippet.description` (API) **or** `description` (yt-dlp) | Medium | API or yt-dlp |
| Formal Links section | Custom parse of channel page `ytInitialData` → `aboutChannelViewModel.links[]` | High | Dedicated scraper (neither API nor yt-dlp) |
| Cross-link *back-reference* | The candidate platform's channel description links back to *this* YouTube channel | High | Adapter (per-platform) |

The formal-Links scraper and the description parser run independently; both feed the matcher.

## 6. End-to-end user flow

1. **Ingest** — user uploads Takeout `subscriptions.csv`; selects target platforms.
2. **Enrich** — fetch description, avatar, subscriber count for each YouTube channel.
3. **Extract declared links** — description links (always) + formal Links section (scraper).
4. **Match** — per (channel × platform): resolve declared links *or* search + score candidates.
5. **Review** — grid UI with confidence tiers; user confirms/overrides per cell.
6. **Export** — `.txt` URL list (universal) + NewPipe JSON (where supported).

## 7. Functional requirements

### 7.1 Ingest
- Parse Google Takeout `subscriptions.csv` (columns: Channel ID, Channel URL, Channel Title).
- Parsing happens client-side (PapaParse); no upload of the raw list to the server is required for this step.
- Platform selector (MVP: PeerTube, Odysee). Per-platform options where relevant (e.g. PeerTube: "search via Sepia global index" vs. "specific instances").

### 7.2 Enrichment
- For each channel, obtain: `displayName`, `handle`, `description`, `avatarUrl`, `subscriberCount`.
- **Path A (API):** if user supplies a YouTube Data API key, batch `channels.list?part=snippet,statistics` (up to 50 IDs/call; well within free quota). BYO key solves both quota and trust.
- **Path B (yt-dlp fallback):** if no key, or to fill gaps, call the yt-dlp service with `--dump-json --flat-playlist` on the channel URL. Returns description, `channel_follower_count`, thumbnails.
- Hosted instances **may** offer a rate-limited shared key as a convenience; self-host expects BYO key or relies on yt-dlp.

### 7.3 Declared-link extraction
- **Description parse:** regex/URL-extract known platform patterns (peertube instances, `odysee.com/@`, `lbry://`, etc.) from the channel description.
- **Formal Links scraper:** fetch the channel `/about` page HTML, parse embedded `ytInitialData`, walk `aboutChannelViewModel.links[]` → `channelExternalLinkViewModel`. Required in MVP.
  - **Deployment note:** YouTube bot-flags datacenter IPs. The scraper is a strategy with graceful degradation: on self-host (residential IP) it works reliably; on Cloudflare it runs through the yt-dlp container's egress (or a configured proxy) and degrades to description-links-only on failure rather than blocking the run.
- Output: a set of `(platform, url)` declared links per YouTube channel.

### 7.4 Matching engine
For each (YouTube channel × selected platform):
- **If a declared link to that platform exists** → `adapter.resolveChannel(url)` → tier **VERIFIED**.
- **Else** → `adapter.searchChannels(name/handle)` → score each candidate (see §8).
- Always also check **cross-link back-reference**: does the candidate's description link to this exact YouTube channel? If yes → near-VERIFIED even without a forward link.
- Produce a ranked candidate list per cell with a confidence tier.

### 7.5 Review grid
- Rows = YouTube channels; columns = selected platforms; cells = ranked candidates.
- Each cell shows the top candidate with tier badge (Verified / Likely / Possible / Weak), avatar thumbnails side-by-side, and a dropdown to pick an alternate candidate or "None".
- Bulk actions: "accept all Verified", "accept all ≥ Likely", filter by tier.
- The user's confirmed selections drive the export.

### 7.6 Export
- **`.txt` URL list** — universal; works for Grayjay's "Import Line Text file" and as input for MeTube/yt-dlp. Primary format for Odysee/Rumble.
- **NewPipe JSON** — for YouTube + PeerTube only (see §11 constraint). Importable by Grayjay, NewPipe/Tubular, FreeTube.
- (Stretch) Grayjay native `.zip`.
- Export is grouped by platform and reflects only confirmed selections.

## 8. Confidence model

Per candidate, combine signals into a tier:

- **VERIFIED** — resolved from a declared forward-link, or candidate description back-references this YouTube channel.
- **LIKELY** — strong combination: normalized handle/name match **and** low avatar pHash distance.
- **POSSIBLE** — one strong signal (name match *or* avatar match) but not both.
- **WEAK** — fuzzy name match only.

Signals:
- Normalized handle / display-name match (strip emoji, casing, common suffixes like "official", "TV").
- **Avatar perceptual hash (pHash)** distance between YouTube avatar and candidate avatar (MVP).
- Cross-link back-reference (strongest non-declared signal).
- Subscriber-count order-of-magnitude plausibility (weak tiebreaker only — counts differ wildly across platforms).

The model is transparent: each cell can show *why* it got its tier.

## 9. System architecture

### 9.1 The adapter contract (forward-compat seam)
Everything platform-specific implements one interface, so direct adapters today and a wrapped
Grayjay plugin tomorrow are interchangeable to the matching engine:

```ts
interface ChannelCandidate {
  url: string;
  handle?: string;
  displayName: string;
  avatarUrl?: string;
  subscriberCount?: number;
  description?: string;
}

interface PlatformAdapter {
  id: string;                                   // 'peertube' | 'odysee'
  searchChannels(query: string): Promise<ChannelCandidate[]>;
  resolveChannel(url: string): Promise<ChannelCandidate | null>;
}
```

- **MVP adapters (direct):**
  - **PeerTube** — REST `GET /api/v1/search/video-channels`; option to query the Sepia global index (search.joinpeertube.org) or specific instances. Cleanest API; federation makes search inherently multi-instance.
  - **Odysee/LBRY** — LBRY/Odysee search API for channel resolution and search.
- **v2 adapter (wrapped plugins):** a `GrayjayPluginAdapter` loads a signed Grayjay plugin into a JS sandbox (QuickJS / isolated-vm) with FUTO's host polyfill, and maps Grayjay channel objects → `ChannelCandidate`. The contract is unchanged.

### 9.2 Components
- **Web app / API** — SvelteKit. Pure-TS core (parsers, matcher, adapters) with **no Workers-only dependencies** beyond `fetch`.
- **yt-dlp service** — a small HTTP service wrapping yt-dlp (Python). Used for enrichment fallback and as the egress path for About-page scraping on Cloudflare.
- **Job orchestrator / scheduler** — drains a task queue (kinds: `enrich`, `scrape_links`, `search:<platform>`), respecting the rate limiters, writing every result to the cache, and advancing a per-job progress cursor.
- **Rate limiter** — per-source token-bucket + concurrency caps with backoff (see §9.4).
- **Persistence layer** — resource cache + job/task state (see §9.5).
- **Abstraction seams** for everything that differs by deployment: persistence (cache + jobs), task queue, rate-limiter state, secrets, and the link-extractor's scraping capability.

### 9.3 Deployment portability (one codebase, two targets)
- **Cloudflare:** SvelteKit `adapter-cloudflare`. yt-dlp runs as a **Cloudflare Container** (Containers + Sandboxes are GA on Workers Paid as of April 2026), invoked from the Worker. Persistence = **D1**; task queue = **Cloudflare Queues**; durable resumable orchestration = **Workflows** (GA — retries, and indefinite `waitForEvent` pause at no idle cost); rate-limiter state = a **Durable Object**; secrets = Workers Secrets.
- **Self-host:** SvelteKit `adapter-node`, shipped as a Docker image (or compose stack) alongside the **same** yt-dlp container as a sidecar. Persistence = **SQLite** (or Postgres); task queue + worker = in-process loop (or Redis/BullMQ); secrets = env vars. Runs from a residential IP, so About-page scraping is reliable.
- The yt-dlp image is identical in both modes; the `JobStore` / `TaskQueue` / `RateLimiter` interfaces are implemented twice (CF-native vs. Node), while the pure-TS core is unchanged.

### 9.4 Throttling & rate limiting
Each egress target has different limits and failure modes, so throttling is **per-source**, not just one global cap. A source is a token-bucket + max-concurrency limiter with jitter, exponential backoff, and a circuit breaker that pauses the source (and surfaces to the UI) after repeated 429/403 responses.

- `youtube-web` — About-page scraping **and** yt-dlp enrichment both hit YouTube, so they **share one budget** rather than double-spending the same goodwill. Most conservative limiter; heaviest jitter; first to trip a circuit breaker.
- `youtube-api` — quota-aware (units/day; 50 IDs per `channels.list` call); throttle to respect per-100-second limits.
- `peertube:<host>` — **per-instance** limiter (federation means many hosts); be polite to each one.
- `odysee` — its own bucket.

A global concurrency ceiling caps total in-flight work per job. All limits are config/env-driven: self-hosters on residential IPs can raise them; the hosted Cloudflare default stays conservative. On Cloudflare the limiter state lives in a **Durable Object** (single-threaded + consistent) so concurrent Workers share one budget instead of each getting its own.

### 9.5 Persistence: cache, jobs & pause/resume
Two stores with very different sensitivity and lifetime.

**(a) Resource cache — channel-keyed, public, cross-job/cross-user shareable, long TTL.** This is the "scrape once" guarantee.
- `channel_enrichment(channel_id PK, display_name, handle, description, avatar_url, subscriber_count, source, fetched_at)`
- `scrape_status(channel_id PK, status, scraped_at)` — a successful About-page scrape is recorded and **never repeated**; blocked/failed scrapes stay retryable later under backoff.
- `declared_links(channel_id, platform, url, link_source, fetched_at)`
- `platform_search(platform, query_norm, results_json, fetched_at)` — search results cached per normalized query.
- Contents are public metadata, not PII → safe to share across jobs and (when hosted) across users, with revalidation on TTL expiry.

**(b) Job state — per-run, sensitive, short TTL / user-deletable.** This is what enables pause/resume.
- `job(id PK, created_at, status, options_json, progress)` — status ∈ `pending | running | paused | completed | failed`.
- `job_channel(job_id, channel_id)` — the user's subscription list for this run.
- `task(job_id, kind, target_key, status, attempts, last_error)` — the work queue; `kind` ∈ `enrich | scrape_links | search:<platform>`.
- `selection(job_id, channel_id, platform, chosen_url, tier)` — confirmed matches that drive the export.

**Pause/resume semantics.** Pause stops scheduling new tasks; in-flight tasks finish or roll back to `pending`. Resume re-derives the pending task set and **skips anything already satisfied by the resource cache**, so a successful scrape is never redone and resume is naturally idempotent. A job that dies mid-run (crash, deploy, 429 storm) resumes from its cursor with zero duplicate scraping.

**Retention.** Resource cache: long TTL (public data). Job state: short default retention (e.g. 7 days when hosted) + an explicit "delete my job" action; on self-host it never leaves the machine.

## 10. Privacy & data handling
- BYO YouTube API key supported; no key required to function (yt-dlp fallback).
- **Two-tier persistence (see §9.5):** the *resource cache* holds only public channel metadata (not PII) and is long-lived and shareable; the *job store* holds the user's subscription list and selections, gets a short TTL plus an explicit delete action, and on self-host never leaves the machine.
- The subscription list is never sent to Google beyond the channel-ID lookups the user's own API key (or yt-dlp) performs.
- Self-host gives full data locality — nothing leaves the user's machine except the platform queries themselves.
- No Google account login through the app; the user brings their own Takeout file.

## 11. Platform coverage & export constraints
- **MVP platforms:** PeerTube, Odysee.
- **v2:** Rumble (no public search API + aggressive anti-bot → higher maintenance), plus candidates like Nebula, DTube, BitChute.
- **NewPipe JSON constraint:** NewPipe's service list is finite (YouTube, PeerTube, SoundCloud, Bandcamp, media.ccc). PeerTube exports cleanly to NewPipe JSON; **Odysee and Rumble cannot be represented in NewPipe JSON** → those rely on the `.txt` URL list (which Grayjay also imports natively).
- Grayjay has **no native CSV export** today (open feature request), so we standardize on `.txt` URL list + NewPipe JSON rather than CSV round-tripping.

## 12. Tech stack (proposed)
- **Frontend/API:** SvelteKit + TypeScript.
- **Core:** pure TS (PapaParse, URL parsing, matcher, adapters).
- **pHash:** a TS/WASM perceptual-hash lib (e.g. a WASM imagehash) so it runs in both Workers and Node.
- **yt-dlp service:** Python + yt-dlp in a container; thin HTTP API.
- **Persistence:** D1 (CF) / SQLite or Postgres (self-host), behind a `JobStore` interface; resource cache + job/task tables.
- **Job orchestration:** Cloudflare Workflows + Queues + a Durable Object rate limiter (CF) / in-process worker loop or Redis+BullMQ (self-host), behind `TaskQueue` + `RateLimiter` interfaces.
- **Secrets:** Workers Secrets (CF) / env vars (self-host).
- **Packaging:** Docker image for self-host; `wrangler` deploy for Cloudflare.

## 13. MVP scope vs. later

| Capability | MVP | Later |
|---|---|---|
| Takeout ingest + platform select | ✅ | |
| Enrichment (API + yt-dlp fallback) | ✅ | |
| Declared-link extraction (description + formal Links scraper) | ✅ | |
| Matching: resolve + search + pHash + back-reference | ✅ | |
| Review grid w/ confidence tiers | ✅ | |
| Export `.txt` + NewPipe JSON | ✅ | |
| PeerTube + Odysee adapters | ✅ | |
| Cloudflare + self-host deploy | ✅ | |
| Throttling (per-source rate limits + backoff) | ✅ | |
| Resource cache ("scrape once") | ✅ | |
| Pause / resume via durable job state | ✅ | |
| Rumble | | ✅ |
| Grayjay plugin runtime adapter | | ✅ |
| Grayjay `.zip` export | | ✅ |
| Playlists / other Takeout data | | maybe |

## 14. Open questions / risks
- **YouTube scraping durability:** `ytInitialData` structure changes periodically; the formal-Links parser needs maintenance. Mitigate by degrading to description-links rather than failing.
- **Cloudflare egress blocking:** even via the container, CF IPs may get throttled by YouTube. Need a fallback/proxy story and clear UX when scraping degrades.
- **pHash false positives:** generic/default avatars (e.g. letter avatars) will collide. Down-weight low-entropy avatars.
- **Odysee/LBRY API stability** and rate limits to be validated with a spike.
- **yt-dlp + YouTube friction:** YouTube increasingly requires PO tokens / cookies for some extractions; the yt-dlp service may need configuration knobs.
- **Cache staleness:** creators add platform links or rename channels over time; the resource cache needs a revalidation TTL and a manual "re-check this channel" override so stale data doesn't permanently hide a new match.
- **Job-store retention vs. convenience:** longer retention makes resume nicer but holds a user's subscription graph longer; default short + clear delete, and consider client-held job state as a privacy-max option.

## 15. Rough milestones
1. **Spike:** validate (a) formal-Links `ytInitialData` parse, (b) PeerTube + Odysee search APIs, (c) yt-dlp container enrichment, (d) Cloudflare Container invocation, (e) a per-source rate limiter + resource-cache read/write.
2. **Core pipeline:** ingest → enrich → declared links → match (no UI), CLI-testable, with the resource cache enforcing "scrape once" from day one.
3. **Adapters:** PeerTube + Odysee behind `PlatformAdapter`.
4. **Matching + pHash + confidence tiers.**
5. **Durable jobs:** task queue + job store + pause/resume; Workflows/Queues/DO on CF, worker loop on self-host.
6. **Review grid UI + export.**
7. **Dual deploy:** Cloudflare + self-host Docker; docs.
8. **Polish + privacy hardening** (retention, delete, revalidation).
