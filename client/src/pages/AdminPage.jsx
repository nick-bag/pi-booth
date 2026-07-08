import { useState, useEffect, useRef, useCallback } from 'react';
import { apiGallerySection, apiGallerySummary } from '../hooks/usePhotobooth.js';
import styles from './AdminPage.module.css';

const API = (path) => `/api/admin${path}`;
const GALLERY_PAGE_SIZE = 60;
const GALLERY_SECTIONS = [
  { id: 'single', title: 'Single Shots', empty: 'No single shots yet' },
  { id: 'strip-shot', title: 'Photo Strip Shots', empty: 'No photo strip shots yet' },
  { id: 'strip', title: 'Photo Strips', empty: 'No photo strips yet' },
];

export default function AdminPage({ onExit }) {
  const [pin, setPin] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [pinError, setPinError] = useState('');
  const [tab, setTab] = useState('settings');
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState('');

  // Gallery state
  const [galleryCounts, setGalleryCounts] = useState({ single: 0, 'strip-shot': 0, strip: 0 });
  const [galleryPhotos, setGalleryPhotos] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryLoadingMore, setGalleryLoadingMore] = useState(false);
  const [galleryError, setGalleryError] = useState('');
  const [activeGallerySection, setActiveGallerySection] = useState(null);
  const [galleryHasMore, setGalleryHasMore] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPrint, setConfirmPrint] = useState(false);
  const [confirmDownload, setConfirmDownload] = useState(false);
  const loadMoreRef = useRef(null);

  const templateImageUrl = config?.template?.imageFilename
    ? `/template-images/${encodeURIComponent(config.template.imageFilename)}?v=${config.template.imageUpdatedAt ?? 0}`
    : '';

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
    apiGallerySummary()
      .then((data) => setGalleryCounts(data.counts))
      .catch((err) => {
        console.error('Failed to load gallery:', err);
        setGalleryError('Failed to load gallery');
      })
      .finally(() => setGalleryLoading(false));
  }, [unlocked, tab]);

  useEffect(() => {
    if (tab !== 'gallery') {
      setActiveGallerySection(null);
      setGalleryPhotos([]);
      setGalleryHasMore(false);
    }
  }, [tab]);

  const loadGallerySection = useCallback(async (sectionId, offset = 0) => {
    const append = offset > 0;
    if (append) setGalleryLoadingMore(true);
    else setGalleryLoading(true);
    setGalleryError('');
    try {
      const data = await apiGallerySection(sectionId, { offset, limit: GALLERY_PAGE_SIZE });
      setGalleryPhotos((prev) => (append ? [...prev, ...data.photos] : data.photos));
      setGalleryHasMore(data.hasMore);
      setGalleryCounts((prev) => ({ ...prev, [sectionId]: data.total }));
    } catch (err) {
      console.error('Failed to load gallery section:', err);
      setGalleryError('Failed to load gallery');
    } finally {
      if (append) setGalleryLoadingMore(false);
      else setGalleryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!unlocked || tab !== 'gallery' || !activeGallerySection) return;
    setGalleryPhotos([]);
    setGalleryHasMore(false);
    loadGallerySection(activeGallerySection, 0);
  }, [unlocked, tab, activeGallerySection, loadGallerySection]);

  const loadNextGalleryPage = useCallback(() => {
    if (!activeGallerySection || galleryLoading || galleryLoadingMore || !galleryHasMore) return;
    loadGallerySection(activeGallerySection, galleryPhotos.length);
  }, [activeGallerySection, galleryLoading, galleryLoadingMore, galleryHasMore, galleryPhotos.length, loadGallerySection]);

  useEffect(() => {
    if (!activeGallerySection || !galleryHasMore || galleryLoading || galleryLoadingMore) return;
    const node = loadMoreRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadNextGalleryPage();
    }, { rootMargin: '200px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeGallerySection, galleryHasMore, galleryLoading, galleryLoadingMore, loadNextGalleryPage]);

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
      flashSaved();
    } catch (e) {
      console.error('Save failed:', e);
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function flashSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function handleTemplateUpload(file) {
    if (!file) return;
    setTemplateBusy(true);
    setTemplateError('');
    setError('');
    try {
      const imageData = await readFileAsDataUrl(file);
      const res = await fetch(API('/template-image'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, imageData }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Upload failed');
      setConfig((prev) => ({
        ...prev,
        template: {
          ...prev.template,
          imageFilename: data.imageFilename,
          imageUpdatedAt: data.imageUpdatedAt,
        },
      }));
      flashSaved();
    } catch (e) {
      console.error('Template upload failed:', e);
      setTemplateError(e.message);
    } finally {
      setTemplateBusy(false);
    }
  }

  async function handleRemoveTemplate() {
    setTemplateBusy(true);
    setTemplateError('');
    setError('');
    try {
      const res = await fetch(API('/template-image'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Remove failed');
      setConfig((prev) => ({
        ...prev,
        template: {
          ...prev.template,
          imageFilename: null,
          imageUpdatedAt: 0,
        },
      }));
      flashSaved();
    } catch (e) {
      console.error('Template remove failed:', e);
      setTemplateError(e.message);
    } finally {
      setTemplateBusy(false);
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
  const activeSection = GALLERY_SECTIONS.find((section) => section.id === activeGallerySection) ?? null;
  const totalGalleryItems = Object.values(galleryCounts).reduce((sum, count) => sum + count, 0);

  // Fullscreen photo view
  if (selectedPhoto) {
    const isCollage = selectedPhoto.kind === 'strip';

    async function handleDelete() {
      try {
        const res = await fetch(`/api/admin/photos/${encodeURIComponent(selectedPhoto.filename)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        setGalleryPhotos((prev) => prev.filter((p) => p.filename !== selectedPhoto.filename));
        setGalleryCounts((prev) => ({
          ...prev,
          [selectedPhoto.kind]: Math.max(0, (prev[selectedPhoto.kind] ?? 0) - 1),
        }));
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

    function handleDownload(withTemplate) {
      setConfirmDownload(false);
      const href = withTemplate
        ? `/photos/download-rendered/${encodeURIComponent(selectedPhoto.filename)}?withTemplate=true`
        : (selectedPhoto.downloadUrl ?? selectedPhoto.url);
      const link = document.createElement('a');
      link.href = href;
      if (withTemplate) {
        link.download = `${selectedPhoto.filename.replace(/\.[^.]+$/u, '')}_with_template.png`;
      }
      document.body.appendChild(link);
      link.click();
      link.remove();
    }

    return (
      <div className={styles.fullscreen}>
        <img src={selectedPhoto.url} alt="Photo" className={styles.fullImg} />
        <button className={styles.closeBtn} onClick={() => { setSelectedPhoto(null); setConfirmDelete(false); setConfirmPrint(false); setConfirmDownload(false); }}>X</button>
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
        ) : confirmDownload ? (
          <div className={styles.deleteConfirm}>
            <span>Download with template overlay?</span>
            <button className={styles.deleteBtnConfirm} onClick={() => handleDownload(true)}>With template</button>
            <button className={styles.deleteBtnCancel} onClick={() => handleDownload(false)}>Without template</button>
            <button className={styles.deleteBtnCancel} onClick={() => setConfirmDownload(false)}>Cancel</button>
          </div>
        ) : (
          <div className={styles.photoActions}>
            <button className={styles.photoActionBtn} onClick={() => setConfirmDownload(true)}>Download</button>
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
              <p className={styles.fieldHint}>When simulate camera is on, the live preview always uses the client camera even if DSLR preview is selected below.</p>
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
              <NumberField label="Shutter Delay (ms)" value={config.camera?.shutterDelayMs ?? 0}
                onChange={(v) => set('camera.shutterDelayMs', v)} min={0} max={2000} step={50} />
              <p className={styles.fieldHint}>Fires the capture request this many ms before the on-screen countdown hits 0 — compensates for shutter lag so the shot lands right on "0" instead of a beat late.</p>
            </section>

            {/* Template */}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Photo Template</h2>
              <Toggle label="Enabled" value={config.template?.enabled ?? false}
                onChange={(v) => set('template.enabled', v)} />
              <p className={styles.fieldHint}>Upload a full 2x6 strip template image to use on strip prints. When an image is present, it overrides the basic banner below for photo strips only.</p>
              <div className={styles.templateActions}>
                <label className={styles.btnSecondary}>
                  {templateBusy ? 'Uploading…' : 'Upload Strip Template'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className={styles.hiddenFileInput}
                    disabled={templateBusy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      handleTemplateUpload(file);
                    }}
                  />
                </label>
                <button
                  className={styles.btnSecondary}
                  onClick={handleRemoveTemplate}
                  disabled={templateBusy || !config.template?.imageFilename}
                >
                  Remove Uploaded Image
                </button>
              </div>
              <OptionToggle
                label="Uploaded Image Placement"
                value={config.template?.imagePlacement ?? 'underlay'}
                options={[
                  { value: 'underlay', label: 'Underlay' },
                  { value: 'overlay', label: 'Overlay' },
                ]}
                onChange={(v) => set('template.imagePlacement', v)}
              />
              <p className={styles.fieldHint}>Recommended: transparent PNG, designed at 600x1800px or any matching 1:3 ratio.</p>
              {templateImageUrl ? (
                <div className={styles.templatePreviewCard}>
                  <img src={templateImageUrl} alt="Strip template preview" className={styles.templatePreviewImg} />
                </div>
              ) : (
                <p className={styles.fieldHint}>No strip template image uploaded.</p>
              )}
              {templateError && <p className={styles.errorMsg}>{templateError}</p>}
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
              <OptionToggle
                label="Live Preview Source"
                value={config.camera?.previewSource ?? 'client'}
                options={[
                  { value: 'client', label: 'Client Camera' },
                  { value: 'dslr', label: 'DSLR Camera' },
                ]}
                onChange={(v) => set('camera.previewSource', v)}
              />
              <p className={styles.fieldHint}>Client Camera uses the iPad camera. DSLR Camera uses the Nikon live view stream and pauses it briefly for each still capture before resuming automatically.</p>
              <NumberField label="Auto-return After (sec, 0 = off)" value={config.booth?.autoReturnSeconds ?? 10}
                onChange={(v) => set('booth.autoReturnSeconds', v)} min={0} max={60} />
              <NumberField label="Preview Time Before Auto-Print (sec, 0 = instant)" value={config.booth?.previewBeforePrintSeconds ?? 5}
                onChange={(v) => set('booth.previewBeforePrintSeconds', v)} min={0} max={30} />
              <NumberField label="Camera View Dim Overlay (%, 0 = off)" value={config.booth?.liveOverlayOpacity ?? 35}
                onChange={(v) => set('booth.liveOverlayOpacity', v)} min={0} max={100} />
              <p className={styles.fieldHint}>Applies to the idle start screen and the countdown/capture screens.</p>
              <NumberField label="Live Preview Zoom (%)" value={config.booth?.livePreviewZoomPercent ?? 100}
                onChange={(v) => set('booth.livePreviewZoomPercent', v)} min={50} max={200} step={1} />
              <p className={styles.fieldHint}>Digital zoom for the live preview only. Increase it to tighten the framing without affecting the actual saved photo.</p>
              <Toggle label="Mirror Live Preview" value={config.booth?.mirrorLivePreview ?? true}
                onChange={(v) => set('booth.mirrorLivePreview', v)} />
              <p className={styles.fieldHint}>When on, the live preview is mirrored left-to-right. Turn it off to match the saved DSLR photo orientation more closely.</p>
              <Toggle label="Match DSLR Aspect Ratio (test)" value={config.booth?.matchDslrAspect ?? false}
                onChange={(v) => set('booth.matchDslrAspect', v)} />
              <p className={styles.fieldHint}>Crops the live preview to a 2:3 portrait box (matching the DSLR photo) instead of filling the whole screen, so guests frame themselves closer to what the camera will actually capture.</p>
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
          {galleryLoading && !activeSection ? (
            <div className={styles.galleryEmpty}>Loading…</div>
          ) : galleryError ? (
            <div className={styles.galleryEmpty}>{galleryError}</div>
          ) : totalGalleryItems === 0 && !activeSection ? (
            <div className={styles.galleryEmpty}>No photos yet</div>
          ) : activeSection ? (
            <div className={styles.gallerySectionView}>
              <div className={styles.gallerySectionHeader}>
                <button className={styles.btnSecondary} onClick={() => setActiveGallerySection(null)}>← Back to Folders</button>
                <div className={styles.gallerySectionMeta}>
                  <h2 className={styles.gallerySectionTitle}>{activeSection.title}</h2>
                  <p className={styles.gallerySectionCount}>{galleryCounts[activeSection.id] ?? 0} item{(galleryCounts[activeSection.id] ?? 0) === 1 ? '' : 's'}</p>
                </div>
              </div>
              {galleryLoading && galleryPhotos.length === 0 ? (
                <div className={styles.galleryEmptySection}>Loading…</div>
              ) : galleryPhotos.length === 0 ? (
                <div className={styles.galleryEmptySection}>{activeSection.empty}</div>
              ) : (
                <>
                  <div className={`${styles.galleryGrid} ${activeSection.id === 'strip' ? styles.galleryGridStrips : ''}`}>
                    {galleryPhotos.map((photo) => (
                      <div
                        key={photo.filename}
                        className={`${styles.galleryThumb} ${activeSection.id === 'strip' ? styles.galleryThumbStrip : ''}`}
                        onClick={() => setSelectedPhoto(photo)}
                      >
                        <img
                          src={photo.thumbUrl ?? photo.url}
                          alt={photo.filename}
                          loading="lazy"
                          className={activeSection.id === 'strip' ? styles.galleryThumbImgStrip : ''}
                        />
                      </div>
                    ))}
                  </div>
                  {galleryHasMore && <div ref={loadMoreRef} className={styles.galleryLoadSentinel} />}
                  {galleryLoadingMore && <div className={styles.galleryLoadingMore}>Loading more…</div>}
                </>
              )}
            </div>
          ) : (
            <div className={styles.galleryFolders}>
              {GALLERY_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  className={styles.galleryFolder}
                  onClick={() => setActiveGallerySection(section.id)}
                >
                  <div className={styles.galleryFolderTitleRow}>
                    <span className={styles.galleryFolderIcon}>Folder</span>
                    <span className={styles.galleryFolderCount}>{galleryCounts[section.id] ?? 0}</span>
                  </div>
                  <div className={styles.galleryFolderTitle}>{section.title}</div>
                  <div className={styles.galleryFolderHint}>{section.empty.replace('No ', '').replace(' yet', '')}</div>
                </button>
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

function OptionToggle({ label, value, options, onChange }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.optionToggle}>
        {options.map((option) => (
          <button
            key={option.value}
            className={`${styles.optionToggleBtn} ${value === option.value ? styles.optionToggleBtnActive : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}
