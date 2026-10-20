import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  testId?: string;
}

// In-app dialog; native alert/confirm would block the event loop and freeze every terminal
export function Modal({ title, onClose, children, width = 'max-w-md', testId }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgb(8_6_5/0.62)] px-4 pt-[10vh] pb-[4vh] backdrop-blur-[3px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        data-testid={testId}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`aa-pop w-full ${width} overflow-hidden rounded-2xl border border-line-strong bg-elevated shadow-[0_30px_80px_-20px_rgb(0_0_0/0.7),0_0_60px_-20px_color-mix(in_srgb,var(--aa-glow)_35%,transparent)] outline-none`}
      >
        {children}
      </div>
    </div>
  );
}
