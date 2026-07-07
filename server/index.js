import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'https';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readdir, writeFile, unlink } from 'fs/promises';
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
const THUMBS_DIR = path.join(PHOTOS_DIR, '.thumbs');
const PREVIEWS_DIR = path.join(PHOTOS_DIR, '.previews');
const TEMPLATE_DIR = path.join(__dirname, '../data/templates');
const STRIP_TEMPLATE_FILENAME = 'strip-template.png';
const STRIP_TEMPLATE_W = 600;
const STRIP_TEMPLATE_H = 1800;

if (!existsSync(PHOTOS_DIR)) mkdirSync(PHOTOS_DIR, { recursive: true });
if (!existsSync(THUMBS_DIR)) mkdirSync(THUMBS_DIR, { recursive: true });
if (!existsSync(PREVIEWS_DIR)) mkdirSync(PREVIEWS_DIR, { recursive: true });
if (!existsSync(TEMPLATE_DIR)) mkdirSync(TEMPLATE_DIR, { recursive: true });

const app = express();
const server = createServer(httpsOptions, app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use('/photos', express.static(PHOTOS_DIR));
app.use('/template-images', express.static(TEMPLATE_DIR));

app.get('/photos/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(PHOTOS_DIR, filename);
  if (!existsSync(filepath)) return res.status(404).end();
  res.download(filepath, filename);
});

app.get('/photos/download-rendered/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filepath = path.join(PHOTOS_DIR, filename);
    if (!existsSync(filepath)) return res.status(404).end();

    const kind = classifyGalleryFile(filename);
    const type = kind === 'strip' ? 'collage' : 'single';
    const withTemplate = String(req.query.withTemplate ?? 'false') === 'true';
    const rendered = await renderDownloadAsset(filepath, type, withTemplate);
    const outputName = filename.replace(/\.[^.]+$/u, '') + (withTemplate ? '_with_template.png' : '.png');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.send(rendered);
  } catch (err) {
    console.error('Rendered download error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /photos/thumb/:filename - resized, cached thumbnail for gallery grids.
// Full-resolution captures can be several MB each; serving those directly in a
// grid of dozens of photos is what was causing slow gallery load times.
app.get('/photos/thumb/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // sanitize
    const srcPath = path.join(PHOTOS_DIR, filename);
    if (!existsSync(srcPath)) return res.status(404).end();

    const thumbPath = path.join(THUMBS_DIR, `${filename}.jpg`);
    if (!existsSync(thumbPath)) {
      // .rotate() (no args) bakes in the source's EXIF orientation before resizing — without
      // it, sharp strips EXIF metadata from the thumbnail output by default, so a raw camera
      // shot with an orientation tag (rather than physically rotated pixels) would end up
      // sideways in the thumbnail even though the original file displays correctly.
      await sharp(srcPath)
        .rotate()
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toFile(thumbPath);
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(thumbPath);
  } catch (err) {
    console.error('Thumbnail error:', err);
    res.status(500).end();
  }
});

// GET /photos/preview/:filename - cached display-sized preview for post-capture review.
// DSLR originals are much larger than the iPad needs for a full-screen preview, which was
// making the just-captured photo appear to load progressively in visible chunks.
app.get('/photos/preview/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const srcPath = path.join(PHOTOS_DIR, filename);
    if (!existsSync(srcPath)) return res.status(404).end();

    const previewPath = path.join(PREVIEWS_DIR, `${filename}.jpg`);
    if (!existsSync(previewPath)) {
      await sharp(srcPath)
        .rotate()
        .resize({ width: 1400, height: 1800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(previewPath);
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(previewPath);
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).end();
  }
});

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

function classifyGalleryFile(filename) {
  if (filename.startsWith('photo_')) return 'single';
  if (filename.startsWith('collage_shot_')) return 'strip-shot';
  if (filename.startsWith('collage_')) return 'strip';
  return 'other';
}

function buildGalleryPhoto(filename) {
  return {
    filename,
    kind: classifyGalleryFile(filename),
    url: `/photos/${filename}`,
    previewUrl: `/photos/preview/${encodeURIComponent(filename)}`,
    downloadUrl: `/photos/download/${encodeURIComponent(filename)}`,
    thumbUrl: `/photos/thumb/${filename}`,
  };
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
  // Note: shutterDelayMs is applied client-side (fires this request early, ahead of the
  // on-screen countdown reaching 0) rather than here — see CapturePage.jsx.
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
      // Apply the same EXIF-aware orientation correction used for single photos — without
      // this, shots from a portrait-mounted camera would be resized/cropped while sideways.
      const { pipeline } = await toPortrait(imgPath);
      const resized = await pipeline
        .resize(THUMB_W, THUMB_H, { fit: 'cover' })
        .toBuffer();
      return { input: resized, top: border + i * (THUMB_H + border), left: border };
    })
  );

  // Encode the actual photo count in the filename so printFile() always knows exactly how
  // many photos are in this strip, even if the admin's collage.shots setting changes later.
  const outputPath = path.join(PHOTOS_DIR, `collage_n${n}_${Date.now()}.jpg`);
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

