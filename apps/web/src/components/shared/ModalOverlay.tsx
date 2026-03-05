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
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => {
        // Close on backdrop click (not card click)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: '#fff',
          padding: '20px',
          borderRadius: '10px',
          width: '92vw',
          maxWidth,
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
          margin: '16px',
        }}
      >
        <h3 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 700 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}
