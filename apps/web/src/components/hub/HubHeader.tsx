import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { ArrowLeft, LogOut } from 'lucide-react';

interface HubHeaderProps {
  title: string;
  children?: ReactNode;
}

export function HubHeader({ title, children }: HubHeaderProps) {
  const { signOut } = useAuth();

  return (
    <header className="flex justify-between items-center h-14 px-4 sm:px-6 border-b border-border bg-surface">
      <div className="flex items-center gap-2">
        <Link
          to="/hub"
          className="text-text-tertiary hover:text-text-secondary transition-colors"
          aria-label="Back to Hub"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-semibold text-text">{title}</h1>
      </div>
      <div className="flex items-center gap-2.5">
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={() => signOut()} className="hidden md:inline-flex">
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
        {children}
      </div>
    </header>
  );
}
