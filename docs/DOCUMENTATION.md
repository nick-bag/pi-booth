# Pi Booth — Application Documentation

> DIY wedding photo booth powered by a Raspberry Pi 4, Nikon D3300, and iPad PWA.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [Backend](#backend)
5. [Frontend](#frontend)
6. [Configuration](#configuration)
7. [Admin Panel](#admin-panel)
8. [Simulate Mode](#simulate-mode)
9. [Photo Strip (Collage)](#photo-strip-collage)
10. [Printing](#printing)
11. [Gallery](#gallery)
12. [PWA / iPad Setup](#pwa--ipad-setup)
13. [Running the App](#running-the-app)
14. [Known Limitations & Future Work](#known-limitations--future-work)

---

## Overview

Pi Booth is a custom web-based photo booth application designed for a wedding. Guests interact with an iPad running a Progressive Web App (PWA). The iPad communicates with a Node.js server running on a Raspberry Pi 4, which controls a tethered Nikon D3300 camera and a dye-sub printer.

**Key goals:**
- Feels like a native app on the iPad (fullscreen, fast, responsive)
- No internet required — runs entirely on local network
- Easy to customize for the wedding (names, colors, branding)
- Admin panel accessible without touching config files

---

## Architecture

```
iPad (React PWA)
    │
    │  HTTP (REST) + WebSocket
    ▼
Node.js / Express Server (Raspberry Pi 4)
    │               │
    ▼               ▼
gphoto2         CUPS
(Nikon D3300)   (DNP QW410 printer)
```

- The iPad connects to the Pi over WiFi
- The React app is served by the Vite dev server (development) or Express static files (production)
- REST endpoints handle capture, print, and gallery
- WebSocket pushes real-time status events to the iPad (connection status, config updates)
- `gphoto2` controls the camera via USB tethering
- CUPS handles printing via USB

---

## Project Structure

```
pi-booth/
├── server/
│   ├── index.js          # Express + WebSocket server
│   ├── config.json       # All app configuration
│   ├── package.json
│   └── placeholder.jpg   # Used in simulate mode
│
├── client/
│   ├── index.html
│   ├── vite.config.js    # Vite + PWA plugin config
│   ├── package.json
│   └── src/
│       ├── main.jsx
│       ├── App.jsx           # Top-level router and state
│       ├── index.css         # Global styles + CSS variables
│       ├── components/
│       │   ├── BigButton.jsx         # Touch-friendly button
│       │   ├── BigButton.module.css
│       │   ├── Countdown.jsx         # Animated countdown (3..2..1)
│       │   └── Countdown.module.css
│       ├── hooks/
│       │   ├── usePhotobooth.js  # API calls + WebSocket hook
│       │   └── useCountdown.js   # Countdown timer hook
│       └── pages/
│           ├── StartPage.jsx         # Home screen
│           ├── StartPage.module.css
│           ├── CapturePage.jsx       # Countdown → capture → preview → print
│           ├── CapturePage.module.css
│           ├── GalleryPage.jsx       # Photo grid
│           ├── GalleryPage.module.css
│           ├── AdminPage.jsx         # Admin settings panel
│           └── AdminPage.module.css
│
├── data/
│   └── photos/           # All captured photos stored here
│
├── docs/
│   ├── DOCUMENTATION.md          # This file
│   └── gphoto2-optimization.md   # gphoto2 latency optimization notes
│
└── package.json          # Root scripts
```

---

## Backend

**Stack:** Node.js (ESM), Express, ws (WebSocket), sharp (image processing)

**Entry point:** `server/index.js`

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/config` | Returns safe config subset for the frontend |
| `POST` | `/capture/single` | Captures one photo, returns filename + URL |
| `POST` | `/capture/shot` | Captures one shot for a collage (frontend manages timing) |
| `POST` | `/collage/build` | Builds a 2x6 strip from an array of filenames |
| `POST` | `/print` | Prints a photo via CUPS |
| `GET` | `/gallery` | Returns list of all photos |
| `GET` | `/admin/config` | Returns full config (admin use) |
| `POST` | `/admin/config` | Saves updated config (requires PIN) |
| `GET` | `/photos/:filename` | Serves photo files statically |

### WebSocket Events (server → client)

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Client connected |
| `capturing` | — | Camera triggered |
| `captured` | `{ filename }` | Photo captured |
| `building_collage` | — | Strip composition started |
| `printing` | `{ filename, copies }` | Print job sent |
| `error` | `{ message }` | Something went wrong |
| `config_updated` | — | Admin saved new config |

### Camera Control

Currently uses `gphoto2` CLI via `child_process.exec`. See [`docs/gphoto2-optimization.md`](./gphoto2-optimization.md) for a planned upgrade to `node-gphoto2` for lower latency.

```bash
gphoto2 --capture-image-and-download --filename "/path/to/photo.jpg" --force-overwrite
```

---

## Frontend

**Stack:** React 18, Vite, CSS Modules, vite-plugin-pwa

### App Flow

```
StartPage
  ├── Take a Photo → CapturePage (type: 'single')
  │     └── Countdown → Capture → Preview → Print → Done
  ├── Photo Strip  → CapturePage (type: 'collage')
  │     └── Countdown (×3) → Capture each shot → Build strip → Preview → Print → Done
  └── Gallery      → GalleryPage
        └── Thumbnail grid → Full-screen view
```

### State Management

All top-level state lives in `App.jsx`:
- `view` — current page (`start` | `capture` | `gallery` | `admin`)
- `captureType` — `'single'` or `'collage'`
- `config` — fetched from server on load, re-fetched on `config_updated` WS event

### CSS Variables

Defined in `index.css`, overridden at runtime from config:

```css
--primary       /* Accent color (default: gold #c9a96e) */
--bg            /* Background color (default: #1a1a1a) */
--text          /* Text color (default: #ffffff) */
--surface       /* Card/panel background */
--surface2      /* Secondary surface */
--danger        /* Error red */
--success       /* Success green */
```

---

## Configuration

All configuration lives in `server/config.json`. Changes made via the admin panel are written back to this file.

```json
{
  "wedding": {
    "title": "Sarah & James",
    "subtitle": "July 12, 2026",
    "primaryColor": "#c9a96e",
    "backgroundColor": "#1a1a1a",
    "textColor": "#ffffff"
  },
  "camera": {
    "simulateCapture": false
  },
  "picture": {
    "enabled": true
  },
  "collage": {
    "enabled": true,
    "shots": 3,
    "layout": "2x6-strip",
    "countdownSeconds": 3,
    "shotPreviewSeconds": 3
  },
  "single": {
    "layout": "4x6",
    "countdownSeconds": 3
  },
  "print": {
    "enabled": true,
    "printer": "DNP_QW410",
    "singlePrintCopies": 1,
    "collagePrintCopies": 2
  },
  "template": {
    "enabled": true,
    "text": "Your Names · Your Date",
    "bannerHeight": 100,
    "overlayColor": "#000000",
    "imageFilename": null,
    "imageUpdatedAt": 0
  },
  "gallery": {
    "enabled": true
  },
  "admin": {
    "pin": "1234"
  }
}
```

---

## Admin Panel

The admin panel is hidden from guests and accessible via a **secret gesture**: tap the couple's name on the start screen **5 times quickly**.

### Access
1. Tap the title 5 times on the start screen
2. Enter the PIN (default: `1234`)
3. Make changes and tap **Save Changes**

### Settings Available

| Section | Settings |
|---------|----------|
| Wedding Details | Couple's names, date/subtitle |
| Colors | Accent color, background, text color |
| Print Settings | Printer name, copies per type, enable/disable |
| Features | Toggle single photos, photo strips, gallery, simulate mode |
| Countdown | Seconds per countdown, delay between collage shots |
| Photo Template | Basic text banner settings plus uploaded strip overlay image |
| Admin PIN | Change the admin PIN |

Changes are saved to `config.json` on the server and broadcast to all connected clients via WebSocket so the UI updates immediately without a page refresh.

---

## Simulate Mode

Simulate mode allows testing the full app flow without a connected camera or printer.

**Enable:** Admin panel → Features → Simulate Camera → On → Save

**Behavior:**
- Instead of calling `gphoto2`, the server generates a random solid-color JPEG for each capture
- Each simulated shot gets a different color so collage strips show distinct images
- Print calls are skipped silently (CUPS not invoked)

**Use for:** UI testing, flow verification, demo purposes

---

## Photo Strip (Collage)

The photo strip captures 3 photos and composites them into a 2×6 inch print (printed as two copies by default, so each person gets one).

### Capture Flow (frontend-controlled)

```
Shot 1 countdown → capture → Shot 2 countdown → capture → Shot 3 countdown → capture → build strip → preview
```

The frontend controls the countdown for each shot, calling `POST /capture/shot` after each countdown. Once all shots are captured, it calls `POST /collage/build` with the array of filenames.

### Strip Dimensions

| Property | Value |
|----------|-------|
| Output size | 600 × 1800 px |
| Each photo | 600 × 580 px |
| Gap between photos | 20 px |
| Background | Matches `backgroundColor` from config |
| DPI equivalent | 300 dpi at 2×6 inches |
| Print copies | 2 (configurable) |

---

## Printing

Printing is handled via CUPS (`lp` command).

```bash
lp -d "PRINTER_NAME" -n COPIES "/path/to/photo.jpg"
```

**Setup:**
1. Connect printer via USB
2. Add printer in CUPS admin: `http://pi.local:631`
3. Update printer name in admin panel to match CUPS printer name

**Single photo:** Prints full 4×6, 1 copy (configurable)
**Photo strip:** Prints 2×6 strip, 2 copies (configurable) — guests each get one

---

## Gallery

The gallery shows all captured photos (single photos and completed collage strips). Individual collage shots (`collage_shot_*.jpg`) are filtered out and not shown.

Photos are displayed newest-first in a 3-column grid. Tap any photo to view full-screen.

---

## PWA / iPad Setup

The app is configured as an installable PWA via `vite-plugin-pwa`.

### Install on iPad
1. Open Safari and navigate to `http://<pi-ip>:5173`
2. Tap the **Share** button → **Add to Home Screen**
3. The app installs with a fullscreen, app-like experience

### Lock to kiosk mode
Use **Guided Access** to prevent guests from leaving the app:
1. Settings → Accessibility → Guided Access → Enable
2. Open Pi Booth, triple-click the side button to activate Guided Access

### PWA Manifest Settings
- Display: `fullscreen`
- Orientation: `portrait`
- Theme color: `#1a1a1a`
- Background color: `#1a1a1a`

---

## Running the App

### Development

```bash
# Terminal 1 — backend
cd pi-booth/server
npm start

# Terminal 2 — frontend
cd pi-booth/client
npm run dev
```

Frontend: `http://localhost:5173`
Backend: `http://localhost:3001`

### On the Raspberry Pi (when ready)

```bash
# Install dependencies (first time only)
cd pi-booth && npm run install:all

# Start backend
cd server && npm start

# Build and serve frontend (production)
cd ../client && npm run build
# Then configure Express to serve client/dist/
```

### Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend server port |

---

## Known Limitations & Future Work

### Current Limitations
- **gphoto2 CLI latency** — 1–3s per capture due to process startup. See `docs/gphoto2-optimization.md`
- **No retake on collage** — if a shot is bad, guest must start over
- **No file cleanup** — collage temp shots accumulate in `data/photos/`
- **No gallery pagination** — all photos loaded at once
- **No digital sharing** — no QR code / email / SMS (planned for later)
- **Running Vite dev server** — not optimized for production use yet

### Planned
- [ ] `node-gphoto2` integration for lower capture latency
- [ ] Retake option on collage preview
- [ ] Gallery pagination
- [ ] File cleanup for orphaned collage shots
- [ ] Production build served via Express
- [ ] pm2 process management
- [ ] Digital sharing via QR code
