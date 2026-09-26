# ⚒️ TitleForge

**AI-powered bulk YouTube title renamer.** Connect your channel, let AI analyze every video and forge perfect, click-worthy titles — review, then apply in one click.

Built by [JustJayDev](https://justjaydev.github.io/). Open source, MIT licensed.

## Live site
👉 [justjaydev.github.io/TitleForge](https://justjaydev.github.io/TitleForge/)

## Features
- 🔗 **Connect with Google** — OAuth 2.0, token stays in your browser only
- 🤖 **AI Title Engine** — analyzes every video (title, description, views, likes) and rewrites titles for max CTR
- 🧠 **Bring Your Own AI** — use the free default model, or paste your own OpenAI / Claude / Gemini key
- ⚡ **Bulk Apply** — rename 10 or 1,000 videos in one click with live progress
- 📊 **SEO Score** — see click-worthiness before & after
- ↩️ **Undo** — roll back renames anytime
- 🔒 **Private by Design** — token in sessionStorage only, zero server storage

## How it works
1. **Connect** — Sign in with Google
2. **Analyze** — AI reads all your videos' content & performance
3. **Forge** — fresh, click-worthy titles generated for every video
4. **Apply** — review the preview table (edit anything), bulk-apply with one click

## Tech
- Static frontend (HTML/CSS/JS) on GitHub Pages
- YouTube Data API v3 (browser-to-YouTube, no server)
- Pluggable AI providers (default / OpenAI / Claude / Gemini)

## Project status
🚧 **In active development** — the app skeleton is live. The AI engine, OAuth client config, and default free model are being wired up. This is the "build phase" — coming soon.

## Self-host / contribute
1. Clone this repo
2. Fill in your OAuth `CLIENT_ID` in `app.js` (Web application type, add your GitHub Pages URL as redirect URI + JS origin)
3. Enable the **YouTube Data API v3** in your Google Cloud project
4. Deploy the `index.html`, `app.html`, `style.css`, `app.js` to any static host

PRs welcome!

## License
MIT
