import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useDownload } from './useDownload';

const getDownloadUrl = vi.fn<(id: string, projectId?: string) => Promise<string>>();

vi.mock('../api/documents', () => ({
  getDownloadUrl: (id: string, projectId?: string) => getDownloadUrl(id, projectId),
}));

const open = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('open', open);
});

afterEach(() => vi.unstubAllGlobals());

describe('useDownload', () => {
  it('opens the presigned link in a new tab, severing the opener', async () => {
    getDownloadUrl.mockResolvedValue('https://storage.example/presigned');
    const { result } = renderHook(() => useDownload());

    await act(() => result.current.start('d1'));

    expect(getDownloadUrl).toHaveBeenCalledWith('d1', undefined);
    expect(open).toHaveBeenCalledWith('https://storage.example/presigned', '_blank', 'noopener');
  });

  it('passes the project through so the API can scope the read', async () => {
    getDownloadUrl.mockResolvedValue('https://storage.example/presigned');
    const { result } = renderHook(() => useDownload());

    await act(() => result.current.start('d1', '10001'));

    expect(getDownloadUrl).toHaveBeenCalledWith('d1', '10001');
  });

  it('names the row being prepared, and clears it when the press finishes', async () => {
    let release: (url: string) => void = () => undefined;
    getDownloadUrl.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { result } = renderHook(() => useDownload());

    let pressed: Promise<void>;
    act(() => {
      pressed = result.current.start('d1');
    });
    await waitFor(() => expect(result.current.busyId).toBe('d1'));

    await act(async () => {
      release('https://storage.example/presigned');
      await pressed;
    });

    expect(result.current.busyId).toBeNull();
  });

  it('ignores a second press while one is still in flight', async () => {
    let release: (url: string) => void = () => undefined;
    getDownloadUrl.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { result } = renderHook(() => useDownload());

    let first: Promise<void>;
    act(() => {
      first = result.current.start('d1');
    });
    await waitFor(() => expect(result.current.busyId).toBe('d1'));
    await act(() => result.current.start('d2'));

    expect(getDownloadUrl).toHaveBeenCalledTimes(1);

    await act(async () => {
      release('https://storage.example/presigned');
      await first;
    });
  });

  it('shows the reason the API gave', async () => {
    getDownloadUrl.mockRejectedValue(new Error('You do not have permission to download this document.'));
    const { result } = renderHook(() => useDownload());

    await act(() => result.current.start('d1'));

    expect(result.current.error).toBe('You do not have permission to download this document.');
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to a plain message when the failure carries none', async () => {
    getDownloadUrl.mockRejectedValue('nope');
    const { result } = renderHook(() => useDownload());

    await act(() => result.current.start('d1'));

    expect(result.current.error).toBe('Could not prepare the download.');
  });

  it('frees the control after a failure, so the reader can try again', async () => {
    getDownloadUrl.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useDownload());

    await act(() => result.current.start('d1'));
    expect(result.current.busyId).toBeNull();

    getDownloadUrl.mockResolvedValue('https://storage.example/presigned');
    await act(() => result.current.start('d1'));

    expect(result.current.error).toBeNull();
    expect(open).toHaveBeenCalledOnce();
  });

  it('does nothing without a document id', async () => {
    const { result } = renderHook(() => useDownload());

    await act(() => result.current.start(''));

    expect(getDownloadUrl).not.toHaveBeenCalled();
  });
});
