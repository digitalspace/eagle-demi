import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { useGridUrlState } from './use-grid-url-state';

const DEFAULTS = { defaultSort: '-datePosted', defaultPageSize: 25 };

/** The hook and the address bar it writes, read together after every change. */
function renderAt(url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
  return renderHook(
    () => {
      const location = useLocation();
      return { grid: useGridUrlState(DEFAULTS), search: decodeURIComponent(location.search) };
    },
    { wrapper },
  );
}

describe('useGridUrlState', () => {
  it('keeps both changes when a keyword and a filter are written in the same tick', () => {
    const { result } = renderAt('/search?currentPage=2');
    act(() => {
      result.current.grid.setKeyword('dam');
      result.current.grid.setFilter('type', ['abc']);
    });
    expect(result.current.grid.state.keywords).toBe('dam');
    expect(result.current.grid.state.filters['type']).toBe('abc');
    expect(result.current.grid.state.currentPage).toBe(1);
  });

  it('reads the grid state off the query string', () => {
    const { result } = renderAt('/search?record=projects&keywords=dam&currentPage=3&pageSize=50&region=Peace,Skeena');
    const { state } = result.current.grid;
    expect(state.record).toBe('projects');
    expect(state.keywords).toBe('dam');
    expect(state.currentPage).toBe(3);
    expect(state.pageSize).toBe(50);
    expect(state.filters['region']).toEqual(['Peace', 'Skeena']);
  });

  it('writes a sort change back to the address bar', () => {
    const { result } = renderAt('/search');
    act(() => result.current.grid.setSort('name'));
    expect(result.current.search).toContain('sortBy=+name');
  });

  it('flips the direction when the same column is sorted again', () => {
    const { result } = renderAt('/search?sortBy=%2Bname');
    act(() => result.current.grid.setSort('name'));
    expect(result.current.grid.state.sortBy).toBe('-name');
  });

  it('resets to page one when a filter changes', () => {
    const { result } = renderAt('/search?currentPage=4');
    act(() => result.current.grid.setFilter('type', ['a']));
    expect(result.current.grid.state.currentPage).toBe(1);
    expect(result.current.search).toContain('type=a');
  });

  it('drops a filter the caller clears', () => {
    const { result } = renderAt('/search?type=a');
    act(() => result.current.grid.setFilter('type', null));
    expect(result.current.search).not.toContain('type=');
  });

  it('keeps the record type and page size when everything else is cleared', () => {
    const { result } = renderAt('/search?record=projects&pageSize=50&keywords=dam&type=a');
    act(() => result.current.grid.clearAll());
    const { state } = result.current.grid;
    expect(state.record).toBe('projects');
    expect(state.pageSize).toBe(50);
    expect(state.keywords).toBe('');
    expect(state.filters).toEqual({});
  });

  it('keeps the keyword and drops filters, columns and sort when the record type changes', () => {
    const { result } = renderAt('/search?keywords=dam&type=a&cols=author&sortBy=%2Bname');
    act(() => result.current.grid.setRecord('activities', { defaultSort: '-dateAdded' }));
    const { state } = result.current.grid;
    expect(state.keywords).toBe('dam');
    expect(state.filters).toEqual({});
    expect(state.hiddenColumns).toEqual([]);
    expect(state.sortBy).toBe('');
    expect(result.current.search).not.toContain('sortBy');
  });

  it('drops a chosen sort when the scope changes, leaving the order to the scope', () => {
    const { result } = renderAt('/search?keywords=dam&sortBy=%2Bname');
    act(() => result.current.grid.setScope('inside'));
    expect(result.current.search).not.toContain('sortBy');
    act(() => result.current.grid.setSort('name'));
    act(() => result.current.grid.setScope('names'));
    expect(result.current.search).not.toContain('sortBy');
  });

  it('leaves the sort unchosen when a keyword is typed, so the search ranks by relevance', () => {
    const { result } = renderAt('/search');
    act(() => result.current.grid.setKeyword('trans'));
    expect(result.current.search).toContain('keywords=trans');
    expect(result.current.search).not.toContain('sortBy');
  });

  it('keeps a chosen sort across typing and clearing the keyword', () => {
    const { result } = renderAt('/search?sortBy=-datePosted');
    act(() => result.current.grid.setKeyword('trans'));
    expect(result.current.grid.state.sortBy).toBe('-datePosted');
    act(() => result.current.grid.clearAll());
    expect(result.current.grid.state.sortBy).toBe('-datePosted');
  });

  it('flips the implicit record sort when its own column is sorted', () => {
    // The record sort is `-datePosted`, so a press asking for descending first must flip it to ascending.
    const { result } = renderAt('/search');
    act(() => result.current.grid.setSort('datePosted', '-'));
    expect(result.current.grid.state.sortBy).toBe('+datePosted');
  });
});
