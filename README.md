# ⚒️ TitleForge

**AI-powered bulk YouTube title renamer.** Connect your channel, AI analyzes every video, and forges perfect titles — review, then apply in one click. Open source, browser-based, bring-your-own-API or free default.

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
5. Paste it into `app.js`:
   ```js
   const CONFIG = {
     CLIENT_ID: 'your-client-id.apps.googleusercontent.com',
     ...
   };
   ```
6. Open `app.html` → **Connect with Google** → **Load videos** → **⚡ Forge titles**

That's it. No server, no database, no backend.

---

## 🤖 AI providers

| Provider | Setup | Notes |
|----------|-------|-------|
| **Default (free)** | None — works out of the box | Runs on a free OpenAI-compatible gateway. To enable it, set `CONFIG.DEFAULT_AI.key` in `app.js` |
| **OpenAI** | Paste API key | `gpt-4o-mini` |
| **Claude** | Paste API key | `claude-3-5-haiku-latest` |
| **Gemini** | Paste API key | `gemini-1.5-flash` |

API keys are used only for direct browser→provider requests and are never stored or logged.

---

## ✨ Features

- **One-click connect** — Google OAuth implicit flow, token stays in `sessionStorage`
- **Bulk fetch** — every video, paginated, with stats (views/likes/comments)
- **AI forge** — 4 pluggable providers, 6 concurrent requests for speed
- **SEO scoring** — before/after score with ▲/▼ delta on every title
- **Review table** — edit any title inline, live re-score, char counter, search & filter
- **Bulk apply** — rename hundreds of videos with a progress bar
- **Undo** — revert applied titles back to originals at any time
- **Export CSV** — take the whole forge report offline
- **Private by design** — zero server storage, fully auditable

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
├── app.js       # Core logic (OAuth, YouTube, AI engine, apply/undo)
├── app.css      # App-page styles
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