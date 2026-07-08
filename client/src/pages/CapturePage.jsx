import { useState, useRef, useEffect } from 'react';
import Countdown from '../components/Countdown.jsx';
import BigButton from '../components/BigButton.jsx';
import { useCountdown } from '../hooks/useCountdown.js';
import { apiCapture, apiCaptureShot, apiCollageBuild, apiPrint } from '../hooks/usePhotobooth.js';
import styles from './CapturePage.module.css';

const PHASES = {
  CAM_LOADING: 'cam_loading',
  COUNTDOWN: 'countdown',
  CAPTURING: 'capturing',
  SHOT_PREVIEW: 'shot_preview',
  BUILDING: 'building',
  PREVIEW: 'preview',
  PRINTING: 'printing',
  DONE: 'done',
  ERROR: 'error',
};

export default function CapturePage({ type, config, camReady, onBack }) {
  const [phase, setPhase] = useState(camReady ? PHASES.COUNTDOWN : PHASES.CAM_LOADING);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [shotIndex, setShotIndex] = useState(0); // current shot (0-based)
  const [shotPreviewUrl, setShotPreviewUrl] = useState(null);
  const shotFilenames = useRef([]);

  const totalShots = config?.collage?.shots ?? 3;
  const countdownFrom = type === 'single'
    ? config?.single?.countdownSeconds ?? 3
    : config?.collage?.countdownSeconds ?? 3;
  const shotPreviewDuration = (config?.collage?.shotPreviewSeconds ?? 3) * 1000;
  const autoReturnSeconds = config?.booth?.autoReturnSeconds ?? 10;
  const liveOverlayStyle = { '--live-overlay-opacity': (config?.booth?.liveOverlayOpacity ?? 35) / 100 };

  // Two countdowns run in parallel: the on-screen one guests see (countdownFrom seconds),
  // and an earlier "fire" countdown that kicks off the actual capture request shutterDelayMs
  // before the on-screen one reaches 0 — compensating for camera/USB shutter lag so the
  // physical shutter actually fires right when guests see "0", not ~1-2s late.
  const shutterDelayMs = config?.camera?.shutterDelayMs ?? 0;
  const pendingCaptureRef = useRef(null);

  useEffect(() => {
    if (phase !== PHASES.COUNTDOWN) return;
    pendingCaptureRef.current = null;
    const fireDelayMs = Math.max(0, countdownFrom * 1000 - shutterDelayMs);
    const timer = setTimeout(() => {
      pendingCaptureRef.current = type === 'single' ? apiCapture('single') : apiCaptureShot();
    }, fireDelayMs);
    return () => clearTimeout(timer);
  }, [phase, countdownFrom, shutterDelayMs, type]);

  // Auto-print after a delay when entering PREVIEW phase (if print enabled) — gives
  // the guest time to actually see the final photo before it's whisked off to print.
  const printDelayMs = (config?.booth?.previewBeforePrintSeconds ?? 5) * 1000;
  const [printCountdown, setPrintCountdown] = useState(null);
  useEffect(() => {
    if (phase !== PHASES.PREVIEW || !result || !config?.print?.enabled) return;
    if (printDelayMs <= 0) {
      handlePrint();
      return;
    }
    setPrintCountdown(Math.ceil(printDelayMs / 1000));
    const interval = setInterval(() => {
      setPrintCountdown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    const timeout = setTimeout(() => {
      setPrintCountdown(null);
      handlePrint();
    }, printDelayMs);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [phase, result]);


  const [returnCount, setReturnCount] = useState(null);
  useEffect(() => {
    if (phase !== PHASES.DONE && phase !== PHASES.PREVIEW) return;
    if (!autoReturnSeconds) return;
    setReturnCount(autoReturnSeconds);
    const interval = setInterval(() => {
      setReturnCount((c) => {
        if (c <= 1) { clearInterval(interval); return 0; }
        return c - 1;
      });
    }, 1000);
    const timeout = setTimeout(onBack, autoReturnSeconds * 1000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [phase]);

  useEffect(() => {
    if (camReady && phase === PHASES.CAM_LOADING) setPhase(PHASES.COUNTDOWN);
  }, [camReady]);

  const count = useCountdown(countdownFrom, phase === PHASES.COUNTDOWN, handleCountdownDone);

  async function handleCountdownDone() {
    setPhase(PHASES.CAPTURING);

    try {
      // Use the already-in-flight request fired early (see the fire-countdown effect above)
      // so we don't re-trigger a second, redundant capture — fall back to firing now only if
      // shutterDelayMs was 0/misconfigured and the early timer never ran.
      if (type === 'single') {
        const data = await (pendingCaptureRef.current ?? apiCapture('single'));
        setResult(data);
        setPhase(PHASES.PREVIEW);
      } else {
        // Capture this shot
        const data = await (pendingCaptureRef.current ?? apiCaptureShot());
        shotFilenames.current = [...shotFilenames.current, data.filename];
        const nextShot = shotFilenames.current.length;

        if (nextShot < totalShots) {
          // Show the just-captured shot for a moment before the next countdown.
          // Prefer the cached strip-slot crop so the preview matches the final strip framing
          // without having to load the full-resolution original.
          setShotPreviewUrl(data.previewUrl ?? data.thumbUrl ?? data.url);
          setPhase(PHASES.SHOT_PREVIEW);
          setTimeout(() => {
            setShotIndex(nextShot);
            setShotPreviewUrl(null);
            setPhase(PHASES.COUNTDOWN);
          }, shotPreviewDuration);
        } else {
          // All shots captured — build the strip
          setPhase(PHASES.BUILDING);
          const collage = await apiCollageBuild(shotFilenames.current);
          setResult(collage);
          setPhase(PHASES.PREVIEW);
        }
      }
    } catch (e) {
      setError(e.message);
      setPhase(PHASES.ERROR);
    }
  }

  async function handlePrint() {
    setPhase(PHASES.PRINTING);
    try {
      await apiPrint(result.filename, type, config?.template?.enabled ?? false);
      setPhase(PHASES.DONE);
    } catch (e) {
      setError(e.message);
      setPhase(PHASES.ERROR);
    }
  }

  if (phase === PHASES.CAM_LOADING) {
    return (
      <div className={styles.liveWrap}>
        <div className={styles.liveOverlay} style={liveOverlayStyle}>
          <div className={styles.camLoading}>
            <div className={styles.spinner} />
          </div>
        </div>
      </div>
    );
  }

  if (phase === PHASES.COUNTDOWN) {
    const label = type === 'collage'
      ? `Photo ${shotIndex + 1} of ${totalShots}`
      : 'Smile!';
    return (
      <div className={styles.liveWrap}>
        <div className={styles.liveOverlay} style={liveOverlayStyle}>
          <Countdown count={count} label={label} />
        </div>
      </div>
    );
  }

  if (phase === PHASES.CAPTURING) {
    return (
      <div className={styles.liveWrap}>
        <div className={styles.liveOverlay} style={liveOverlayStyle}>
          <div className={styles.center}>
            <div className={styles.spinner} />
          </div>
        </div>
      </div>
    );
  }

  if (phase === PHASES.SHOT_PREVIEW && shotPreviewUrl) {
    return (
      <div className={styles.shotPreview}>
        <img src={shotPreviewUrl} alt={`Shot ${shotIndex}`} className={styles.shotPreviewImg} />
        <p className={styles.shotPreviewLabel}>
          Photo {shotIndex + 1} of {totalShots}
        </p>
      </div>
    );
  }

  if (phase === PHASES.BUILDING) {
    return (
      <div className={styles.center}>
        <div className={styles.spinner} />
        <p>Building your photo strip…</p>
      </div>
    );
  }

  if (phase === PHASES.PREVIEW && result) {
    return (
      <div className={styles.preview}>
        <img src={result.previewUrl ?? result.url} alt="Your photo" className={styles.previewImg} />
        <div className={styles.previewActions}>
          <BigButton onClick={onBack} variant="secondary">Start Over</BigButton>
          {printCountdown !== null && (
            <p className={styles.autoReturn}>Printing in {printCountdown}s…</p>
          )}
          {printCountdown === null && returnCount !== null && (
            <p className={styles.autoReturn}>Returning in {returnCount}s…</p>
          )}
        </div>
      </div>
    );
  }

  if (phase === PHASES.PRINTING) {
    return (
      <div className={styles.center}>
        <div className={styles.spinner} />
        <p>Sending to printer…</p>
      </div>
    );
  }

  if (phase === PHASES.DONE) {
    return (
      <div className={styles.center}>
        <div className={styles.doneIcon}>✓</div>
        <p className={styles.doneText}>Printing!</p>
        <p className={styles.doneSubtext}>
          {type === 'collage' ? `${config?.print?.collagePrintCopies ?? 2} copies` : ''}
        </p>
        <BigButton onClick={onBack} variant="secondary" style={{ marginTop: '2rem' }}>
          ↩ Start Over
        </BigButton>
        {returnCount !== null && (
          <p className={styles.autoReturn}>Returning in {returnCount}s…</p>
        )}
      </div>
    );
  }

  if (phase === PHASES.ERROR) {
    return (
      <div className={styles.center}>
        <div className={styles.errorIcon}>✕</div>
        <p className={styles.errorText}>{error || 'Something went wrong'}</p>
        <BigButton onClick={onBack} variant="secondary" style={{ marginTop: '2rem' }}>
          ↩ Try Again
        </BigButton>
      </div>
    );
  }

  return null;
}
