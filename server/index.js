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
async function printFile(filepath, copies = 1, type = 'single') {
  const printer = config.print.printer;
  let fileToPrint = filepath;
  let tmpPng = null;

  if (type === 'collage') {
    // Place two copies of the strip side-by-side on a 4x6 canvas (1200x1800 at 300dpi)
    // Printer cuts at midpoint via w288h432-div2, producing two full 2x6 strips.
    // Each strip is resized to (600 - borderSize) wide, then explicitly extended with
    // borderSize pixels of background color on the cut-facing edge, so after cutting
    // each 2x6 strip has a visible border on all four sides.
    tmpPng = filepath.replace(/\.(jpg|jpeg)$/i, `_print_tmp_${Date.now()}.png`);
    const border = config.print?.borderSize ?? 20;
    const backgroundColor = config.print?.backgroundColor ?? '#1a1a1a';
    const innerW = 600 - border;

    const leftStrip = await sharp(filepath)
      .resize(innerW, 1800, { fit: 'fill' })
      .extend({ right: border, background: backgroundColor })
      .toBuffer();

    const rightStrip = await sharp(filepath)
      .resize(innerW, 1800, { fit: 'fill' })
      .extend({ left: border, background: backgroundColor })
      .toBuffer();

    await sharp({ create: { width: 1200, height: 1800, channels: 3, background: backgroundColor } })
      .composite([
        { input: leftStrip, left: 0, top: 0 },
        { input: rightStrip, left: 600, top: 0 },
      ])
      .png()
      .toFile(tmpPng);
    fileToPrint = tmpPng;
  } else {
    // Single photo — add border and convert to PNG (imagetoraster filter doesn't support JPEG)
    tmpPng = filepath.replace(/\.(jpg|jpeg)$/i, `_print_tmp_${Date.now()}.png`);
    const border = config.print?.borderSize ?? 0;
    const backgroundColor = config.print?.backgroundColor ?? '#1a1a1a';
    if (border > 0) {
      const { width } = await sharp(filepath).metadata();
      const scaledBorder = Math.round(border * (width / 600));
      await sharp(filepath)
        .extend({ top: scaledBorder, bottom: scaledBorder, left: scaledBorder, right: scaledBorder, background: backgroundColor })
        .png()
        .toFile(tmpPng);
    } else {
      await execAsync(`convert "${filepath}" "${tmpPng}"`);
    }
    fileToPrint = tmpPng;
  }

  const mediaSize = type === 'collage' ? 'w288h432-div2' : 'w288h432';
  try {
    await execAsync(`lp -d "${printer}" -n ${copies} -o PageSize=${mediaSize} "${fileToPrint}"`);
  } finally {
    if (tmpPng) await unlink(tmpPng).catch(() => {});
  }
}

// Composite a text overlay banner onto a copy of the photo (bottom of image).
// Leaves the original file untouched; saves a _print version alongside it.
// Returns the print copy path, or null if template is disabled.
async function applyTemplate(filepath) {
  if (!config.template?.enabled || !config.template?.text) return null;

  const { width, height } = await sharp(filepath).metadata();
  const text = config.template.text;
  // Scale font size relative to collage strip width (600px baseline)
  const fontSize = Math.round((config.template.fontSize || 48) * (width / 600));
  const fontColor = config.template.fontColor || '#ffffff';
  const overlayColor = config.template.overlayColor || 'rgba(0,0,0,0.5)';
  const bannerH = Math.round(fontSize * 2.4);
  const bannerY = height - bannerH;
  const textY = bannerY + Math.round(bannerH / 2);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect x="0" y="${bannerY}" width="${width}" height="${bannerH}" fill="${overlayColor}"/>
    <text x="${Math.round(width / 2)}" y="${textY}"
      text-anchor="middle" dominant-baseline="middle"
      font-size="${fontSize}" fill="${fontColor}" font-family="Georgia, serif">${text}</text>
  </svg>`;

  // Save as a separate _print copy; original stays clean
  const ext = path.extname(filepath);
  const printPath = filepath.replace(new RegExp(`${ext}$`), `_print${ext}`);

  await sharp(filepath)
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
    if (withTemplate && config.template?.enabled && config.template?.text) {
      const ext = path.extname(filepath);
      tempPath = filepath.replace(new RegExp(`${ext}$`), `_tmp_print_${Date.now()}${ext}`);
      const { width, height } = await sharp(filepath).metadata();
      const text = config.template.text;
      const fontSize = Math.round((config.template.fontSize || 48) * (width / 600));
      const fontColor = config.template.fontColor || '#ffffff';
      const overlayColor = config.template.overlayColor || 'rgba(0,0,0,0.5)';
      const bannerH = Math.round(fontSize * 2.4);
      const bannerY = height - bannerH;
      const textY = bannerY + Math.round(bannerH / 2);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect x="0" y="${bannerY}" width="${width}" height="${bannerH}" fill="${overlayColor}"/>
        <text x="${Math.round(width / 2)}" y="${textY}"
          text-anchor="middle" dominant-baseline="middle"
          font-size="${fontSize}" fill="${fontColor}" font-family="Georgia, serif">${text}</text>
      </svg>`;
      await sharp(filepath)
        .composite([{ input: Buffer.from(svg), blend: 'over' }])
        .jpeg({ quality: 95 })
        .toFile(tempPath);
      fileToPrint = tempPath;
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
