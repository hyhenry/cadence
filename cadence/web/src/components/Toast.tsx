import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

const Ctx = createContext<(message: string, opts?: { kind?: 'info' | 'error'; action?: ToastItem['action'] }) => void>(() => undefined);

export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const show = useCallback((message: string, opts: { kind?: 'info' | 'error'; action?: ToastItem['action'] } = {}) => {
    const id = next.current++;
    setItems((xs) => [...xs.filter((x) => x.message !== message), { id, message, kind: opts.kind ?? 'info', action: opts.action }].slice(-3));
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), opts.kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  t.action!.run();
                  setItems((xs) => xs.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
