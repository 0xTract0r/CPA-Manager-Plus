import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageServiceApi, type UsageCatchUpStatusResponse } from '@/services/api/usageService';
import { useUsageCatchUpStatus, type UseUsageCatchUpStatusReturn } from './useUsageCatchUpStatus';

vi.mock('@/services/api/usageService', async () => {
  const actual = await vi.importActual<typeof import('@/services/api/usageService')>(
    '@/services/api/usageService'
  );
  return {
    ...actual,
    usageServiceApi: {
      ...actual.usageServiceApi,
      getCatchUpStatus: vi.fn(),
    },
  };
});

vi.mock('@/stores', () => ({
  useAuthStore: (selector: (state: { managementKey: string }) => unknown) =>
    selector({ managementKey: 'test-key' }),
}));

const getCatchUpStatusMock = vi.mocked(usageServiceApi.getCatchUpStatus);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useUsageCatchUpStatus', () => {
  let renderer: ReactTestRenderer | null = null;
  let latestResult: UseUsageCatchUpStatusReturn | null = null;

  function Harness(props: { serviceBase: string; enabled: boolean }) {
    const result = useUsageCatchUpStatus({
      serviceBase: props.serviceBase,
      enabled: props.enabled,
      refreshIntervalMs: null,
    });
    useEffect(() => {
      latestResult = result;
    }, [result]);
    return null;
  }

  beforeEach(() => {
    latestResult = null;
    getCatchUpStatusMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
  });

  it('does not call the API when disabled or serviceBase is empty', async () => {
    await act(async () => {
      renderer = create(<Harness serviceBase="" enabled={true} />);
    });
    expect(getCatchUpStatusMock).not.toHaveBeenCalled();
    expect(latestResult?.found).toBe(false);
    expect(latestResult?.status).toBeNull();
  });

  it('loads and surfaces a found status', async () => {
    const response: UsageCatchUpStatusResponse = {
      found: true,
      status: {
        lastRunAtMs: 1_800_000_000_000,
        lastAdded: 12,
        lastStatus: 'ok',
        totalAdded: 4821,
        trigger: 'timer',
      },
    };
    getCatchUpStatusMock.mockResolvedValueOnce(response);

    await act(async () => {
      renderer = create(<Harness serviceBase="http://manager.local" enabled={true} />);
    });

    expect(getCatchUpStatusMock).toHaveBeenCalledWith('http://manager.local', 'test-key');
    expect(latestResult?.found).toBe(true);
    expect(latestResult?.status?.lastAdded).toBe(12);
  });

  it('keeps the previous status and does not throw when the request fails', async () => {
    getCatchUpStatusMock.mockRejectedValueOnce(new Error('network error'));

    await act(async () => {
      renderer = create(<Harness serviceBase="http://manager.local" enabled={true} />);
    });

    expect(latestResult?.found).toBe(false);
    expect(latestResult?.status).toBeNull();
    expect(latestResult?.loading).toBe(false);
  });
});
