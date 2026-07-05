import BigButton from '../components/BigButton.jsx';
import styles from './StartPage.module.css';

export default function StartPage({ config, onSelect, onTitleTap }) {
  const title = config?.wedding?.title || 'Photo Booth';
  const subtitle = config?.wedding?.subtitle || '';
  const overlayStyle = { '--live-overlay-opacity': (config?.booth?.liveOverlayOpacity ?? 35) / 100 };

  return (
    <div className={styles.page} style={overlayStyle}>
      <div className={styles.header}>
        <h1 className={styles.title} onClick={onTitleTap}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>

      <div className={styles.actions}>
        {(config?.picture?.enabled ?? true) && (
          <BigButton onClick={() => onSelect('single')}>
            Single Photo
          </BigButton>
        )}
        {(config?.collage?.enabled ?? true) && (
          <BigButton onClick={() => onSelect('collage')} variant="secondary">
            Photo Strip
          </BigButton>
        )}
      </div>

      <div className={styles.footer}>Tap a button to get started</div>
    </div>
  );
}