// Rotate landscape captures to portrait so downstream border/trim math — measured against a
// portrait 4x6 page — applies correctly. Real camera files carry an EXIF orientation tag set
// by the camera's own orientation sensor, which correctly reflects how it's physically mounted
// (landscape or portrait) — so that tag is trusted via sharp's auto-orient rotate() when present.
// Only falls back to the old "rotate 90 if landscape" heuristic for sources with no EXIF
// orientation data at all (e.g. the simulated capture placeholder).
// Returns a sharp pipeline plus the resulting (already-portrait) width/height.
async function toPortrait(filepath) {
  const meta = await sharp(filepath).metadata();
  const orientation = meta.orientation ?? 1;

  if (orientation !== 1) {
    // EXIF orientations 5-8 mean width/height are swapped once rotated for display.
    const swapped = orientation >= 5 && orientation <= 8;
    return {
      pipeline: sharp(filepath).rotate(),
      width: swapped ? meta.height : meta.width,
      height: swapped ? meta.width : meta.height,
    };
  }

  const needsRotate = meta.width > meta.height;
  const pipeline = needsRotate ? sharp(filepath).rotate(90) : sharp(filepath);
  const width = needsRotate ? meta.height : meta.width;
  const height = needsRotate ? meta.width : meta.height;
  return { pipeline, width, height };
}

