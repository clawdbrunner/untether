# Untether v0.2 — Platform Expansion PRD

> **Standalone PRD.** Covers only the changes from v0.1.0 → v0.2. Assumes v0.1.0
> as the baseline. For overall product context, persistence, throttling, matching,
> and export design, see the v0.1 PRD in the repo (`PRD.md`).

**Repo:** <https://github.com/clawdbrunner/untether> · **Baseline:** v0.1.0 · **Owner:** clawdbrunner

---

## 1. Objective

Add support for three additional alternative platforms — **Dailymotion**, **BitChute**, and **Rumble** — without taking on a permanent maintenance burden for anti-bot evasion or undocumented-API drift.

## 2. Approach: hybrid

These three platforms sit on very different difficulty tiers, and treating them the same would be wrong.

| Platform | API situation | Anti-bot | Adapter strategy |
|---|---|---|---|
| Dailymotion | Public GraphQL (`graphql.api.dailymotion.com`) | None | **Direct adapter** (same pattern as v0.1) |
| BitChute | Internal/undocumented; periodic breakage | Mild | **Grayjay plugin runtime** |
| Rumble | None; Cloudflare-protected (Turnstile, JA4) | Aggressive | **Grayjay plugin runtime** + **BYO proxy** |

The plugin runtime exists for one reason: to offload per-platform maintenance to FUTO and the Grayjay plugin community for platforms where owning the adapter would be a forever tax. Once it exists, future platforms with maintained FUTO plugins (Vimeo, RuTube, 3Speak, etc.) become config additions rather than code.

## 3. Non-goals

These bound the work explicitly. The plugin runtime is narrow on purpose.

- Not implementing media playback, DASH/HLS manifests, `RequestExecutor`, or binary media handling in the plugin runtime.
- Not implementing casting, mDNS, or device discovery.
- Not implementing login flows, OAuth, or authenticated session state for plugins.
- Not implementing subscription-import APIs in plugins (we go YouTube → other, not the reverse).
- Not shipping a managed proxy. Users who need one bring their own.
- Not adding signature verification of plugins against a FUTO public key (defer to v0.3 if FUTO ships a signing scheme).
- Not adding a per-plugin permissions UI (defer).

Every new host-binding added to the runtime must be justified against this list.

## 4. Scope summary

1. **Dailymotion direct adapter** — new `PlatformAdapter` implementation, GraphQL-backed.
2. **Grayjay plugin runtime** — sandboxed JS runtime with narrow polyfill (`http`, `utility`, `dom-parser`) and pinned plugin loader.
3. **BitChute via the runtime** — loads `grayjay-plugin-bitchute`.
4. **Rumble via the runtime** — loads `grayjay-plugin-rumble`.
5. **BYO outbound proxy** — per-source SOCKS5/HTTP CONNECT support wired into the existing rate limiter.
6. **Plugin trust model** — pinned allowlist + content-hash pinning + explicit update flow.
7. **UI updates** — platform picker entries, hosted-deployment label for Rumble, proxy config surface, plugin update surface.
8. **Rate limiter** — three new sources (`dailymotion`, `bitchute`, `rumble`) with appropriate defaults.

## 5. Functional requirements

### 5.1 Dailymotion direct adapter

- Implements the existing `PlatformAdapter` interface unchanged: `searchChannels(query)` and `resolveChannel(url)`, returning `ChannelCandidate[]`.
- Backend: Dailymotion public GraphQL at `https://graphql.api.dailymotion.com`. Documentation index at `https://developers.dailymotion.com/llms.txt`.
- Auth: client-credentials OAuth flow (`POST /oauth/token` with `grant_type=client_credentials`, public `client_id`/`client_secret`). Tokens cached and refreshed before expiry. Token credentials are optional config; without them the adapter falls back to whatever public read access GraphQL permits and logs the degraded mode.
- `searchChannels(query)`: GraphQL search query returning channel results; map name, handle/slug, avatar URL, subscriber count, description.
- `resolveChannel(url)`: parse the Dailymotion URL for the channel slug, then `channel(name: $slug)` query. Return null on 404.
- Cross-link back-reference: extract URLs from the candidate channel's description and pass them through to the matcher (same pipeline as v0.1).
- All HTTP goes through the existing rate limiter using source key `dailymotion`.

### 5.2 Grayjay plugin runtime

The runtime is a single `GrayjayPluginAdapter` registered N times — once per loaded plugin — each appearing to the matching engine as just another `PlatformAdapter`.

