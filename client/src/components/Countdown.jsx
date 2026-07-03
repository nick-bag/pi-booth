import styles from './Countdown.module.css';

export default function Countdown({ count, label }) {
  return (
    <div className={styles.wrap}>
      {label && <div className={styles.label}>{label}</div>}
      <div className={styles.number} key={count}>
        {count > 0 ? count : 'Smile!'}
      </div>
    </div>
  );
}