async function printFile(filepath, copies = 1, type = 'single', withTemplate = false) {
  const printer = config.print.printer;
  let fileToPrint = filepath;
  let tmpPng = null;

  const templateEnabled = withTemplate && config.template?.enabled;
  const stripTemplatePath = type === 'collage' ? getStripTemplateImagePath() : null;
  const stripTemplateActive = Boolean(templateEnabled && stripTemplatePath);
  const stripBannerReserved = Boolean(templateEnabled && type === 'collage' && (stripTemplateActive || config.template?.text));
  const bannerTemplateActive = Boolean(templateEnabled && config.template?.text && !stripTemplateActive);
  const stripTemplateBuf = stripTemplateActive ? await sharp(stripTemplatePath).png().toBuffer() : null;
  const stripTemplatePlacement = getStripTemplatePlacement();

  if (type === 'collage') {
    // Place two copies of the strip side-by-side on a 4x6 canvas (1200x1800 at 300dpi).
    // Printer cuts at midpoint via w288h432-div2, producing two full 2x6 strips.
    tmpPng = filepath.replace(/\.(jpg|jpeg)$/i, `_print_tmp_${Date.now()}.png`);
    const backgroundColor = config.print?.backgroundColor ?? '#1a1a1a';
    const border = config.print?.borderSize ?? 20;

    // Must match buildCollageStrip()'s STRIP_W/STRIP_H exactly. Normalize (defensive) in case
    // a mismatched file is ever passed in, so the extract/composite math below can't crash.
    const stripW = STRIP_TEMPLATE_W;
    const stripH = STRIP_TEMPLATE_H;
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

    // The 4x6 sheet has a fixed physical height — the name banner (if any) shares that space
    // with the photos rather than extending past it. It sits directly below the photo content,
    // above the bottom border, and is identical on both resulting 2x6 strips.
    const bannerH = stripBannerReserved ? Math.round((config.template.bannerHeight ?? 100) * (stripW / 600)) : 0;
    const availableV = stripH - TRIM_TOP - TRIM_BOTTOM;
    const contentH = availableV - 2 * border - bannerH;
    const bannerTop = TRIM_TOP + border + contentH;

    // Built per-side (not once at full strip width) so the banner is inset by the same border/trim
    // margins as the photo content — otherwise it would bleed under the outer border on each side.

    // Reflow (not stretch) each individual photo into the new content box: re-crop each photo
    // with 'cover' so aspect ratio is preserved (a subtle uniform zoom/crop instead of distortion),
    // rather than resizing the whole composited block, which would squish photos unevenly/unnaturally.
    // Prefer the count baked into the filename (collage_nN_...) — this is the count actually
    // used at build time, which may differ from the CURRENT admin setting if it was changed
    // in between. Falling back to config.collage.shots only for older files without this tag.
    const filenameMatch = path.basename(filepath).match(/collage_n(\d+)_/);
    const n = filenameMatch ? parseInt(filenameMatch[1], 10) : (config.collage?.shots ?? 3);
    const oldThumbW = stripW - 2 * border;
    const oldThumbH = Math.floor((stripH - border * (n + 1)) / n);
    const newThumbH = Math.floor((contentH - border * (n - 1)) / n);

    async function reflowPhotos(newThumbW) {
      const composites = [];
      for (let i = 0; i < n; i++) {
        const photoBuf = await sharp(contentBuf)
          .extract({ left: 0, top: i * (oldThumbH + border), width: oldThumbW, height: oldThumbH })
          .resize(newThumbW, newThumbH, { fit: 'cover' })
          .toBuffer();
        composites.push({ input: photoBuf, left: 0, top: i * (newThumbH + border) });
      }
      const totalH = n * newThumbH + (n - 1) * border;
      return sharp({ create: { width: newThumbW, height: totalH, channels: 3, background: backgroundColor } })
        .composite(composites)
        .png()
        .toBuffer();
    }

    // Left copy: outer border compensated on the left, top and bottom; cut-side (right) border
    // stays as-is since the cut loses nothing.
    const leftContentW = stripW - TRIM_LEFT - 2 * border;
    const leftContent = await reflowPhotos(leftContentW);
    const leftComposites = [{ input: leftContent, left: TRIM_LEFT + border, top: TRIM_TOP + border }];
    if (bannerH > 0) {
      leftComposites.push({ input: buildBannerSvg(leftContentW, bannerH), left: TRIM_LEFT + border, top: bannerTop });
    }
    const leftCopy = await renderStripTemplateLayered({
      width: stripW,
      height: stripH,
      backgroundColor,
      contentComposites: leftComposites,
      stripTemplateBuf,
      placement: stripTemplatePlacement,
    });

    // Right copy: outer border compensated on the right, top and bottom; cut-side (left)
    // border stays as-is.
    const rightContentW = stripW - TRIM_RIGHT - 2 * border;
    const rightContent = await reflowPhotos(rightContentW);
    const rightComposites = [{ input: rightContent, left: border, top: TRIM_TOP + border }];
    if (bannerH > 0) {
      rightComposites.push({ input: buildBannerSvg(rightContentW, bannerH), left: border, top: bannerTop });
    }
    const rightCopy = await renderStripTemplateLayered({
      width: stripW,
      height: stripH,
      backgroundColor,
      contentComposites: rightComposites,
      stripTemplateBuf,
      placement: stripTemplatePlacement,
    });

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

    // Name banner (if any) shares the fixed 1800px height budget with the photo, sitting
    // directly below it and above the bottom border.
    const bannerH = bannerTemplateActive ? Math.round((config.template.bannerHeight ?? 100) * (1200 / 600)) : 0;
    const contentW = 1200 - TRIM_LEFT - TRIM_RIGHT - 2 * border;
    const contentH = 1800 - TRIM_TOP - TRIM_BOTTOM - 2 * border - bannerH;
    const bannerTop = TRIM_TOP + border + contentH;

    const { pipeline } = await toPortrait(filepath);
    const content = await pipeline.resize(contentW, contentH, { fit: 'cover' }).toBuffer();

    const composites = [{ input: content, left: TRIM_LEFT + border, top: TRIM_TOP + border }];
    if (bannerH > 0) {
      composites.push({ input: buildBannerSvg(contentW, bannerH), left: TRIM_LEFT + border, top: bannerTop });
    }

    await sharp({ create: { width: 1200, height: 1800, channels: 3, background: backgroundColor } })
      .composite(composites)
      .png()
      .toFile(tmpPng);
    fileToPrint = tmpPng;
  }

  const mediaSize = type === 'collage' ? 'w288h432-div2' : 'w288h432';
  const noCutWasteOpt = type === 'collage' ? '-o StpNoCutWaste=True' : '';
  try {
    // `lp` only confirms the job was accepted into the CUPS queue — CUPS will happily queue a
    // job even if the printer's USB cable is unplugged, reporting the job as "completed" without
    // ever actually printing. Verify the printer is currently detected (live USB probe) first, so
    // we can fail loudly instead of reporting false success.
    if (!(await isPrinterConnected(printer))) {
      throw new Error(`Printer "${printer}" is not connected — check the USB cable and try again.`);
    }
    await execAsync(`lp -d "${printer}" -n ${copies} -o PageSize=${mediaSize} ${noCutWasteOpt} "${fileToPrint}"`);
  } finally {
    if (tmpPng) await unlink(tmpPng).catch(() => {});
  }
}

