import { useState, useEffect, useRef } from 'react';
import StartPage from './pages/StartPage.jsx';
import CapturePage from './pages/CapturePage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import { usePhotobooth, apiConfig } from './hooks/usePhotobooth.js';

const VIEWS = { START: 'start', CAPTURE: 'capture', ADMIN: 'admin' };

export default function App() {
  const [view, setView] = useState(VIEWS.START);
  const [captureType, setCaptureType] = useState(null);
  const [config, setConfig] = useState(null);
  const [wsEvent, setWsEvent] = useState(null);
  const tapCount = useRef(0);
  const tapTimer = useRef(null);

  // Camera stream — started once, persists across all views
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [camReady, setCamReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
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
    };
  }, []);

  usePhotobooth((event) => {
    setWsEvent(event);
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
    setWsEvent(null);
  }

  let pageContent;
  if (view === VIEWS.ADMIN) pageContent = <AdminPage onExit={handleBack} />;
  else if (view === VIEWS.CAPTURE && captureType) pageContent = <CapturePage type={captureType} config={config} camReady={camReady} onBack={handleBack} />;
  else pageContent = <StartPage config={config} onSelect={handleSelect} onTitleTap={handleTitleTap} />;

  const previewZoom = Math.max(config?.booth?.livePreviewZoomPercent ?? 100, 1) / 100;

  return (
    <div className="appRoot">
      <div
        className={[
          'appVideoFrame',
          config?.booth?.matchDslrAspect && 'appVideoFrameAspect',
        ].filter(Boolean).join(' ')}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={[
            'appVideo',
            camReady && 'appVideoReady',
            (config?.booth?.mirrorLivePreview ?? true) && 'appVideoMirrored',
          ].filter(Boolean).join(' ')}
          style={{ '--app-video-scale': previewZoom }}
        />
      </div>
      <div className="appContent">
        {pageContent}
      </div>
    </div>
  );
}
