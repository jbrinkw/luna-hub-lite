import { Navigate } from 'react-router-dom';

export function WalmartPage() {
  return <Navigate to="/chef/settings?tab=walmart" replace />;
}