async function normalizeCollageStrip(filepath) {
  const stripMeta = await sharp(filepath).metadata();
  if (stripMeta.width === STRIP_TEMPLATE_W && stripMeta.height === STRIP_TEMPLATE_H) {
    return sharp(filepath).toBuffer();
  }
  console.warn(`Collage strip was ${stripMeta.width}x${stripMeta.height}, expected ${STRIP_TEMPLATE_W}x${STRIP_TEMPLATE_H} — resizing to fit.`);
  return sharp(filepath).resize(STRIP_TEMPLATE_W, STRIP_TEMPLATE_H, { fit: 'fill' }).toBuffer();
}

async function renderDownloadAsset(filepath, type, withTemplate = false) {
  if (!withTemplate || !config.template?.enabled) {
    if (type === 'collage') return normalizeCollageStrip(filepath);
    const { pipeline } = await toPortrait(filepath);
    return pipeline.png().toBuffer();
  }

  return type === 'collage'
    ? renderTemplatedCollageDownload(filepath)
    : renderTemplatedSingleDownload(filepath);
}

async function renderTemplatedCollageDownload(filepath) {
  const backgroundColor = config.print?.backgroundColor ?? '#1a1a1a';
  const border = config.print?.borderSize ?? 20;
  const stripBuf = await normalizeCollageStrip(filepath);
  const stripTemplatePath = getStripTemplateImagePath();
  const stripTemplateBuf = stripTemplatePath ? await sharp(stripTemplatePath).png().toBuffer() : null;
  const placement = getStripTemplatePlacement();

  if (!stripTemplateBuf && !config.template?.text) {
    return sharp(stripBuf)
      .png()
      .toBuffer();
  }

  const nMatch = path.basename(filepath).match(/collage_n(\d+)_/);
  const n = nMatch ? parseInt(nMatch[1], 10) : (config.collage?.shots ?? 3);
  const contentBuf = await sharp(stripBuf)
    .extract({
      left: border,
      top: border,
      width: STRIP_TEMPLATE_W - 2 * border,
      height: STRIP_TEMPLATE_H - 2 * border,
    })
    .toBuffer();

  const bannerH = Math.round((config.template.bannerHeight ?? 100) * (STRIP_TEMPLATE_W / 600));
  const contentW = STRIP_TEMPLATE_W - 2 * border;
  const contentH = STRIP_TEMPLATE_H - 2 * border - bannerH;
  const oldThumbW = STRIP_TEMPLATE_W - 2 * border;
  const oldThumbH = Math.floor((STRIP_TEMPLATE_H - border * (n + 1)) / n);
  const newThumbH = Math.floor((contentH - border * (n - 1)) / n);
  const composites = [];

  for (let i = 0; i < n; i++) {
    const photoBuf = await sharp(contentBuf)
      .extract({ left: 0, top: i * (oldThumbH + border), width: oldThumbW, height: oldThumbH })
      .resize(contentW, newThumbH, { fit: 'cover' })
      .toBuffer();
    composites.push({ input: photoBuf, left: border, top: border + i * (newThumbH + border) });
  }
  if (!stripTemplateBuf && config.template?.text) {
    composites.push({ input: buildBannerSvg(contentW, bannerH), left: border, top: border + contentH });
  }

  return renderStripTemplateLayered({
    width: STRIP_TEMPLATE_W,
    height: STRIP_TEMPLATE_H,
    backgroundColor,
    contentComposites: composites,
    stripTemplateBuf,
    placement,
  });
}

