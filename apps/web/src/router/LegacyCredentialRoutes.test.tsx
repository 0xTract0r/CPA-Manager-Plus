import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter, useLocation, useRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DemoRouteAdapter } from '@/features/demo/DemoRouteAdapter';
import { legacyCredentialRoutes } from './LegacyCredentialRoutes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Destination() {
  const { pathname, search } = useLocation();
  return <span>{pathname + search}</span>;
}

function CredentialRoutes() {
  return useRoutes([
    ...legacyCredentialRoutes,
    { path: '/accounts', element: <Destination /> },
    { path: '*', element: <Destination /> },
  ]);
}

function Harness() {
  return useRoutes([
    {
      path: '/demo/*',
      element: (
        <DemoRouteAdapter routeBase="/demo">
          <CredentialRoutes />
        </DemoRouteAdapter>
      ),
    },
    { path: '*', element: <CredentialRoutes /> },
  ]);
}

describe('legacy credential routes', () => {
  it.each([
    ['/auth-files', '/accounts'],
    ['/auth-files/oauth-model-alias?provider=claude', '/accounts?view=oauth&editor=alias&editorProvider=claude'],
    ['/auth-files/oauth-excluded?provider=vertex', '/accounts?view=oauth&editor=excluded&editorProvider=vertex'],
    ['/auth-files/oauth-excluded', '/accounts?view=oauth&editor=excluded'],
    ['/auth-files/oauth-model-alias', '/accounts?view=oauth&editor=alias'],
    ['/auth-files/oauth-excluded-models', '/auth-files/oauth-excluded-models'],
  ])('redirects %s in the regular and demo router', async (source, target) => {
    for (const base of ['', '/demo']) {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<MemoryRouter initialEntries={[base + source]}><Harness /></MemoryRouter>);
      });
      expect(renderer.root.findByType('span').children).toEqual([base + target]);
      await act(async () => renderer.unmount());
    }
  });
});
