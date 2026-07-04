import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'https';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile, writeFile, unlink } from 'fs/promises';
import sharp from 'sharp';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CERT_PATH = path.join(__dirname, 'ssl/cert.pem');
const KEY_PATH  = path.join(__dirname, 'ssl/key.pem');

if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
  console.error('SSL certificate not found. Run ./start.sh to generate it.');
  process.exit(1);
}

const httpsOptions = {
  key:  readFileSync(KEY_PATH),
  cert: readFileSync(CERT_PATH),
};

const require = createRequire(import.meta.url);
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = require('./config.json');

const execAsync = promisify(exec);
const PHOTOS_DIR = path.join(__dirname, '../data/photos');

if (!existsSync(PHOTOS_DIR)) mkdirSync(PHOTOS_DIR, { recursive: true });

const app = express();
const server = createServer(httpsOptions, app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use('/photos', express.static(PHOTOS_DIR));

// Strip /api prefix — Vite proxy does this in dev, we do it here in production
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    req.url = req.url.replace('/api/', '/');
  }
  next();
});

// WebSocket broadcast helper
function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  });
}

// Capture a single photo via gphoto2
async function capturePhoto(filename) {
  const filepath = path.join(PHOTOS_DIR, filename);
  if (config.camera.simulateCapture) {
    // Generate a unique placeholder with a random background color
    const r = Math.floor(Math.random() * 120) + 60;
    const g = Math.floor(Math.random() * 120) + 60;
    const b = Math.floor(Math.random() * 120) + 60;
    await sharp({
      create: { width: 1800, height: 1200, channels: 3, background: { r, g, b } },
    }).jpeg().toFile(filepath);
    return filepath;
  }
  await execAsync(`gphoto2 --capture-image-and-download --filename "${filepath}" --force-overwrite`);
  return filepath;
}

// Build a 2x6 collage strip from N images
async function buildCollageStrip(imagePaths) {
  // 2x6 at 300dpi = 600x1800px
  const STRIP_W = 600;
  const STRIP_H = 1800;
  const border = config.print?.borderSize ?? 20;
  const backgroundColor = config.print?.backgroundColor ?? '#1a1a1a';
  const n = imagePaths.length;
  const THUMB_W = STRIP_W - border * 2;
  const THUMB_H = Math.floor((STRIP_H - border * (n + 1)) / n);

  const composites = await Promise.all(
    imagePaths.map(async (imgPath, i) => {
      const resized = await sharp(imgPath)
        .resize(THUMB_W, THUMB_H, { fit: 'cover' })
        .toBuffer();
      return { input: resized, top: border + i * (THUMB_H + border), left: border };
    })
  );

  const outputPath = path.join(PHOTOS_DIR, `collage_${Date.now()}.jpg`);
  await sharp({
    create: { width: STRIP_W, height: STRIP_H, channels: 3, background: backgroundColor },
  })
    .composite(composites)
    .jpeg({ quality: 95 })
    .toFile(outputPath);

  return outputPath;
}

// Print via CUPS
// Measured via a calibration ruler print: the div2 middle cut loses ~0px (clean cut), but the
// printer's own full-bleed trim eats a fixed number of pixels off the OUTER edges of the whole
// 4x6 sheet: ~25px off the left, ~20px off the right, ~5px off the top, ~40px off the bottom.
// These apply to any full 4x6 sheet, so both single photos and collages need to compensate by
// shrinking/shifting content inward on the trimmed sides, leaving un-trimmed (cut-line) edges as-is.
const TRIM_LEFT = 25;
const TRIM_RIGHT = 20;
const TRIM_TOP = 5;
const TRIM_BOTTOM = 40;

// Rotate landscape captures (e.g. the simulated camera's 1800x1200 placeholder) to portrait
// so downstream border/trim math — measured against a portrait 4x6 page — applies correctly.
// Returns a sharp pipeline plus the resulting (already-portrait) width/height.
async function toPortrait(filepath) {
  const meta = await sharp(filepath).metadata();
  const needsRotate = meta.width > meta.height;
  const pipeline = needsRotate ? sharp(filepath).rotate(90) : sharp(filepath);
  const width = needsRotate ? meta.height : meta.width;
  const height = needsRotate ? meta.width : meta.height;
  return { pipeline, width, height };
}

