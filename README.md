# Untether

Find your YouTube subscriptions on PeerTube and Odysee.

Upload a Google Takeout subscriptions CSV, and Untether searches for matching channels across alternative video platforms using name matching, avatar perceptual hashing, declared links, and handle comparison.

## Features

- **Upload & go** — drop in your YouTube subscriptions CSV from Google Takeout
- **Multi-platform matching** — searches PeerTube and Odysee automatically
- **Confidence tiers** — matches ranked as Verified, Likely, Possible, or Weak
- **Avatar comparison** — perceptual hashing detects same-channel avatars even with different crops
- **Declared link detection** — scrapes YouTube About pages for linked PeerTube/Odysee accounts
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

## Tech Stack

- **Frontend:** SvelteKit + Svelte 5
- **Backend:** SvelteKit server routes
- **Matching engine:** TypeScript — name similarity, pHash, declared links, handle matching
- **Storage:** SQLite (via better-sqlite3)
- **Docker:** adapter-node production build

## License

MIT
