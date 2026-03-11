import { useAuth } from '@/shared/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { LogOut } from 'lucide-react';

interface HubHeaderProps {
  title: string;
}

export function HubHeader({ title }: HubHeaderProps) {
  const { signOut } = useAuth();

  return (
    <header className="flex justify-between items-center h-14 px-6 border-b border-slate-200 bg-white">
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      <Button variant="ghost" size="sm" onClick={() => signOut()}>
        <LogOut className="h-4 w-4" />
        Logout
      </Button>
    </header>
  );
}