async function printFile(filepath, copies = 1, type = 'single') {
  const printer = config.print.printer;
  let fileToPrint = filepath;
  let tmpPng = null;

  if (type === 'collage') {
    // Place two copies of the strip side-by-side on a 4x6 canvas (1200x1800 at 300dpi).
    // Printer cuts at midpoint via w288h432-div2, producing two full 2x6 strips.
    tmpPng = filepath.replace(/\.(jpg|jpeg)$/i, `_print_tmp_${Date.now()}.png`);
    const backgroundColor = config.print?.backgroundColor ?? '#1a1a1a';
    const border = config.print?.borderSize ?? 20;

    // Must match buildCollageStrip()'s STRIP_W/STRIP_H exactly. Normalize (defensive) in case
    // a mismatched file is ever passed in, so the extract/composite math below can't crash.
    const stripW = 600;
    const stripH = 1800;
    const stripMeta = await sharp(filepath).metadata();
    const stripBuf = stripMeta.width === stripW && stripMeta.height === stripH
      ? await sharp(filepath).toBuffer()
      : (console.warn(`Collage strip was ${stripMeta.width}x${stripMeta.height}, expected ${stripW}x${stripH} — resizing to fit.`),
        await sharp(filepath).resize(stripW, stripH, { fit: 'fill' }).toBuffer());

    // Pull out just the inner content (photos + internal gaps), excluding the strip's own
    // baked-in outer border, so we can reposition/resize it independently per side.
    const contentBuf = await sharp(stripBuf)
      .extract({ left: border, top: border, width: stripW - 2 * border, height: stripH - 2 * border })
      .toBuffer();

    const contentH = stripH - TRIM_TOP - TRIM_BOTTOM - 2 * border;

    // Left copy: outer border compensated on the left, top and bottom; cut-side (right) border
    // stays as-is since the cut loses nothing.
    const leftContentW = stripW - TRIM_LEFT - 2 * border;
    const leftContent = await sharp(contentBuf).resize(leftContentW, contentH).toBuffer();
    const leftCopy = await sharp({ create: { width: stripW, height: stripH, channels: 3, background: backgroundColor } })
      .composite([{ input: leftContent, left: TRIM_LEFT + border, top: TRIM_TOP + border }])
      .png()
      .toBuffer();

    // Right copy: outer border compensated on the right, top and bottom; cut-side (left)
    // border stays as-is.
    const rightContentW = stripW - TRIM_RIGHT - 2 * border;
    const rightContent = await sharp(contentBuf).resize(rightContentW, contentH).toBuffer();
    const rightCopy = await sharp({ create: { width: stripW, height: stripH, channels: 3, background: backgroundColor } })
      .composite([{ input: rightContent, left: border, top: TRIM_TOP + border }])
      .png()
      .toBuffer();

    await sharp({ create: { width: 1200, height: 1800, channels: 3, background: backgroundColor } })
      .composite([
        { input: leftCopy, left: 0, top: 0 },
        { input: rightCopy, left: 600, top: 0 },
      ])
      .png()
      .toFile(tmpPng);
    fileToPrint = tmpPng;
  } else {
    // Single photo — no cut line, so all four edges are "outer" edges and all get trim
    // compensation. Render onto a fixed 1200x1800 (4x6 @ 300dpi) canvas so the same
    // measured pixel trims apply regardless of the source photo's native resolution.
    tmpPng = filepath.replace(/\.(jpg|jpeg)$/i, `_print_tmp_${Date.now()}.png`);
    const border = config.print?.borderSize ?? 0;
    const backgroundColor = config.print?.backgroundColor ?? '#1a1a1a';

    const contentW = 1200 - TRIM_LEFT - TRIM_RIGHT - 2 * border;
    const contentH = 1800 - TRIM_TOP - TRIM_BOTTOM - 2 * border;
    const { pipeline } = await toPortrait(filepath);
    const content = await pipeline.resize(contentW, contentH, { fit: 'cover' }).toBuffer();

    await sharp({ create: { width: 1200, height: 1800, channels: 3, background: backgroundColor } })
      .composite([{ input: content, left: TRIM_LEFT + border, top: TRIM_TOP + border }])
      .png()
      .toFile(tmpPng);
    fileToPrint = tmpPng;
  }

  const mediaSize = type === 'collage' ? 'w288h432-div2' : 'w288h432';
  const noCutWasteOpt = type === 'collage' ? '-o StpNoCutWaste=True' : '';
  try {
    await execAsync(`lp -d "${printer}" -n ${copies} -o PageSize=${mediaSize} ${noCutWasteOpt} "${fileToPrint}"`);
  } finally {
    if (tmpPng) await unlink(tmpPng).catch(() => {});
  }
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Add a name/text banner in a new blank strip BELOW the photo (the photo itself stays
// fully uncovered). Leaves the original file untouched; saves a _print version alongside it.
// Returns the print copy path, or null if template is disabled.
async function applyTemplate(filepath) {
  if (!config.template?.enabled || !config.template?.text) return null;

  const { pipeline, width, height } = await toPortrait(filepath);
  const text = escapeXml(config.template.text);
  const fontSize = Math.round((config.template.fontSize || 48) * (width / 600));
  const fontColor = config.template.fontColor || '#ffffff';
  const overlayColor = config.template.overlayColor || 'rgba(0,0,0,0.5)';
  // Height of the new blank strip added below the photo, scaled from a 600px-wide
  // reference (like fontSize) so it stays proportional at any source resolution.
  // Adjustable in the admin panel (template.bannerHeight).
  const bannerH = Math.round((config.template.bannerHeight ?? 100) * (width / 600));
  const newHeight = height + bannerH;
  const textY = height + Math.round(bannerH / 2);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${newHeight}">
    <text x="${Math.round(width / 2)}" y="${textY}"
      text-anchor="middle" dominant-baseline="middle"
      font-size="${fontSize}" fill="${fontColor}" font-family="Georgia, serif">${text}</text>
  </svg>`;

  // Save as a separate _print copy; original stays clean
  const ext = path.extname(filepath);
  const printPath = filepath.replace(new RegExp(`${ext}$`), `_print${ext}`);

  await pipeline
    .extend({ bottom: bannerH, background: overlayColor })
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .jpeg({ quality: 95 })
    .toFile(printPath);

  return printPath;
}

// --- Routes ---

// GET /cert - download the self-signed SSL cert for iPad trust installation
app.get('/cert', (req, res) => {
  if (!existsSync(CERT_PATH)) return res.status(404).send('Certificate not found');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="pi-booth.crt"');
  res.sendFile(CERT_PATH);
});

// GET /config - send safe config to frontend
app.get('/config', (req, res) => {
  res.json({
    wedding: config.wedding,
    picture: config.picture,
    collage: config.collage,
    single: config.single,
    gallery: config.gallery,
    booth: config.booth,
    template: { enabled: config.template?.enabled ?? false },
    print: {
      enabled: config.print.enabled,
      singlePrintCopies: config.print.singlePrintCopies,
      collagePrintCopies: config.print.collagePrintCopies,
    },
  });
});

// POST /capture/single - take one photo
app.post('/capture/single', async (req, res) => {
  try {
    const filename = `photo_${Date.now()}.jpg`;
    broadcast({ event: 'capturing' });
    const filepath = await capturePhoto(filename);
    broadcast({ event: 'captured', filename });
    res.json({ success: true, filename, url: `/photos/${filename}` });
  } catch (err) {
    console.error('Capture error:', err);
    broadcast({ event: 'error', message: 'Capture failed' });
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /capture/shot - capture one shot for a collage (frontend controls timing)
app.post('/capture/shot', async (req, res) => {
  try {
    const filename = `collage_shot_${Date.now()}.jpg`;
    const filepath = await capturePhoto(filename);
    res.json({ success: true, filename, url: `/photos/${filename}` });
  } catch (err) {
    console.error('Shot capture error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /collage/build - build strip from captured shot filenames
app.post('/collage/build', async (req, res) => {
  try {
    const { filenames } = req.body;
    if (!filenames?.length) return res.status(400).json({ success: false, error: 'filenames required' });

    const imagePaths = filenames.map((f) => path.join(PHOTOS_DIR, f));
    broadcast({ event: 'building_collage' });
    const collageFile = await buildCollageStrip(imagePaths);
    const collageFilename = path.basename(collageFile);
    res.json({ success: true, filename: collageFilename, url: `/photos/${collageFilename}` });
  } catch (err) {
    console.error('Collage build error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /print - print a photo
app.post('/print', async (req, res) => {
  try {
    const { filename, type, withTemplate = false } = req.body; // type: 'single' | 'collage'
    if (!filename) return res.status(400).json({ success: false, error: 'filename required' });

    const filepath = path.join(PHOTOS_DIR, filename);
    if (!existsSync(filepath)) return res.status(404).json({ success: false, error: 'File not found' });

      // Optionally composite template on-the-fly to a temp file, then print it
    let fileToPrint = filepath;
    let tempPath = null;
    if (withTemplate) {
      tempPath = await applyTemplate(filepath);
      if (tempPath) fileToPrint = tempPath;
    }

    const copies = type === 'collage' ? config.print.collagePrintCopies : config.print.singlePrintCopies;
    await printFile(fileToPrint, copies, type);
    if (tempPath) await unlink(tempPath);
    broadcast({ event: 'printing', filename, copies });
    res.json({ success: true });
  } catch (err) {
    console.error('Print error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /gallery - list all photos
app.get('/gallery', async (req, res) => {
  try {
    const files = await readdir(PHOTOS_DIR);
    const photos = files
      .filter((f) => f.match(/\.(jpg|jpeg|png)$/i))
      .sort()
      .reverse()
      .map((f) => ({ filename: f, url: `/photos/${f}` }));
    res.json({ photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/print-calibration - print a ruler test pattern to measure exact cut bleed.
// Draws tick marks every 10px labeled with the ABSOLUTE pixel position (0-1200),
// colors the left half light blue and the right half light pink so the two pieces
// are unambiguous after cutting, and marks the intended cut line in red at x=600.
app.post('/admin/print-calibration', async (req, res) => {
  try {
    const { pin } = req.body;
    if (pin !== String(config.admin?.pin ?? '1234')) {
      return res.status(401).json({ success: false, error: 'Invalid PIN' });
    }

    const W = 1200, H = 1800;
    let ticks = '';
    for (let x = 0; x <= W; x += 10) {
      const isMajor = x % 50 === 0;
      const tickH = isMajor ? 60 : 25;
      ticks += `<line x1="${x}" y1="0" x2="${x}" y2="${tickH}" stroke="black" stroke-width="${isMajor ? 3 : 1}"/>`;
      ticks += `<line x1="${x}" y1="${H}" x2="${x}" y2="${H - tickH}" stroke="black" stroke-width="${isMajor ? 3 : 1}"/>`;
      if (isMajor) {
        // Absolute pixel position, not offset — avoids sign confusion
        ticks += `<text x="${x}" y="${tickH + 30}" text-anchor="middle" font-size="22" fill="black">${x}</text>`;
        ticks += `<text x="${x}" y="${H - tickH - 15}" text-anchor="middle" font-size="22" fill="black">${x}</text>`;
      }
    }
    // Vertical reference line at the intended cut midpoint
    ticks += `<line x1="${W / 2}" y1="0" x2="${W / 2}" y2="${H}" stroke="red" stroke-width="4"/>`;

    // Vertical rulers (measure top/bottom trim) - one placed inside each half so neither
    // gets lost to the middle cut. Absolute Y pixel positions (0-1800), labeled every 50px.
    let vticks = '';
    const vRulerXs = [100, 1100];
    for (const rx of vRulerXs) {
      for (let y = 0; y <= H; y += 10) {
        const isMajor = y % 50 === 0;
        const tickLen = isMajor ? 60 : 25;
        vticks += `<line x1="${rx}" y1="${y}" x2="${rx + tickLen}" y2="${y}" stroke="black" stroke-width="${isMajor ? 3 : 1}"/>`;
        if (isMajor) {
          vticks += `<text x="${rx + tickLen + 8}" y="${y + 7}" text-anchor="start" font-size="20" fill="black">${y}</text>`;
        }
      }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect x="0" y="0" width="${W / 2}" height="${H}" fill="#cfe8ff"/>
      <rect x="${W / 2}" y="0" width="${W / 2}" height="${H}" fill="#ffd6e8"/>
      <text x="${W / 4}" y="${H / 2}" text-anchor="middle" font-size="60" fill="black">LEFT</text>
      <text x="${(3 * W) / 4}" y="${H / 2}" text-anchor="middle" font-size="60" fill="black">RIGHT</text>
      ${ticks}
      ${vticks}
    </svg>`;

    const calibPath = path.join(PHOTOS_DIR, `_calibration_${Date.now()}.png`);
    await sharp(Buffer.from(svg)).png().toFile(calibPath);

    const printer = config.print.printer;
    await execAsync(`lp -d "${printer}" -n 1 -o PageSize=w288h432-div2 -o StpNoCutWaste=True "${calibPath}"`);
    await unlink(calibPath).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('Calibration print error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Admin Routes ---

// GET /admin/config - full config for admin panel
app.get('/admin/config', (req, res) => {
  res.json(config);
});

// POST /admin/config - save updated config
app.post('/admin/config', async (req, res) => {
  try {
    const { pin, updates } = req.body;
    if (pin !== String(config.admin?.pin ?? '1234')) {
      return res.status(401).json({ success: false, error: 'Invalid PIN' });
    }
    // Deep merge updates into config
    config = deepMerge(config, updates);
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
    // Broadcast config change to all clients
    broadcast({ event: 'config_updated' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /admin/photos/:filename - delete a photo
app.delete('/admin/photos/:filename', async (req, res) => {
  try {
    const { pin } = req.body;
    if (pin !== String(config.admin?.pin ?? '1234')) {
      return res.status(401).json({ success: false, error: 'Invalid PIN' });
    }
    const filename = path.basename(req.params.filename); // sanitize
    const filepath = path.join(PHOTOS_DIR, filename);
    if (!existsSync(filepath)) return res.status(404).json({ success: false, error: 'File not found' });
    await unlink(filepath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.send(JSON.stringify({ event: 'connected' }));
});

const PORT = 443;
server.listen(PORT, '0.0.0.0', () => {
  // Serve built client in production (registered last so API routes take priority)
  const CLIENT_DIST = path.join(__dirname, '../client/dist');
  if (existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get('*', (req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  }
  console.log(`Pi Booth server running on https://0.0.0.0:${PORT}`);
});
