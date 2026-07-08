# Pi Booth

A DIY photo booth built for events and weddings, running on a Raspberry Pi 4 with a DSLR camera and an iPad as the client interface.

## Stack

- **Server**: Node.js + Express + WebSocket
- **Client**: React + Vite (served as a PWA on the iPad)
- **Camera**: gPhoto2 (Nikon D3300 via USB)
- **Image processing**: Sharp
- **Printing**: CUPS (DNP DS-RX1H dye-sub printer)

## Features

- **Single photo** mode (4x6)
- **Photo strip** mode — 3-shot collage (2x6 strip at 300dpi)
  - Live countdown between each shot
  - Preview of each shot before the next countdown
- **Live camera preview** — switch between the iPad camera and Nikon DSLR live view
- **Auto-return** to home screen after photo is taken (configurable delay, 0 = disabled)
- **Auto-print** — when printing is enabled, prints automatically after capture (no button)
- **Photo template overlay** — composites couple name/date onto photos at print time (non-destructive, original file untouched)
- **Admin panel** (PIN-protected)
  - Settings: all config fields editable without restarting the server
  - Gallery tab: view, download, print (with or without template), and delete photos

## Hardware Setup

| Component | Details |
|-----------|---------|
| Pi | Raspberry Pi 4 (2GB) |
| Camera | Nikon D3300 via USB (gPhoto2) |
| Client | iPad (PWA, using either the front camera or DSLR live view) |
| Printer | DNP DS-RX1H (CUPS) |

### Pi Dependencies

```bash
sudo apt-get install gphoto2 libvips-dev librsvg2-dev cups printer-driver-gutenprint imagemagick
```

> `librsvg2-dev` is required for Sharp to render SVG template overlays.
> `imagemagick` is required to convert JPEG to PNG before sending to the dye-sub printer (the CUPS `imagetoraster` filter does not support JPEG directly).

### Printer Setup (one-time)

1. Connect the printer via USB, then enable and configure CUPS:
   ```bash
   sudo systemctl enable --now cups
   sudo cupsctl WebInterface=yes --remote-admin --remote-any
   sudo usermod -a -G lpadmin,lp pi
   ```
2. Open `https://<pi-ip>:631` in a browser, go to **Administration > Add Printer**
3. Select the DNP printer, name it (e.g. `DS-RX1`), and select the gutenprint driver
4. Run `lpstat -p` to confirm the printer name and update `print.printer` in config

## Project Structure

```
pi-booth/
├── server/
│   ├── index.js        # Express + WebSocket server, all API routes
│   ├── config.json     # Single source of truth for all settings
│   └── package.json
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── pages/
│   │   │   ├── StartPage.jsx
│   │   │   ├── CapturePage.jsx
│   │   │   └── AdminPage.jsx
│   │   └── hooks/
│   │       ├── usePhotobooth.js
│   │       └── useCountdown.js
│   └── package.json
├── data/
│   └── photos/         # Captured photos saved here (gitignored)
└── docs/
```

## Getting Started

### 1. Install dependencies

```bash
cd server && npm install
cd ../client && npm install
```

### 2. Configure

Edit `server/config.json` with your event details. At minimum set:

```json
{
  "camera": {
    "previewSource": "client",
    "simulateCapture": true
  },
  "print": {
    "enabled": false,
    "printer": "YOUR_PRINTER_NAME"
  }
}
```

Set `simulateCapture: false` on the Pi when the camera is connected. Set `previewSource: "dslr"` to use the Nikon live preview stream in the main booth UI; the server will stop that stream briefly during each capture and restart it automatically afterward.

### 3. Development

```bash
# From project root — runs server (port 3001) and Vite dev server (port 5173) separately
npm run dev:server   # terminal 1
npm run dev:client   # terminal 2
```

Client: `http://localhost:5173` — API calls are proxied to the server automatically.

### 4. Production (Pi)

Run the setup/startup script — it checks and installs all system dependencies, builds the client, and starts the server with pm2:

```bash
chmod +x start.sh
./start.sh
```

pm2 will keep the app running and restart it on reboot automatically.

```bash
pm2 logs pi-booth     # view logs
pm2 restart pi-booth  # restart
pm2 stop pi-booth     # stop
```

Access everything at `http://<pi-ip>` (no port number needed).

### 5. Access

- **Client (iPad)**: `https://<pi-ip>` — on first visit Safari will warn about the certificate; follow the trust steps below
- **Admin panel**: tap "Admin" on the start screen, default PIN: `1234`

> **Trusting the certificate on iPad (one-time setup)**
> 1. On the iPad, open Safari and go to `https://booth.local/cert` — tap Allow to download
> 2. Go to **Settings > General > VPN & Device Management** and tap the **pi-booth** profile, then tap **Install**
> 3. Go to **Settings > General > About > Certificate Trust Settings** and enable full trust for **pi-booth**

## Config Reference

| Key | Description |
|-----|-------------|
| `camera.previewSource` | `client` uses the iPad camera for live preview; `dslr` uses the Nikon live preview stream |
| `camera.simulateCapture` | Use a placeholder image instead of triggering gPhoto2 |
| `camera.shutterDelayMs` | Fires the capture request this many ms *before* the on-screen countdown hits 0 — compensates for camera/USB shutter lag so the shot lands right on "0" |
| `print.enabled` | Auto-print after every capture |
| `print.printer` | CUPS printer name (`lpstat -p` to list) |
| `print.singlePrintCopies` | Copies for single photos |
| `print.collagePrintCopies` | Copies for collage strips |
| `collage.countdownSeconds` | Countdown duration between strip shots |
| `collage.shotPreviewSeconds` | How long each shot preview is shown |
| `single.countdownSeconds` | Countdown duration for single photos |
| `booth.autoReturnSeconds` | Seconds before auto-returning home (0 = disabled) |
| `booth.matchDslrAspect` | Crops the live preview to a 2:3 portrait box (matching the DSLR photo) instead of filling the whole screen |
| `template.enabled` | Apply text overlay at print time |
| `template.imageFilename` | Uploaded full-strip overlay image for collage prints |
| `template.imagePlacement` | Whether uploaded strip art sits under or over strip photos |
| `template.text` | Overlay text (e.g. event name and date) |
| `template.fontSize` | Font size in px (at 600px width baseline, auto-scales) |
| `template.fontColor` | Hex color for overlay text |
| `template.overlayColor` | Background color of the text banner |
| `admin.pin` | PIN to access the admin panel |

## Photo Files

| Filename pattern | Description |
|-----------------|-------------|
| `photo_TIMESTAMP.jpg` | Single photo |
| `collage_shot_TIMESTAMP.jpg` | Individual shot from a strip session |
| `collage_TIMESTAMP.jpg` | Assembled photo strip |

Photos are stored in `data/photos/`. The template overlay is never baked into the saved file — it is only applied on-the-fly at print time.
