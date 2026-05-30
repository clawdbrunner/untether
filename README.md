# Untether

Find your YouTube creators on alternative video platforms.

Upload a Google Takeout subscriptions CSV, and Untether searches for matching channels across PeerTube, Odysee, Dailymotion, BitChute, and Rumble using name matching, avatar perceptual hashing, declared links, and handle comparison.

## Supported Platforms

| Platform    | Method              | Notes                                              |
|-------------|---------------------|----------------------------------------------------|
| PeerTube    | SepiaSearch API     | Searches across federated instances                 |
| Odysee      | Lighthouse API      | LBRY/Odysee channel search                          |
| Dailymotion | Public API          | User search + profile resolution                    |
| BitChute    | Public API          | Channel search via `api.bitchute.com`               |
| Rumble      | HTML scraping       | Cloudflare-protected; self-hosted w/ residential IP recommended |

## Features

- **Upload & go** — drop in your YouTube subscriptions CSV from Google Takeout
- **5-platform matching** — searches PeerTube, Odysee, Dailymotion, BitChute, and Rumble
- **Confidence tiers** — matches ranked as Verified, Likely, Possible, or Weak
- **Avatar comparison** — perceptual hashing detects same-channel avatars even with different crops
- **Declared link detection** — scrapes YouTube About pages for linked alternative accounts
- **Plugin system** — BitChute and Rumble backed by pinned Grayjay plugins with SHA-256 verification
- **BYO proxy** — route requests through SOCKS5/HTTP proxies per-source or globally
- **No API key required** — works without a YouTube Data API key (optional, improves enrichment)
- **One-click verify** — click platform badges to open matched channels in a new tab
- **Bulk actions** — accept all verified/likely matches at once
- **Export** — download your confirmed matches

## Quick Start

### Docker (recommended)

```bash
docker compose up -d
```

Open http://localhost:3000

### Manual

```bash
npm install
npm run dev
```

## Getting Your Subscriptions CSV

1. Go to [Google Takeout](https://takeout.google.com)
2. Deselect all, then select only **YouTube and YouTube Music**
3. Under YouTube, choose **subscriptions** only
4. Export and unzip
5. Upload `subscriptions.csv` from `YouTube and YouTube Music/subscriptions/`

## Optional: YouTube API Key

For richer channel data (thumbnails, exact subscriber counts), set a YouTube Data API v3 key in the UI. Works fine without one — avatars are scraped from channel pages instead.

## Proxy Configuration

Set environment variables to route adapter requests through a proxy:

```bash
# All sources through one proxy
PROXY_ALL=socks5://user:pass@host:1080

# Per-source proxy
PROXY_RUMBLE=socks5://user:pass@host:1080
PROXY_BITCHUTE=http://user:pass@host:8080
```

Source-specific proxies take priority over the catch-all.

## Architecture

```
src/
  lib/
    adapters/       # PeerTube, Odysee, Dailymotion adapters
    cache/          # File-based resource cache
    components/     # Svelte 5 UI components
    enrichment/     # YouTube channel enrichment (API + yt-dlp fallback)
    ingest/         # CSV parser for Google Takeout
    jobs/           # Durable job orchestrator (SQLite-backed)
    links/          # Declared link extraction
    matching/       # Scoring engine (name, handle, avatar, back-ref)
    plugins/        # Grayjay plugin runtime (isolated-vm sandbox)
    proxy/          # BYO proxy configuration
    rate-limit/     # Token bucket + circuit breaker per source
  routes/
    +page.svelte    # Main UI
    api/            # REST endpoints for jobs
data/
  platform-registry.csv   # Known video platforms
  peertube-instances.txt  # Known PeerTube instances
```

## Tech Stack

- **Frontend:** SvelteKit + Svelte 5
- **Backend:** SvelteKit server routes
- **Matching engine:** TypeScript — name similarity, pHash, declared links, handle matching
- **Storage:** SQLite (via better-sqlite3)
- **Plugins:** Grayjay plugin runtime with isolated-vm sandbox
- **Docker:** adapter-node production build

## License

MIT
