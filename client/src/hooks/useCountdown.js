import { useEffect, useRef, useState } from 'react';

export function useCountdown(from, active, onDone) {
  const [count, setCount] = useState(from);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!active) {
      setCount(from);
      return;
    }
    setCount(from);
    const interval = setInterval(() => {
      setCount((c) => {
        if (c <= 1) {
          clearInterval(interval);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [active]);

  // Fire onDone in an effect (not inside a state updater) so React 18
  // concurrent mode cannot invoke it multiple times.
  useEffect(() => {
    if (active && count === 0) {
      onDoneRef.current?.();
    }
  }, [count, active]);

  return count;
}