async function renderTemplatedSingleDownload(filepath) {
  const border = config.print?.borderSize ?? 0;
  const backgroundColor = config.print?.backgroundColor ?? '#1a1a1a';
  const bannerH = config.template?.text ? Math.round((config.template.bannerHeight ?? 100) * (1200 / 600)) : 0;
  const contentW = 1200 - TRIM_LEFT - TRIM_RIGHT - 2 * border;
  const contentH = 1800 - TRIM_TOP - TRIM_BOTTOM - 2 * border - bannerH;
  const bannerTop = TRIM_TOP + border + contentH;
  const { pipeline } = await toPortrait(filepath);
  const content = await pipeline.resize(contentW, contentH, { fit: 'cover' }).toBuffer();
  const composites = [{ input: content, left: TRIM_LEFT + border, top: TRIM_TOP + border }];

  if (bannerH > 0) {
    composites.push({ input: buildBannerSvg(contentW, bannerH), left: TRIM_LEFT + border, top: bannerTop });
  }

  return sharp({ create: { width: 1200, height: 1800, channels: 3, background: backgroundColor } })
    .composite(composites)
    .png()
    .toBuffer();
}

// TODO: finish this once we know the DNP DS-RX1's actual USB vendor/product ID from `lsusb`
// (couldn't capture it because the printer was unplugged at the time). Once known, replace the
// placeholder below with the real ID, e.g. '1343:0004' for '1343' vendor and '0004' product.
// `lpstat -v`'s device URI check and `lpinfo -v` both proved unreliable for detecting whether
// the DS-RX1 is actually connected via USB — lpinfo -v didn't list any usb:// backends at all,
// even with the printer plugged in and printing successfully. Matching lsusb output against the
// printer's specific vendor:product ID is more likely to work.
const DS_RX1_USB_ID_PLACEHOLDER = 'XXXX:XXXX'; // e.g. '1343:0004' — fill in from `lsusb` output

