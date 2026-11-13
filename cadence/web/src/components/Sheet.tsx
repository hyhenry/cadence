import { useEffect, useRef, type ReactNode } from 'react';

interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Optional element rendered at the right of the header (e.g. a Save button). */
  action?: ReactNode;
  size?: 'normal' | 'small';
  labelledBy?: string;
}

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Sheet({ title, onClose, children, footer, action, size = 'normal' }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), select, textarea, button:not(.sheet-close)');
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
        if (!items.length) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.({ preventScroll: true });
    };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`sheet sheet-${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <div
          className="sheet-grip"
          aria-hidden="true"
          onTouchStart={(e) => (startY.current = e.touches[0].clientY)}
          onTouchEnd={(e) => {
            if (startY.current != null && e.changedTouches[0].clientY - startY.current > 80) onClose();
            startY.current = null;
          }}
        />
        <header className="sheet-header">
          <button type="button" className="icon-btn sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
          <h2>{title}</h2>
          <div className="sheet-action">{action}</div>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-footer">{footer}</footer>}
      </div>
    </div>
  );
}

const PATHS: Record<string, string> = {
  close: 'M6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6Z',
  menu: 'M3 18v-2h18v2Zm0-5v-2h18v2Zm0-5V6h18v2Z',
  // Stacked layers: "which calendars are shown". Deliberately not a hamburger,
  // so it can't be mistaken for Home Assistant's own sidebar button above it.
  layers: 'M12 16 3 9l9-7 9 7Zm0 5.05-9-7 1.65-1.25L12 18.5l7.35-5.7L21 14.05Z',
  // A window with a side panel: shows / hides the docked calendar list.
  sidebar: 'M5 21q-.82 0-1.41-.59Q3 19.82 3 19V5q0-.82.59-1.41Q4.18 3 5 3h14q.82 0 1.41.59Q21 4.18 21 5v14q0 .82-.59 1.41Q19.82 21 19 21Zm3-2V5H5v14Zm2 0h9V5h-9Z',
  unfold: 'M12 21 7.5 16.5l1.45-1.45L12 18.1l3.05-3.05 1.45 1.45ZM8.95 9.45 7.5 8 12 3.5 16.5 8l-1.45 1.45L12 6.4Z',
  left: 'M14 18 8 12l6-6 1.4 1.4-4.6 4.6 4.6 4.6Z',
  right: 'm9.4 18-1.4-1.4 4.6-4.6L8 7.4 9.4 6l6 6Z',
  plus: 'M11 19v-6H5v-2h6V5h2v6h6v2h-6v6Z',
  settings: 'm9.25 22-.4-3.2q-.33-.13-.61-.3-.29-.18-.56-.38L4.7 19.4l-2.75-4.75 2.58-1.95Q4.5 12.5 4.5 12.34v-.67q0-.16.03-.36L1.95 9.35 4.7 4.6l2.98 1.25q.27-.2.57-.38.3-.17.6-.3l.4-3.17h5.5l.4 3.2q.33.13.61.3.29.18.56.38l2.98-1.25 2.75 4.75-2.58 1.95q.03.2.03.36v.67q0 .17-.05.36l2.58 1.95-2.75 4.75-2.95-1.25q-.27.2-.57.38-.3.17-.6.3l-.4 3.2Zm2.8-6.5q1.45 0 2.48-1.02Q15.55 13.45 15.55 12t-1.02-2.47Q13.5 8.5 12.05 8.5q-1.47 0-2.49 1.03Q8.55 10.55 8.55 12t1.01 2.48q1.02 1.02 2.49 1.02Z',
  more: 'M12 20q-.82 0-1.41-.59Q10 18.83 10 18t.59-1.41Q11.18 16 12 16t1.41.59Q14 17.18 14 18t-.59 1.41Q12.83 20 12 20Zm0-6q-.82 0-1.41-.59Q10 12.82 10 12t.59-1.41Q11.18 10 12 10t1.41.59Q14 11.18 14 12t-.59 1.41Q12.83 14 12 14Zm0-6q-.82 0-1.41-.59Q10 6.83 10 6t.59-1.41Q11.18 4 12 4t1.41.59Q14 5.18 14 6t-.59 1.41Q12.83 8 12 8Z',
  link: 'M11 17H7q-2.08 0-3.54-1.46Q2 14.08 2 12t1.46-3.54Q4.92 7 7 7h4v2H7q-1.25 0-2.12.88Q4 10.75 4 12t.88 2.13Q5.75 15 7 15h4Zm-3-4v-2h8v2Zm5 4v-2h4q1.25 0 2.13-.87Q20 13.25 20 12t-.87-2.12Q18.25 9 17 9h-4V7h4q2.08 0 3.54 1.46Q22 9.92 22 12t-1.46 3.54Q19.08 17 17 17Z',
  bell: 'M4 19v-2h2v-7q0-2.08 1.25-3.69Q8.5 4.7 10.5 4.2v-.7q0-.63.44-1.06Q11.38 2 12 2t1.06.44q.44.43.44 1.06v.7q2 .5 3.25 2.11T18 10v7h2v2Zm8 3q-.83 0-1.41-.59Q10 20.83 10 20h4q0 .83-.59 1.41Q12.83 22 12 22Z',
  trash: 'M7 21q-.82 0-1.41-.59Q5 19.82 5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .82-.59 1.41Q17.83 21 17 21Zm2-4h2V8H9Zm4 0h2V8h-2Z',
  refresh: 'M12 20q-3.35 0-5.67-2.33Q4 15.35 4 12t2.33-5.67Q8.65 4 12 4q1.73 0 3.3.71 1.58.71 2.7 2.04V4h2v7h-7V9h4.2q-.8-1.4-2.19-2.2Q13.63 6 12 6 9.5 6 7.75 7.75T6 12q0 2.5 1.75 4.25T12 18q1.93 0 3.48-1.1Q17.03 15.8 17.65 14h2.1q-.7 2.65-2.85 4.33Q14.75 20 12 20Z',
  check: 'M9.55 18 3.85 12.3l1.43-1.42 4.27 4.27 9.18-9.17 1.42 1.42Z',
  lock: 'M6 22q-.82 0-1.41-.59Q4 20.83 4 20V10q0-.82.59-1.41Q5.18 8 6 8h1V6q0-2.08 1.46-3.54Q9.92 1 12 1t3.54 1.46Q17 3.92 17 6v2h1q.82 0 1.41.59Q20 9.18 20 10v10q0 .82-.59 1.41Q18.83 22 18 22Zm6-5q.82 0 1.41-.59Q14 15.83 14 15t-.59-1.41Q12.83 13 12 13t-1.41.59Q10 14.18 10 15t.59 1.41Q11.18 17 12 17ZM9 8h6V6q0-1.25-.87-2.12Q13.25 3 12 3t-2.12.88Q9 4.75 9 6Z',
  calendar: 'M5 22q-.82 0-1.41-.59Q3 20.83 3 20V6q0-.82.59-1.41Q4.18 4 5 4h1V2h2v2h8V2h2v2h1q.82 0 1.41.59Q21 5.18 21 6v14q0 .82-.59 1.41Q19.83 22 19 22Zm0-2h14V10H5Z',
};

export function Icon({ name, size = 24 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name] ?? ''} fill="currentColor" />
    </svg>
  );
}
