import { useState, useEffect, useRef } from 'react';
import StartPage from './pages/StartPage.jsx';
import CapturePage from './pages/CapturePage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import { usePhotobooth, apiConfig } from './hooks/usePhotobooth.js';

const VIEWS = { START: 'start', CAPTURE: 'capture', ADMIN: 'admin' };
const DSLR_STREAM_URL = '/api/camera/stream.mjpg';
const STRIP_W = 600;
const STRIP_H = 1800;

function getCapturePreviewAspect(captureType, config) {
  if (captureType === 'collage') {
    const shots = Math.max(1, config?.collage?.shots ?? 3);
    const border = Math.max(0, config?.print?.borderSize ?? 20);
    const thumbW = Math.max(1, STRIP_W - border * 2);
    const thumbH = Math.max(1, Math.floor((STRIP_H - border * (shots + 1)) / shots));
    return `${thumbW} / ${thumbH}`;
  }

  return '2 / 3';
}

export default function App() {
  const [view, setView] = useState(VIEWS.START);
  const [captureType, setCaptureType] = useState(null);
  const [config, setConfig] = useState(null);
  const tapCount = useRef(0);
  const tapTimer = useRef(null);

  // Camera stream — started once, persists across all views
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [camReady, setCamReady] = useState(false);
  const previewSource = !config
    ? null
    : (config.camera?.simulateCapture ? 'client' : (config.camera?.previewSource ?? 'client'));

  useEffect(() => {
    if (!previewSource) {
      setCamReady(false);
      return;
    }
    if (previewSource !== 'client') {
      setCamReady(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }

    let cancelled = false;
    setCamReady(false);
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setCamReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [previewSource]);
  usePhotobooth((event) => {
    if (event.event === 'config_updated') {
      apiConfig().then(setConfig).catch(console.error);
    }
  });

  useEffect(() => {
    apiConfig().then(setConfig).catch(console.error);
  }, []);

  useEffect(() => {
    if (!config?.wedding) return;
    const root = document.documentElement;
    if (config.wedding.primaryColor) root.style.setProperty('--primary', config.wedding.primaryColor);
    if (config.wedding.textColor) root.style.setProperty('--text', config.wedding.textColor);
  }, [config]);

  function handleTitleTap() {
    tapCount.current += 1;
    clearTimeout(tapTimer.current);
    if (tapCount.current >= 5) {
      tapCount.current = 0;
      setView(VIEWS.ADMIN);
    } else {
      tapTimer.current = setTimeout(() => { tapCount.current = 0; }, 2000);
    }
  }

  function handleSelect(type) {
    setCaptureType(type);
    setView(VIEWS.CAPTURE);
  }

  function handleBack() {
    setView(VIEWS.START);
    setCaptureType(null);
  }

  let pageContent;
  if (view === VIEWS.ADMIN) pageContent = <AdminPage onExit={handleBack} />;
  else if (view === VIEWS.CAPTURE && captureType) pageContent = <CapturePage type={captureType} config={config} camReady={camReady} onBack={handleBack} />;
  else pageContent = <StartPage config={config} onSelect={handleSelect} onTitleTap={handleTitleTap} />;

  const previewZoom = Math.max(config?.booth?.livePreviewZoomPercent ?? 100, 1) / 100;
  const capturePreviewAspect = view === VIEWS.CAPTURE && captureType
    ? getCapturePreviewAspect(captureType, config)
    : null;
  const frameAspect = capturePreviewAspect ?? (config?.booth?.matchDslrAspect ? '2 / 3' : null);

  return (
    <div className="appRoot">
      <div
        className={[
          'appVideoFrame',
          frameAspect && 'appVideoFrameConstrained',
        ].filter(Boolean).join(' ')}
        style={frameAspect ? { '--app-preview-aspect': frameAspect } : undefined}
      >
        {previewSource === 'client' ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={[
              'appPreviewMedia',
              camReady && 'appPreviewReady',
              (config?.booth?.mirrorLivePreview ?? true) && 'appPreviewMirrored',
            ].filter(Boolean).join(' ')}
            style={{ '--app-video-scale': previewZoom }}
          />
        ) : previewSource === 'dslr' ? (
          <img
            key={previewSource}
            src={DSLR_STREAM_URL}
            alt=""
            onLoad={() => setCamReady(true)}
            onError={() => setCamReady(false)}
            className={[
              'appPreviewMedia',
              camReady && 'appPreviewReady',
              (config?.booth?.mirrorLivePreview ?? true) && 'appPreviewMirrored',
            ].filter(Boolean).join(' ')}
            style={{ '--app-video-scale': previewZoom }}
          />
        ) : null}
      </div>
      <div className="appContent">
        {pageContent}
      </div>
    </div>
  );
}
