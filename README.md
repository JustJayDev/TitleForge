# ⚒️ TitleForge

**AI-powered bulk YouTube title renamer.** Connect your channel, AI analyzes every video, and forges perfect titles — review, then apply in one click. Open source, browser-based, AI key held server-side by the Developer Vault.

🔗 **Live:** https://justjaydev.github.io/TitleForge/

---

## ⚡ Quick start (2 minutes)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**
2. **Create a project** (or pick one) → **Enable the YouTube Data API v3**
3. **Create Credentials → OAuth client ID → Web app**
   - Name: `TitleForge`
   - **Authorised JavaScript origins:** `https://justjaydev.github.io`
   - **Authorised redirect URIs:** `https://justjaydev.github.io/TitleForge/app.html`
4. Copy the **Client ID** (looks like `1234-abc….apps.googleusercontent.com`)
5. Open `app.html` → **Connect with Google** → **Load videos** → **Connect the Vault** → **⚡ Forge titles**

That's it. No server, no database, no backend.

---

## 🔐 AI through the Developer Vault

The AI key is **never shipped in this repo or in the browser bundle.** TitleForge
calls the [Developer Vault](https://devvault.justjaydev.workers.dev), which holds
the key server-side and applies the `youtube-ai` project policy (least privilege):

```
browser (video metadata only) → Vault → AI provider
                              ↑ key decrypts here, never leaves
```

**One-time setup (operator):**

1. Open the [Vault UI](https://devvault.justjaydev.workers.dev) and log in
2. **Projects → YouTube AI → policy** is already granted `title_forge`
3. **Secrets → YouTube AI → New secret**, type `api_key`, paste your key
4. In TitleForge: **Connect the Vault** → approve → forge. The token lives in
   JS memory only and expires in 1 hour.

No key is ever written to `localStorage`, logged, or echoed to the browser.

---

## ✨ Features

- **One-click connect** — Google OAuth implicit flow, token stays in `sessionStorage`
- **Bulk fetch** — every video, paginated, with stats (views/likes/comments)
- **AI forge** — Vault-proxied AI, 3 concurrent batches (20 videos per request) for speed
- **SEO scoring** — before/after score with ▲/▼ delta on every title
- **Review table** — edit any title inline, live re-score, char counter, search & filter
- **Bulk apply** — rename hundreds of videos with a progress bar
- **Undo** — revert applied titles back to originals at any time
- **Export CSV** — take the whole forge report offline
- **Private by design** — zero credential storage in the bundle, fully auditable

---

## ⚠️ YouTube API quota

Renaming is not free in API terms. `videos.list` costs **1 unit**, but
`videos.update` costs **50 units** per video, and the default daily allowance is
**10,000 units**. That works out to roughly **195 renames per day**.

The app shows the estimated quota cost next to the Apply button before you
confirm, so you always know what a bulk apply will spend. If you exceed the
quota mid-run, the remaining renames fail and the app tells you how many
succeeded — you can retry the rest the next day.

Undo costs the same 50 units per video, so undo and re-apply together can
consume a full day's quota on a large channel. Renaming a small, targeted set
is cheaper than redoing everything.

---

## 🛠️ Tech

- Vanilla JS + HTML + CSS — no build step, no dependencies
- YouTube Data API v3 (`videos.list`, `videos.update`, `channels.list`)
- Google OAuth 2.0 implicit flow (`token` response type)
- GitHub Pages deployment

---

## 📁 Project structure

```
├── index.html   # Landing page
├── app.html     # The 4-step app UI
├── app.js       # Core logic (OAuth, YouTube, Vault forge, apply/undo)
├── vault.js     # Developer Vault client SDK (no credential in it)
├── app.css      # App-page styles
├── premium.css  # Premium layer (Vault card, rail, aurora, motion)
├── style.css    # Shared theme (dark neon)
├── 404.html     # SPA fallback
├── README.md
└── LICENSE      # MIT
```

---

## 🚀 Deploy

It's a static site — any host works. For GitHub Pages:

1. Push to `main`
2. Repo → **Settings → Pages → Deploy from branch → `main` / root**
3. Your `app.html` is live at `https://<user>.github.io/<repo>/app.html`

> **Note:** add both the domain root *and* the `app.html` path to your Google OAuth redirect URIs if you fork this.

---

## 🔒 Privacy

- Your Google token lives only in the current browser tab (`sessionStorage`) and is cleared when you close it
- Video data goes directly browser → YouTube / AI provider. No middle server exists
- API keys never leave the browser except to their own provider

---

## 📝 License

MIT © [JustJayDev](https://github.com/JustJayDev)