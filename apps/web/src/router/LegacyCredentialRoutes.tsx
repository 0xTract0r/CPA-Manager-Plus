import { Navigate, useLocation, type RouteObject } from 'react-router-dom';
import { isDemoRoutePath, prefixRouteBase } from '@/features/demo/demoMode';

function LegacyCredentialRedirect({ editor }: { editor?: 'alias' | 'excluded' }) {
  const { pathname, search } = useLocation();
  const target = isDemoRoutePath(pathname) ? prefixRouteBase('/accounts') : '/accounts';
  if (!editor) return <Navigate to={target} replace />;

  const provider = new URLSearchParams(search).get('provider')?.trim();
  const params = new URLSearchParams({ view: 'oauth', editor });
  if (provider) params.set('editorProvider', provider);
  return <Navigate to={{ pathname: target, search: `?${params}` }} replace />;
}

export const legacyCredentialRoutes: RouteObject[] = [
  { path: '/auth-files', element: <LegacyCredentialRedirect /> },
  {
    path: '/auth-files/oauth-model-alias',
    element: <LegacyCredentialRedirect editor="alias" />,
  },
  {
    path: '/auth-files/oauth-excluded',
    element: <LegacyCredentialRedirect editor="excluded" />,
  },
];
