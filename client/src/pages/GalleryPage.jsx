import { useState, useEffect } from 'react';
import { apiGallery } from '../hooks/usePhotobooth.js';
import BigButton from '../components/BigButton.jsx';
import styles from './GalleryPage.module.css';

export default function GalleryPage({ onBack }) {
  const [photos, setPhotos] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGallery()
      .then((data) => setPhotos(data.photos))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className={styles.center}>
        <div className={styles.spinner} />
      </div>
    );
  }

  if (selected) {
    return (
      <div className={styles.fullscreen}>
        <img src={selected.url} alt="Photo" className={styles.fullImg} />
        <button className={styles.closeBtn} onClick={() => setSelected(null)}>✕</button>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <BigButton onClick={onBack} variant="secondary">↩ Back</BigButton>
      </div>
      {photos.length === 0 ? (
        <div className={styles.empty}>No photos yet</div>
      ) : (
        <div className={styles.grid}>
          {photos.map((photo) => (
            <div key={photo.filename} className={styles.thumb} onClick={() => setSelected(photo)}>
              <img src={photo.url} alt={photo.filename} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
