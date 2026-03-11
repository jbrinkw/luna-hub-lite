import type { ReactNode } from 'react';
import { HubHeader } from './HubHeader';
import { SideNav } from './SideNav';
import { ModuleSwitcher } from '../ModuleSwitcher';

interface HubLayoutProps {
  title: string;
  children: ReactNode;
}

export function HubLayout({ title, children }: HubLayoutProps) {
  return (
    <div className="min-h-screen bg-slate-50">
      <HubHeader title={title} />
      <div className="px-6 py-2 border-b border-slate-200 bg-white">
        <ModuleSwitcher />
      </div>
      <div className="flex min-h-[calc(100vh-theme(spacing.14)-theme(spacing.14))]">
        <aside className="hidden md:block w-60 border-r border-slate-200 bg-white">
          <SideNav />
        </aside>
        <main className="flex-1 p-6 max-w-4xl">{children}</main>
      </div>
    </div>
  );
}
