# gphoto2 Latency Optimization

## The Problem

Currently, every time a photo is captured the server spawns a new `gphoto2` process via `exec`:

```js
await execAsync(`gphoto2 --capture-image-and-download --filename "${filepath}" --force-overwrite`);
```

Each call goes through the full startup sequence:

```
fork process
→ load gphoto2 binary
→ initialize libgphoto2
→ detect USB bus
→ negotiate PTP session with camera
→ capture image
→ download to disk
→ exit
```

This startup overhead costs **1–3 seconds per shot**, regardless of how fast the camera itself captures. For a 3-shot photo strip, that's potentially **3–9 seconds of dead time** added to the experience.

---

## The Solution — `node-gphoto2`

[node-gphoto2](https://github.com/lwille/node-gphoto2) is a Node.js binding to `libgphoto2` that keeps the camera connection **alive in memory** across captures. The expensive initialization happens once at server startup, not on every shot.

### Install

```bash
# On the Pi, install the native dependency first
sudo apt install libgphoto2-dev

# Then install the Node binding
cd pi-booth/server
npm install node-gphoto2
```

### Implementation

Replace the current `capturePhoto` function in `server/index.js`:

```js
import GPhoto2 from 'node-gphoto2';

// Initialize once at startup
let camera = null;

async function initCamera() {
  const gp = new GPhoto2();
  const cameras = await new Promise((resolve, reject) => {
    gp.list((list) => list.length ? resolve(list) : reject(new Error('No camera found')));
  });
  camera = cameras[0];
  console.log('Camera ready:', camera.model);
}

// Call this at server startup (before app.listen)
if (!config.camera.simulateCapture) {
  initCamera().catch((err) => console.error('Camera init failed:', err));
}

// Updated capture function
async function capturePhoto(filename) {
  const filepath = path.join(PHOTOS_DIR, filename);

  if (config.camera.simulateCapture) {
    const r = Math.floor(Math.random() * 120) + 60;
    const g = Math.floor(Math.random() * 120) + 60;
    const b = Math.floor(Math.random() * 120) + 60;
    await sharp({
      create: { width: 1800, height: 1200, channels: 3, background: { r, g, b } },
    }).jpeg().toFile(filepath);
    return filepath;
  }

  if (!camera) throw new Error('Camera not initialized');

  await new Promise((resolve, reject) => {
    camera.takePicture({ download: true, targetPath: filepath }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return filepath;
}
```

---

## Performance Comparison

| Method | Per-shot overhead | 3-shot strip total |
|--------|------------------|--------------------|
| `exec gphoto2` | ~1–3s startup + capture | ~5–11s |
| `node-gphoto2` | ~0.1s + capture | ~2–3s |

---

## When to Implement

Implement this **after** verifying the basic `gphoto2` CLI capture works with the D3300 on the Pi. No point debugging the native binding before confirming the camera is detected.

**Verification checklist before switching:**
- [ ] `gphoto2 --auto-detect` shows `Nikon DSC D3300`
- [ ] `gphoto2 --capture-image-and-download` successfully captures a photo
- [ ] Single photo flow works end-to-end in the app using CLI method
- [ ] Then switch to `node-gphoto2` for lower latency

---

## Camera Disconnection Handling

With a persistent camera connection, you'll need to handle reconnection if the USB connection drops:

```js
async function capturePhoto(filename) {
  try {
    return await doCapturePhoto(filename);
  } catch (err) {
    if (err.message.includes('Could not claim')) {
      console.warn('Camera disconnected, reinitializing...');
      await initCamera();
      return await doCapturePhoto(filename);
    }
    throw err;
  }
}
```
