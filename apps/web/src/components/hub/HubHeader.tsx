import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { ArrowLeft, LogOut } from 'lucide-react';

interface HubHeaderProps {
  title: string;
  children?: ReactNode;
}

export function HubHeader({ title, children }: HubHeaderProps) {
  const { signOut } = useAuth();

  return (
    <header className="flex justify-between items-center h-14 px-4 sm:px-6 border-b border-slate-200 bg-white">
      <div className="flex items-center gap-2">
        <Link to="/hub" className="text-slate-400 hover:text-slate-600 transition-colors" aria-label="Back to Hub">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      </div>
      <div className="flex items-center gap-2.5">
        <Button variant="ghost" size="sm" onClick={() => signOut()} className="hidden md:inline-flex">
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
        {children}
      </div>
    </header>
  );
}