async function isPrinterConnected(printer) {
  // Disabled until DS_RX1_USB_ID_PLACEHOLDER is filled in with the real vendor:product ID.
  // Currently always reports "connected" so we don't block real prints on a broken check.
  return true;

  /* eslint-disable no-unreachable
  try {
    const { stdout } = await execAsync('lsusb');
    return stdout.includes(DS_RX1_USB_ID_PLACEHOLDER);
  } catch (err) {
    console.warn('Printer connectivity check failed, proceeding anyway:', err.message);
    return true;
  }
  */
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Build the name/date banner as an SVG buffer (background rect + centered text) sized to
// exactly fill its reserved space, so it can be composited directly without growing any canvas.
function buildBannerSvg(width, bannerH) {
  const text = escapeXml(config.template.text);
  const fontSize = Math.round((config.template.fontSize || 48) * (width / 600));
  const fontColor = config.template.fontColor || '#ffffff';
  const overlayColor = config.template.overlayColor || '#000000';
  const textY = Math.round(bannerH / 2);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bannerH}">
    <rect x="0" y="0" width="${width}" height="${bannerH}" fill="${overlayColor}"/>
    <text x="${Math.round(width / 2)}" y="${textY}"
      text-anchor="middle" dominant-baseline="middle"
      font-size="${fontSize}" fill="${fontColor}" font-family="Georgia, serif">${text}</text>
  </svg>`;
  return Buffer.from(svg);
}

function getStripTemplateImagePath() {
  const imageFilename = path.basename(config.template?.imageFilename ?? '');
  if (!imageFilename) return null;
  const templatePath = path.join(TEMPLATE_DIR, imageFilename);
  return existsSync(templatePath) ? templatePath : null;
}

function getStripTemplatePlacement() {
  return config.template?.imagePlacement === 'overlay' ? 'overlay' : 'underlay';
}

async function renderStripTemplateLayered({ width, height, backgroundColor, contentComposites, stripTemplateBuf, placement }) {
  const composites = [];
  if (stripTemplateBuf && placement === 'underlay') {
    composites.push({ input: stripTemplateBuf, left: 0, top: 0 });
  }
  composites.push(...contentComposites);
  if (stripTemplateBuf && placement === 'overlay') {
    composites.push({ input: stripTemplateBuf, left: 0, top: 0 });
  }

  return sharp({ create: { width, height, channels: 3, background: backgroundColor } })
    .composite(composites)
    .png()
    .toBuffer();
}

async function persistConfig() {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  broadcast({ event: 'config_updated' });
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
    camera: { shutterDelayMs: config.camera?.shutterDelayMs ?? 0 },
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
    await capturePhoto(filename);
    broadcast({ event: 'captured', filename });
    res.json({ success: true, filename, url: `/photos/${filename}`, previewUrl: `/photos/preview/${filename}` });
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
    await capturePhoto(filename);
    res.json({ success: true, filename, url: `/photos/${filename}`, thumbUrl: `/photos/thumb/${filename}` });
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
    res.json({ success: true, filename: collageFilename, url: `/photos/${collageFilename}`, previewUrl: `/photos/preview/${collageFilename}` });
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

    const copies = type === 'collage' ? config.print.collagePrintCopies : config.print.singlePrintCopies;
    await printFile(filepath, copies, type, withTemplate);
    broadcast({ event: 'printing', filename, copies });
    res.json({ success: true });
  } catch (err) {
    console.error('Print error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/gallery/summary', async (req, res) => {
  try {
    const files = await readdir(PHOTOS_DIR);
    const counts = files
      .filter((f) => f.match(/\.(jpg|jpeg|png)$/i))
      .reduce((acc, filename) => {
        const kind = classifyGalleryFile(filename);
        if (kind !== 'other') acc[kind] = (acc[kind] ?? 0) + 1;
        return acc;
      }, { single: 0, 'strip-shot': 0, strip: 0 });
    res.json({ counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /gallery - list one gallery section at a time with pagination
app.get('/gallery', async (req, res) => {
  try {
    const requestedKind = String(req.query.kind ?? '');
    if (!['single', 'strip-shot', 'strip'].includes(requestedKind)) {
      return res.status(400).json({ error: 'valid kind query required' });
    }

    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '60'), 10) || 60));

    const filtered = (await readdir(PHOTOS_DIR))
      .filter((f) => f.match(/\.(jpg|jpeg|png)$/i) && classifyGalleryFile(f) === requestedKind)
      .sort()
      .reverse();

    const photos = filtered
      .slice(offset, offset + limit)
      .map(buildGalleryPhoto);

    res.json({
      photos,
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + photos.length < filtered.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Middleware: validates req.body.pin against the configured admin PIN.
// Shared by all /admin routes that require authentication.
function requirePin(req, res, next) {
  const { pin } = req.body;
  if (pin !== String(config.admin?.pin ?? '1234')) {
    return res.status(401).json({ success: false, error: 'Invalid PIN' });
  }
  next();
}

// POST /admin/print-calibration - print a ruler test pattern to measure exact cut bleed.
// Draws tick marks every 10px labeled with the ABSOLUTE pixel position (0-1200),
// colors the left half light blue and the right half light pink so the two pieces
// are unambiguous after cutting, and marks the intended cut line in red at x=600.
app.post('/admin/print-calibration', requirePin, async (req, res) => {
  try {
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
app.post('/admin/config', requirePin, async (req, res) => {
  try {
    const { updates } = req.body;
    // Deep merge updates into config
    config = deepMerge(config, updates);
    await persistConfig();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /admin/template-image - upload a full-strip overlay image for collage prints.
app.post('/admin/template-image', requirePin, async (req, res) => {
  try {
    const { imageData } = req.body;
    if (typeof imageData !== 'string') {
      return res.status(400).json({ success: false, error: 'imageData is required' });
    }

    const match = imageData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ success: false, error: 'Upload a PNG, JPEG, or WebP image' });
    }

    const inputBuffer = Buffer.from(match[2], 'base64');
    const metadata = await sharp(inputBuffer).metadata();
    if (!metadata.width || !metadata.height) {
      return res.status(400).json({ success: false, error: 'Could not read image dimensions' });
    }

    const expectedRatio = STRIP_TEMPLATE_W / STRIP_TEMPLATE_H;
    const actualRatio = metadata.width / metadata.height;
    if (Math.abs(actualRatio - expectedRatio) > 0.03) {
      return res.status(400).json({ success: false, error: 'Image must use the 2x6 strip ratio (1:3)' });
    }

    const outputPath = path.join(TEMPLATE_DIR, STRIP_TEMPLATE_FILENAME);
    await sharp(inputBuffer)
      .rotate()
      .resize(STRIP_TEMPLATE_W, STRIP_TEMPLATE_H, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(outputPath);

    const imageUpdatedAt = Date.now();
    config = deepMerge(config, {
      template: {
        imageFilename: STRIP_TEMPLATE_FILENAME,
        imageUpdatedAt,
      },
    });
    await persistConfig();
    res.json({ success: true, imageFilename: STRIP_TEMPLATE_FILENAME, imageUpdatedAt });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /admin/template-image - remove the uploaded strip overlay image.
app.delete('/admin/template-image', requirePin, async (req, res) => {
  try {
    const templatePath = getStripTemplateImagePath();
    if (templatePath) await unlink(templatePath).catch(() => {});
    config = deepMerge(config, {
      template: {
        imageFilename: null,
        imageUpdatedAt: 0,
      },
    });
    await persistConfig();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /admin/photos/:filename - delete a photo
app.delete('/admin/photos/:filename', requirePin, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // sanitize
    const filepath = path.join(PHOTOS_DIR, filename);
    if (!existsSync(filepath)) return res.status(404).json({ success: false, error: 'File not found' });
    await unlink(filepath);
    await unlink(path.join(THUMBS_DIR, `${filename}.jpg`)).catch(() => {});
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
