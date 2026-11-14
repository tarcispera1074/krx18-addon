# KRX18 Stremio / Nuvio Addon

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tarcispera1074/krx18-addon)

A self-hosted Stremio/Nuvio addon for **krx18.com** and **javeng.tv**.

It provides direct catalog browsing, metadata, and 1080p HLS playback with automatic header relaying and stream proxying.

## Catalogs

The addon provides 5 distinct catalogs:
1. **Featured 18+** (`https://krx18.com/` featured slider)
2. **Latest Movies 18+** (`https://krx18.com/` latest homepage releases)
3. **Recently Added (Movies)** (`https://krx18.com/movies/` - full paginated archive with genre filtering & search)
4. **Recently Added (X Clip)** (`https://krx18.com/genre/xxx/` - paginated short clips & search)
5. **Movies (JavEng)** (`https://javeng.tv/jav-eng-sub/` - English-subtitled JAV movies with search)

## Deploy to Render

1. Click the **Deploy to Render** button above (or create a new Web Service on [Render](https://dashboard.render.com/) pointing to this repository).
2. Render will automatically detect `render.yaml` or use:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/healthz`
3. Once deployed, copy your Render URL (e.g. `https://krx18-addon.onrender.com`).
4. Add to Nuvio / Stremio using:
   ```
   https://krx18-addon.onrender.com/manifest.json
   ```

## Local Installation & Running

```bash
cd "D:\Software\Nuvio setups\krx18-addon"
npm start
```
or double-click `start.bat`.

Output:
```
🚀 KRX18 Addon running on port 7005
   Manifest: http://localhost:7005/manifest.json
   Health:   http://localhost:7005/healthz
```

## Adding Local Server to Nuvio / Stremio

1. Open **Nuvio** (or Stremio).
2. Go to **Addons** → **Install from URL**.
3. Enter:
   ```
   http://localhost:7005/manifest.json
   ```
   *(Or your LAN IP if accessing from phone / TV, e.g. `http://192.168.1.X:7005/manifest.json`)*
4. Click **Install**. The catalogs will appear on your Discover / Board screen.

## Endpoints

| Endpoint | Description |
|---|---|
| `/manifest.json` | Addon manifest |
| `/healthz` | Uptime and cache status |
| `/catalog/movie/krx18_featured.json` | Featured 18+ |
| `/catalog/movie/krx18_latest_home.json` | Latest Movies 18+ |
| `/catalog/movie/krx18_movies_recent.json` | Recently Added (Movies) (supports `skip=`, `genre=`, `search=`) |
| `/catalog/movie/krx18_xxx_recent.json` | Recently Added (X Clip) (supports `skip=`, `search=`) |
| `/catalog/movie/javeng_movies.json` | Movies (JavEng) (supports `skip=`, `search=`) |
| `/meta/movie/{id}.json` | Movie synopsis, poster, backdrop, genres |
| `/stream/movie/{id}.json` | Direct 1080p HLS stream URLs |
| `/proxy` | Header-injecting proxy with m3u8 playlist rewriting |
