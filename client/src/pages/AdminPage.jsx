import { useState, useEffect } from 'react';
import { apiGallery } from '../hooks/usePhotobooth.js';
import styles from './AdminPage.module.css';

const API = (path) => `/api/admin${path}`;

export default function AdminPage({ onExit }) {
  const [pin, setPin] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [pinError, setPinError] = useState('');
  const [tab, setTab] = useState('settings');
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Gallery state
  const [photos, setPhotos] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPrint, setConfirmPrint] = useState(false);

  useEffect(() => {
    if (!unlocked) return;
    fetch(API('/config'))
      .then((r) => r.json())
      .then(setConfig)
      .catch((err) => {
        console.error('Failed to load config:', err);
        setError('Failed to load config');
      });
  }, [unlocked]);

  useEffect(() => {
    if (!unlocked || tab !== 'gallery') return;
    setGalleryLoading(true);
    setGalleryError('');
    apiGallery()
      .then((data) => setPhotos(data.photos))
      .catch((err) => {
        console.error('Failed to load gallery:', err);
        setGalleryError('Failed to load gallery');
      })
      .finally(() => setGalleryLoading(false));
  }, [unlocked, tab]);

  function handleUnlock(e) {
    e.preventDefault();
    fetch(API('/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, updates: {} }),
    }).then((r) => {
      if (r.status === 401) {
        setPinError('Incorrect PIN');
      } else {
        setUnlocked(true);
      }
    }).catch((err) => {
      console.error('PIN check failed:', err);
      setPinError('Server error');
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await fetch(API('/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, updates: config }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error('Save failed:', e);
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function set(path, value) {
    setConfig((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return next;
    });
  }

  if (!unlocked) {
    return (
      <div className={styles.page}>
        <div className={styles.pinWrap}>
          <h1 className={styles.title}>Admin</h1>
          <form onSubmit={handleUnlock} className={styles.pinForm}>
            <input
              type="password"
              inputMode="numeric"
              placeholder="PIN"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setPinError(''); }}
              className={styles.pinInput}
              maxLength={8}
              autoFocus
            />
            {pinError && <p className={styles.errorMsg}>{pinError}</p>}
            <button type="submit" className={styles.btnPrimary}>Unlock</button>
          </form>
          <button className={styles.btnSecondary} onClick={onExit}>← Back</button>
        </div>
      </div>
    );
  }

  if (!config) {
    return <div className={styles.loading}>Loading…</div>;
  }

  // Fullscreen photo view
  if (selectedPhoto) {
    const isCollage = selectedPhoto.filename.startsWith('collage_');

    async function handleDelete() {
      try {
        const res = await fetch(`/api/admin/photos/${encodeURIComponent(selectedPhoto.filename)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        setPhotos((prev) => prev.filter((p) => p.filename !== selectedPhoto.filename));
        setSelectedPhoto(null);
        setConfirmDelete(false);
      } catch (e) {
        console.error('Delete failed:', e);
        alert('Delete failed: ' + e.message);
      }
    }

    async function handlePrint(withTemplate) {
      setConfirmPrint(false);
      try {
        await fetch('/api/print', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: selectedPhoto.filename, type: isCollage ? 'collage' : 'single', withTemplate }),
        });
      } catch (e) {
        console.error('Print failed:', e);
        alert('Print failed: ' + e.message);
      }
    }

    return (
      <div className={styles.fullscreen}>
        <img src={selectedPhoto.url} alt="Photo" className={styles.fullImg} />
        <button className={styles.closeBtn} onClick={() => { setSelectedPhoto(null); setConfirmDelete(false); setConfirmPrint(false); }}>X</button>
        {confirmDelete ? (
          <div className={styles.deleteConfirm}>
            <span>Delete this photo?</span>
            <button className={styles.deleteBtnConfirm} onClick={handleDelete}>Yes, delete</button>
            <button className={styles.deleteBtnCancel} onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : confirmPrint ? (
          <div className={styles.deleteConfirm}>
            <span>Print with template overlay?</span>
            <button className={styles.deleteBtnConfirm} onClick={() => handlePrint(true)}>With template</button>
            <button className={styles.deleteBtnCancel} onClick={() => handlePrint(false)}>Without template</button>
            <button className={styles.deleteBtnCancel} onClick={() => setConfirmPrint(false)}>Cancel</button>
          </div>
        ) : (
          <div className={styles.photoActions}>
            <a className={styles.photoActionBtn} href={selectedPhoto.url} download={selectedPhoto.filename}>Download</a>
            <button className={styles.photoActionBtn} onClick={() => setConfirmPrint(true)}>Print</button>
            <button className={`${styles.photoActionBtn} ${styles.photoActionDanger}`} onClick={() => setConfirmDelete(true)}>Delete</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Admin</h1>
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${tab === 'settings' ? styles.tabActive : ''}`}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
          <button
            className={`${styles.tab} ${tab === 'gallery' ? styles.tabActive : ''}`}
            onClick={() => setTab('gallery')}
          >
            Gallery
          </button>
        </div>
        <button className={styles.btnSecondary} onClick={onExit}>← Exit</button>
      </div>

      {tab === 'settings' && (
        <>
          <div className={styles.sections}>

            {/* Wedding Details */}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Wedding Details</h2>
              <Field label="Couple's Names" value={config.wedding.title}
                onChange={(v) => set('wedding.title', v)} />
              <Field label="Date / Subtitle" value={config.wedding.subtitle}
                onChange={(v) => set('wedding.subtitle', v)} />
            </section>

            {/* Colors */}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Colors</h2>
              <ColorField label="Accent Color" value={config.wedding.primaryColor}
                onChange={(v) => set('wedding.primaryColor', v)} />
              <ColorField label="Text" value={config.wedding.textColor}
                onChange={(v) => set('wedding.textColor', v)} />
            </section>

            {/* Print Settings */}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Print Settings</h2>
              <Toggle label="Printing Enabled" value={config.print.enabled}
                onChange={(v) => set('print.enabled', v)} />
              <Field label="Printer Name (CUPS)" value={config.print.printer}
                onChange={(v) => set('print.printer', v)} />
              <NumberField label="Single Photo Copies" value={config.print.singlePrintCopies}
                onChange={(v) => set('print.singlePrintCopies', v)} min={1} max={5} />
              <NumberField label="Photo Strip Copies" value={config.print.collagePrintCopies}
                onChange={(v) => set('print.collagePrintCopies', v)} min={1} max={5} />
              <ColorField label="Background / Border Color" value={config.print?.backgroundColor ?? '#1a1a1a'}
                onChange={(v) => set('print.backgroundColor', v)} />
              <NumberField label="Border Size (px)" value={config.print?.borderSize ?? 20}
                onChange={(v) => set('print.borderSize', v)} min={0} max={100} />
            </section>

            {/* Features */}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Features</h2>
              <Toggle label="Single Photos" value={config.picture?.enabled ?? true}
                onChange={(v) => set('picture.enabled', v)} />
              <Toggle label="Photo Strips (Collage)" value={config.collage?.enabled ?? true}
                onChange={(v) => set('collage.enabled', v)} />
              <Toggle label="Simulate Camera (no real camera)" value={config.camera.simulateCapture}
                onChange={(v) => set('camera.simulateCapture', v)} />
            </section>

            {/* Countdown */}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Countdown</h2>
              <NumberField label="Single Photo Countdown (sec)" value={config.single.countdownSeconds}
                onChange={(v) => set('single.countdownSeconds', v)} min={1} max={10} />
              <NumberField label="Strip Countdown (sec)" value={config.collage.countdownSeconds}
                onChange={(v) => set('collage.countdownSeconds', v)} min={1} max={10} />
              <NumberField label="Strip Shot Preview (sec)" value={config.collage.shotPreviewSeconds}
                onChange={(v) => set('collage.shotPreviewSeconds', v)} min={1} max={10} />
              <NumberField label="Photos Per Strip" value={config.collage.shots ?? 3}
                onChange={(v) => set('collage.shots', v)} min={2} max={6} />
            </section>

            {/* Template */}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Photo Template</h2>
              <Toggle label="Enabled" value={config.template?.enabled ?? false}
                onChange={(v) => set('template.enabled', v)} />
              <Field label="Text" value={config.template?.text ?? ''}
                onChange={(v) => set('template.text', v)} />
              <NumberField label="Font Size (px at 600px width)" value={config.template?.fontSize ?? 48}
                onChange={(v) => set('template.fontSize', v)} min={20} max={120} />
              <ColorField label="Font Color" value={config.template?.fontColor ?? '#ffffff'}
                onChange={(v) => set('template.fontColor', v)} />
              <ColorField label="Banner Color" value={config.template?.overlayColor ?? '#000000'}
                onChange={(v) => set('template.overlayColor', v)} />
              <NumberField label="Banner Height (px at 600px width)" value={config.template?.bannerHeight ?? 100}
                onChange={(v) => set('template.bannerHeight', v)} min={40} max={400} />
            </section>

            {/* Booth */}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Booth</h2>
              <NumberField label="Auto-return After (sec, 0 = off)" value={config.booth?.autoReturnSeconds ?? 10}
                onChange={(v) => set('booth.autoReturnSeconds', v)} min={0} max={60} />
            </section>

            {/* Admin PIN */}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Admin PIN</h2>
              <Field label="PIN" value={config.admin.pin} inputMode="numeric"
                onChange={(v) => set('admin.pin', v)} />
            </section>

          </div>

          <div className={styles.saveBar}>
            {error && <p className={styles.errorMsg}>{error}</p>}
            {saved && <p className={styles.successMsg}>✓ Saved</p>}
            <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </>
      )}

      {tab === 'gallery' && (
        <div className={styles.galleryWrap}>
          {galleryLoading ? (
            <div className={styles.galleryEmpty}>Loading…</div>
          ) : galleryError ? (
            <div className={styles.galleryEmpty}>{galleryError}</div>
          ) : photos.length === 0 ? (
            <div className={styles.galleryEmpty}>No photos yet</div>
          ) : (
            <div className={styles.galleryGrid}>
              {photos.map((photo) => (
                <div key={photo.filename} className={styles.galleryThumb} onClick={() => setSelectedPhoto(photo)}>
                  <img src={photo.url} alt={photo.filename} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, inputMode }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        className={styles.input}
        value={value ?? ''}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.colorRow}>
        <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)}
          className={styles.colorPicker} />
        <input className={styles.input} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      </div>
    </label>
  );
}

function NumberField({ label, value, onChange, min, max, step = 1 }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        type="number"
        className={styles.input}
        value={value ?? 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Toggle({ label, value, onChange }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <button
        className={`${styles.toggle} ${value ? styles.toggleOn : ''}`}
        onClick={() => onChange(!value)}
      >
        {value ? 'On' : 'Off'}
      </button>
    </div>
  );
}
