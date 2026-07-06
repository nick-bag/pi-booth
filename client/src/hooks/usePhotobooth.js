import { useEffect, useRef, useCallback } from 'react';

const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

export function usePhotobooth(onEvent) {
  const wsRef = useRef(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          onEventRef.current?.(data);
        } catch {}
      };

      ws.onclose = () => setTimeout(connect, 2000);
    }
    connect();
    return () => wsRef.current?.close();
  }, []);
}

export async function apiCapture(type) {
  const res = await fetch(`/api/capture/${type}`, { method: 'POST' });
  if (!res.ok) throw new Error('Capture failed');
  return res.json();
}

export async function apiCaptureShot() {
  const res = await fetch('/api/capture/shot', { method: 'POST' });
  if (!res.ok) throw new Error('Shot capture failed');
  return res.json();
}

export async function apiCollageBuild(filenames) {
  const res = await fetch('/api/collage/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames }),
  });
  if (!res.ok) throw new Error('Collage build failed');
  return res.json();
}

export async function apiPrint(filename, type, withTemplate = false) {
  const res = await fetch('/api/print', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, type, withTemplate }),
  });
  if (!res.ok) throw new Error('Print failed');
  return res.json();
}

export async function apiGallery() {
  const res = await fetch('/api/gallery');
  if (!res.ok) throw new Error('Gallery failed');
  return res.json();
}

export async function apiGallerySummary() {
  const res = await fetch('/api/gallery/summary');
  if (!res.ok) throw new Error('Gallery summary failed');
  return res.json();
}

export async function apiGallerySection(kind, { offset = 0, limit = 60 } = {}) {
  const params = new URLSearchParams({
    kind,
    offset: String(offset),
    limit: String(limit),
  });
  const res = await fetch(`/api/gallery?${params.toString()}`);
  if (!res.ok) throw new Error('Gallery section failed');
  return res.json();
}

export async function apiConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('Config failed');
  return res.json();
}
