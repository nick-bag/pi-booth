import styles from './BigButton.module.css';

export default function BigButton({ onClick, children, variant = 'primary', disabled }) {
  return (
    <button
      className={`${styles.btn} ${styles[variant]}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
