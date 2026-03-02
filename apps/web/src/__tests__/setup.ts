import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import React from 'react';

// Mock Ionic React components as simple HTML wrappers (jsdom has no Custom Elements)
vi.mock('@ionic/react', () => {
  const wrap = (tag: string) =>
    React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement(tag, { ...props, ref }, children),
    );
  return {
    setupIonicReact: vi.fn(),
    IonApp: wrap('div'),
    IonPage: wrap('div'),
    IonContent: wrap('div'),
    IonHeader: wrap('header'),
    IonToolbar: wrap('div'),
    IonTitle: wrap('h1'),
    IonCard: wrap('div'),
    IonCardHeader: wrap('div'),
    IonCardTitle: wrap('h2'),
    IonCardContent: wrap('div'),
    IonItem: wrap('div'),
    IonInput: React.forwardRef(({ label, value, onIonInput, type, labelPlacement, autocomplete, required, ...props }: any, ref: any) =>
      React.createElement('div', null,
        React.createElement('label', { htmlFor: label }, label),
        React.createElement('input', {
          ref,
          id: label,
          'aria-label': label,
          type: type ?? 'text',
          value: value ?? '',
          autoComplete: autocomplete,
          onChange: (e: any) => onIonInput?.({ detail: { value: e.target.value } }),
          ...props,
        }),
      ),
    ),
    IonButton: React.forwardRef(({ children, expand, ...props }: any, ref: any) =>
      React.createElement('button', { ...props, ref }, children),
    ),
    IonText: wrap('span'),
    IonLoading: ({ isOpen, message }: any) =>
      isOpen ? React.createElement('div', null, message) : null,
    IonButtons: wrap('div'),
    IonIcon: ({ icon, ...props }: any) => React.createElement('span', props),
    IonLabel: wrap('label'),
    IonList: wrap('div'),
    IonGrid: wrap('div'),
    IonRow: wrap('div'),
    IonCol: wrap('div'),
    IonSegment: ({ children, value, onIonChange, ...props }: any) =>
      React.createElement('div', { role: 'tablist', ...props }, children),
    IonSegmentButton: ({ children, value, ...props }: any) =>
      React.createElement('button', { role: 'tab', 'data-value': value, ...props }, children),
    IonToggle: React.forwardRef(({ checked, onIonChange, ...props }: any, ref: any) =>
      React.createElement('input', {
        ref,
        type: 'checkbox',
        checked: checked ?? false,
        onChange: (e: any) => onIonChange?.({ detail: { checked: e.target.checked } }),
        ...props,
      }),
    ),
    IonSelect: React.forwardRef(({ children, value, onIonChange, label, placeholder, ...props }: any, ref: any) =>
      React.createElement('div', null,
        label && React.createElement('label', { htmlFor: label }, label),
        React.createElement('select', {
          ref,
          id: label,
          value: value ?? '',
          onChange: (e: any) => onIonChange?.({ detail: { value: e.target.value } }),
          ...props,
        }, children),
      ),
    ),
    IonSelectOption: ({ children, value, ...props }: any) =>
      React.createElement('option', { value, ...props }, children),
    IonAlert: ({ isOpen, header, message, buttons, onDidDismiss }: any) =>
      isOpen ? React.createElement('div', { role: 'alertdialog', 'aria-label': header },
        React.createElement('p', null, message),
        buttons?.map((btn: any, i: number) =>
          React.createElement('button', {
            key: i,
            onClick: () => {
              if (typeof btn === 'string') { onDidDismiss?.(); }
              else { btn.handler?.(); onDidDismiss?.(); }
            },
          }, typeof btn === 'string' ? btn : btn.text),
        ),
      ) : null,
    IonSpinner: () => React.createElement('ion-spinner', { 'aria-label': 'loading' }),
    IonChip: wrap('span'),
    IonNote: wrap('span'),
    IonTextarea: React.forwardRef(({ label, value, onIonInput, ...props }: any, ref: any) =>
      React.createElement('div', null,
        label && React.createElement('label', { htmlFor: label }, label),
        React.createElement('textarea', {
          ref,
          id: label,
          value: value ?? '',
          onChange: (e: any) => onIonInput?.({ detail: { value: e.target.value } }),
          ...props,
        }),
      ),
    ),
  };
});

// Mock ionicons
vi.mock('ionicons/icons', () => new Proxy({}, { get: (_t, prop) => prop }));

// Mock Supabase client for unit tests
vi.mock('@/shared/supabase', () => {
  const mockFrom = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  }));

  return {
    supabase: {
      from: mockFrom,
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
        onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
        signInWithPassword: vi.fn(),
        signUp: vi.fn(),
        signOut: vi.fn(),
      },
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      })),
      removeChannel: vi.fn(),
    },
  };
});
