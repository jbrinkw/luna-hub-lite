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
  };
});

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