**Sandbox.**
- Self-host (Node): `isolated-vm` with hard memory cap (default 128 MB per plugin invocation) and per-call CPU timeout (default 10 s).
- Cloudflare: QuickJS-WASM running inside the Worker for typical loads. If a plugin exceeds Worker CPU limits, fall back to invoking it inside the existing yt-dlp Cloudflare Container (same container, separate entrypoint).
- No filesystem access. No direct network access. No `eval` bridge back to host code. No shared globals between plugin invocations.
- Plugins cannot see: the resource cache, the job store, the subscription list, the user's YouTube API key, proxy credentials, or any other secret. The only inputs a plugin receives are the arguments we explicitly pass to its public entry points.

**Polyfill — host surface implemented (narrow).**

| Binding | Implementation | Notes |
|---|---|---|
| `http` | `GET`/`POST` with headers, body, redirects, timeout | Routed through the rate limiter and proxy; returns Grayjay's expected response shape. Per-plugin egress counter incremented. |
| `utility` | URL helpers, hashing (sha1/sha256/md5), base64, time | Pure in-sandbox. |
| `dom-parser` | HTML parsing with CSS selector queries | `cheerio` under the hood; CSS-selector subset is sufficient for the v0.2 target plugins. |
| `Source` lifecycle | The hooks required for `searchChannels` and `getChannel` (or each plugin's equivalents) | Method names follow the Grayjay plugin spec at implementation time. Verify by reading `grayjay-plugin-dailymotion` and `grayjay-plugin-bitchute` source first. |
| `atob` / `btoa` | Standard | Grayjay provides these by default; we match. |

Bindings not on this list are not implemented in v0.2. If a target plugin requires something else, raise it and decide explicitly rather than expanding the polyfill silently.

**Plugin lifecycle.**
- Plugin source is fetched once from a configured URL (subject to the allowlist — see §5.6), verified, and cached by content hash.
- On startup, allowed plugins are loaded into the runtime; their declared platform metadata (id, display name) registers them with the source picker.
- Each `searchChannels` / `resolveChannel` call instantiates a fresh sandbox (or reuses a pooled one with cleared state — implementer's call based on perf measurements).
- Structured error reporting: distinguish plugin errors (threw, timed out, returned malformed data) from upstream errors (HTTP failure, rate-limited, proxy failure) in logs and surfaces.

**Per-plugin mapping shim.**
Each loaded plugin has a small TypeScript shim that maps the plugin's channel-result shape to `ChannelCandidate`. This is where any platform-specific normalization lives (e.g. "BitChute channel IDs look like X, normalize to URL Y"). Three shims in v0.2: Dailymotion (used only for the reference test in §6.2), BitChute, Rumble.

### 5.3 BitChute via the plugin runtime

- Load `futo-org/grayjay-plugin-bitchute` (pinned by content hash).
- Wire to `PlatformAdapter` via the runtime.
- Rate-limiter source: `bitchute` with conservative defaults (see §5.7).
- Works on both Cloudflare and self-host (no IP sensitivity beyond normal politeness).
- Mapping shim normalizes whatever BitChute channel shape the plugin returns into `ChannelCandidate`.

### 5.4 Rumble via the plugin runtime

- Load `futo-org/grayjay-plugin-rumble` (pinned by content hash).
- Wire to `PlatformAdapter` via the runtime.
- Rate-limiter source: `rumble` with the most conservative defaults of any source.
- **Cloudflare deployment:** expected to be degraded without BYO proxy because the plugin's HTTP requests still egress from a datacenter IP. The platform picker labels Rumble as "self-host recommended (or BYO proxy)" on the hosted deployment. Selecting it without a proxy still attempts the search; failures surface clearly rather than silently.
- **Self-host:** works on a residential IP without further configuration. Default for most users of the de-Google audience this app targets.

### 5.5 BYO outbound proxy

- New per-source configuration: an outbound proxy URL (SOCKS5 or HTTP CONNECT). Three scopes:
  - **Off** (default for direct adapters and most sources).
  - **Per source** (e.g. `rumble`, `youtube-web`) — the common case.
  - **All egress** — for users who want every outbound request through their tunnel.
- Implementation: the rate limiter is the single dispatch point for all outbound HTTP (already true in v0.1 for the limiter side; this change extends it to perform proxy dispatch). When a source has a proxy configured, the dispatcher uses it.
- Configuration: env vars / secrets entry on both deployments. UI: a "Proxy" panel in settings that lists each source and lets the user assign a proxy URL. Stored encrypted at rest where the deployment supports it.
- Validation: the settings UI offers a "test proxy" button that issues a known harmless request through the proxy and reports success/failure.
- The proxy is applied at the host's HTTP layer, **below** the plugin sandbox. Plugins never see proxy credentials.
- Untether does not ship a managed proxy and does not include credential vaulting for paid services beyond plain env-var / secret entry. The privacy promise is: "we honor your proxy choice." Choosing the proxy is the user's responsibility.

### 5.6 Plugin trust model

- **Pinned allowlist (default):** the default config ships only FUTO official plugin URLs (`grayjay-plugin-bitchute`, `grayjay-plugin-rumble`, `grayjay-plugin-dailymotion`). Specific URLs to be confirmed against `https://plugins.grayjay.app/` at implementation time.
- **Adding a URL** is a deliberate user action. The UI displays a "you are loading third-party code" confirmation that names the URL and explains the trust implications. No silent additions.
- **Content-hash pinning:** every loaded plugin is pinned to a specific content hash (sha256). A change in upstream content does not get loaded until the user accepts the new hash.
- **Update flow:** the runtime periodically checks the configured plugin URLs for new content. When new content is found, the UI surfaces "plugin update available" with: plugin name, source URL, current hash, new hash, plugin-declared version if available. One-click accept; no automatic acceptance.
- **No plugin secrets:** Untether never passes user secrets to plugins. Proxy credentials apply below the sandbox boundary; the YouTube API key never reaches plugin code.
- **Per-plugin egress visibility:** the rate-limiter metrics include per-plugin outbound counts. Surfaced in a runtime-health view (not a hard dependency for v0.2 ship, but instrument from day one).

### 5.7 Rate limiter — new sources

Three new entries in the per-source rate-limiter configuration. All values are defaults overridable by config.

| Source | Concurrency | Token bucket | Backoff on 429/403 | Notes |
|---|---|---|---|---|
| `dailymotion` | 4 | 30/min | 30s → 60s → 120s → circuit-open 10min | Respect documented quotas; tighten if 429s observed in testing. |
| `bitchute` | 2 | 12/min | 60s → 120s → 300s → circuit-open 30min | Conservative because upstream API has historically changed without notice; aggressive traffic accelerates breakage. |
| `rumble` | 1 | 6/min | 120s → 300s → 600s → circuit-open 60min | Lowest concurrency, longest backoff. Honors per-source proxy when configured. |

Hosted Cloudflare deployment may tighten these further; self-host can loosen them via env config.

### 5.8 UI updates

- **Source picker:** add Dailymotion, BitChute, Rumble entries. Rumble shows a "self-host recommended" badge on the hosted deployment; clicking the badge expands a short explanation and links to the proxy settings.
- **Settings → Proxy:** new panel. Lists each rate-limiter source. Per-source proxy URL entry + "test proxy" button. "All egress" toggle at the top.
- **Settings → Plugins:** new panel. Lists each loaded plugin (name, source URL, pinned hash, last updated). "Check for updates" button. Update-available items show the diff (current vs. new hash, version) with explicit Accept/Reject. Add-new-plugin entry with the third-party-code confirmation.
- **Error surfaces in the review grid:** distinguish "plugin error" vs. "rate-limited" vs. "proxy failure" so the user knows what to act on. Plugin errors should also include the plugin name so the user knows which to update or remove.

## 6. Build sequence

This is the order of work; each step has acceptance criteria before the next begins. Suitable for handoff to a single agent.

### 6.1 Step 1 — Dailymotion direct adapter

**Why first:** smallest delta from v0.1, validates the public GraphQL is as clean as the docs suggest, adds a third direct adapter without touching any new runtime work.

**Acceptance:**
- New `DailymotionAdapter` registered as a `PlatformAdapter` in the source registry.
- `searchChannels("Veritasium")` returns at least one candidate with non-null `displayName`, `avatarUrl`, and `subscriberCount`.
- `resolveChannel("https://www.dailymotion.com/<known-channel>")` returns a `ChannelCandidate` whose `url` round-trips back to the input.
- Rate limiter shows the `dailymotion` source with traffic.
- End-to-end: running an existing test job with Dailymotion enabled produces matches in the review grid.

### 6.2 Step 2 — Plugin runtime + reference test

**Why second:** standing up the runtime before BitChute/Rumble means the first plugin loaded can be validated against the direct Dailymotion adapter from Step 1. This is the polyfill correctness check.

**Acceptance:**
- Sandbox loads and executes `grayjay-plugin-dailymotion` without errors.
- The narrow polyfill (`http`, `utility`, `dom-parser`, lifecycle, `atob`/`btoa`) is sufficient for that plugin's search/resolve paths. If the plugin requires anything else, surface it explicitly and decide before implementing.
- A test harness runs the same query through both the direct adapter (Step 1) and the plugin-backed adapter (Step 2), and the result sets overlap by ≥80% on the top 5 candidates for an agreed sample of 10 channels. (The 80% bar accounts for ordering differences and minor field variance; tighten if early results suggest higher is achievable.)
- Sandbox enforces memory/CPU caps under test (a deliberately-broken plugin that loops forever gets killed cleanly).
- All plugin HTTP visibly traverses the rate limiter (logs show source attribution).

### 6.3 Step 3 — BitChute

**Acceptance:**
- `grayjay-plugin-bitchute` loads and runs in the runtime, pinned by content hash.
- `searchChannels` returns at least one candidate for a known-good query (suggest an agreed test channel that's been on BitChute for years).
- `resolveChannel(<known-bitchute-channel-url>)` returns a `ChannelCandidate`.
- BitChute appears in the source picker. End-to-end job with BitChute enabled produces grid matches.
- Mapping shim is documented (a few lines per field) so anyone debugging knows what the plugin returned vs. what we passed downstream.

### 6.4 Step 4 — BYO proxy plumbing

**Why before Rumble:** Rumble needs the proxy hook on hosted deployments; build it once, generally, then turn it on for Rumble.

**Acceptance:**
- Rate limiter dispatches outbound HTTP through a configured proxy when set.
- Per-source proxy config works (e.g. set proxy for `rumble` only; other sources unaffected).
- "All egress" toggle works.
- "Test proxy" button in settings returns a clear success/failure.
- Proxy failures surface as a distinct error class (not conflated with rate-limit or plugin errors).
- Existing v0.1 sources (PeerTube, Odysee, YouTube) continue to function unchanged when no proxy is configured (regression test).

### 6.5 Step 5 — Rumble

**Acceptance:**
- `grayjay-plugin-rumble` loads and runs in the runtime, pinned by content hash.
- On self-host (residential IP), `searchChannels` returns candidates for known-good queries.
- On hosted Cloudflare without proxy: requests reach Rumble; failures (Turnstile challenges, blocks) are reported as proxy-needed errors rather than silent empty results.
- On hosted Cloudflare with a configured BYO proxy: behavior matches self-host.
- Source picker shows Rumble with the "self-host recommended" badge on hosted; badge link goes to proxy settings.

### 6.6 Step 6 — Trust model implementation

This can run in parallel with Steps 3–5 but must be complete before release.

**Acceptance:**
- Default config ships only FUTO official plugin URLs.
- Adding a non-allowlisted URL requires explicit confirmation in the UI.
- Each plugin is pinned by content hash; mismatched hashes refuse to load.
- "Check for updates" surfaces updates with the diff information described in §5.6.
- No automatic plugin updates anywhere.

### 6.7 Step 7 — Polish

- Updated user-facing docs covering the three new platforms, the proxy story, and the plugin system.
- Source-picker UX review (icons, ordering, badges).
- Error surface review across plugin failures, rate-limit trips, and proxy failures.
- README updated with the v0.2 capabilities.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Plugin runtime polyfill scope creep — "just one more host API" | Every new binding requires justification against §3 non-goals. The polyfill is a search/resolve sandbox, not a Grayjay reimplementation. |
| Grayjay plugin API drift breaks all plugin-backed adapters at once | Plugins pinned by content hash; CI tests against pinned versions. Budget time for periodic polyfill updates. |
| Rumble hosted-deployment UX confuses users into thinking it's broken | Clear "self-host recommended" labeling, error surfaces that distinguish "blocked by Cloudflare" from "no results", proxy settings one click away. |
| Plugin supply-chain compromise of FUTO releases | Content-hash pinning means a compromised release isn't auto-pulled; user has to accept the new hash explicitly. Mitigation is bounded, not eliminated. |
| BitChute internal API changes again | This is exactly why we're using the plugin — FUTO maintains it. Our exposure is: a window between upstream breaking and FUTO shipping a fix. Document this honestly in the UI when a plugin source goes red. |
| `isolated-vm` is a heavy native dep that complicates self-host builds | Acceptable for the audience; document. Worth verifying it builds cleanly in the Docker image at Step 2 acceptance. |
| Sandboxing on Cloudflare via QuickJS-WASM may not handle every plugin | Documented fallback to the yt-dlp Cloudflare Container as a second runtime. If neither works for a given plugin, that plugin is self-host-only — surface clearly. |

## 8. Out of scope (v0.3+ candidates)

Captured here so they're not forgotten and not silently added.

- **More platforms via the existing runtime:** Vimeo, Nico Nico, RuTube, 3Speak, FOSDEM, TED, Bandcamp. Each is a config addition + a small mapping shim once v0.2 ships.
- **Plugin signature verification** against a FUTO-published public key (if FUTO ships a signing scheme).
- **Per-plugin permissions UI** à la browser extensions (which host bindings each plugin may use).
- **Plugin runtime telemetry dashboard** — exposing the per-plugin egress metrics in a UI view, not just logs.
- **Automatic plugin updates** for allowlisted FUTO plugins, with audit logging. Deliberately not in v0.2.
