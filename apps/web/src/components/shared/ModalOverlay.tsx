import { type ReactNode, useEffect } from 'react';

interface ModalOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: string;
  testId?: string;
}

/**
 * Shared modal overlay — fixed backdrop + centered card.
 * Replaces the identical 12-line pattern duplicated across 7+ pages.
 * Supports Escape key to close and locks body scroll while open.
 */
export function ModalOverlay({ isOpen, onClose, title, children, maxWidth = '500px', testId }: ModalOverlayProps) {
  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Body scroll lock
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        // Close on backdrop click (not card click)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white p-5 rounded-xl w-[92vw] max-h-[90vh] overflow-y-auto shadow-xl m-4" style={{ maxWidth }}>
        <h3 className="m-0 mb-4 text-lg font-bold">{title}</h3>
        {children}
      </div>
    </div>
  );
}
