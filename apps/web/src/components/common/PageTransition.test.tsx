import { useEffect } from 'react';
import { act, create } from 'react-test-renderer';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { expect, it } from 'vitest';
import { PageTransition } from './PageTransition';

it('updates query location without remounting the current page layer', async () => {
  let navigate: NavigateFunction;
  let renderer: ReturnType<typeof create>;
  function Harness() {
    const go = useNavigate();
    useEffect(() => { navigate = go; }, [go]);
    return <PageTransition render={(location) => <span data-query={location.search} />} />;
  }
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={['/usage-analytics?model=A']}>
        <Harness />
      </MemoryRouter>
    );
  });
  expect(renderer!.root.findByType('span').props['data-query']).toBe('?model=A');
  await act(async () => {
    navigate!('/usage-analytics?model=all');
  });
  expect(renderer!.root.findByType('span').props['data-query']).toBe('?model=all');
  await act(async () => {
    navigate!(-1);
  });
  expect(renderer!.root.findByType('span').props['data-query']).toBe('?model=A');
  await act(async () => {
    renderer!.unmount();
  });
});
