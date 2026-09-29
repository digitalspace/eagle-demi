import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GridColumn, ValueOption } from '../grid-types';
import { AdvancedFilters, ChipRow, FilterRow, type GridChip } from './parts';

/** Past the typeahead threshold, so the picker offers its type-to-narrow box. */
const OPTIONS = Array.from({ length: 41 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` }));

const COLUMN: GridColumn<Record<string, unknown>> = { key: 'type', label: 'Type', filter: 'values', options: OPTIONS };

/** One term under both Acts: the same label, a different id per Act. The older Act comes first on purpose. */
const BOTH_ACTS: ValueOption[] = [
  { value: 'p02', label: 'Proponent', legislation: '2002' },
  { value: 'p18', label: 'Proponent', legislation: '2018' },
];
const AUTHOR: GridColumn<Record<string, unknown>> = { key: 'author', label: 'Author', filter: 'values', options: BOTH_ACTS };

function renderRow(column: GridColumn<Record<string, unknown>>, selected: string[] = [], onChange = vi.fn()) {
  render(
    <table>
      <thead>
        <FilterRow columns={[column]} values={{ [column.key]: selected }} onChange={onChange} />
      </thead>
    </table>,
  );
  return onChange;
}

/** Past the typeahead threshold: plain terms, then as many under each Act, one 2002 term named apart. */
const ACT_TERMS = 11;
const MANY_ACTS: GridColumn<Record<string, unknown>> = {
  ...AUTHOR,
  options: [
    ...Array.from({ length: 20 }, (_, index) => ({ value: `n${index}`, label: `Plain ${index}` })),
    ...Array.from({ length: ACT_TERMS }, (_, index) => ({ value: `a${index}`, label: `Term ${index}`, legislation: '2018' })),
    ...Array.from({ length: ACT_TERMS - 1 }, (_, index) => ({ value: `b${index}`, label: `Term ${index}`, legislation: '2002' })),
    { value: 'legacy', label: 'Legacy', legislation: '2002' },
  ],
};

function renderPanel(options: ValueOption[], picked = '') {
  render(
    <AdvancedFilters
      fields={[{ id: 'author', label: 'Author', kind: 'select', options }]}
      values={picked ? { author: picked } : {}}
      open
      onChange={() => undefined}
    />,
  );
}

/** Whether `later` comes after `earlier` in the page. */
const follows = (earlier: Element, later: Element) =>
  (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('ValuePicker', () => {
  it('starts each opening with every option, not the last narrowing', async () => {
    const user = userEvent.setup();
    render(
      <table>
        <thead>
          <FilterRow columns={[COLUMN]} values={{}} onChange={() => undefined} />
        </thead>
      </table>,
    );
    const toggle = screen.getByRole('button', { name: 'Filter by Type' });

    await user.click(toggle);
    await user.type(screen.getByRole('textbox', { name: 'Search type' }), 'Option 4');
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    await user.click(toggle);
    await user.click(toggle);

    expect(screen.getByRole('textbox', { name: 'Search type' })).toHaveValue('');
    expect(screen.getAllByRole('checkbox')).toHaveLength(41);
  });

  it('lists a term under each Act that holds it, newest Act first, and picks that Act\'s id', async () => {
    const user = userEvent.setup();
    const onChange = renderRow(AUTHOR);

    await user.click(screen.getByRole('button', { name: 'Filter by Author' }));
    const newer = screen.getByRole('group', { name: '2018 Act Terms' });
    const older = screen.getByRole('group', { name: '2002 Act Terms' });
    expect(follows(newer, older)).toBe(true);
    await user.click(within(older).getByRole('checkbox', { name: 'Proponent (2002)' }));

    expect(onChange).toHaveBeenCalledWith('author', ['p02']);
  });

  it('gives the same term under each Act its own checkbox name', async () => {
    const user = userEvent.setup();
    renderRow(AUTHOR);

    await user.click(screen.getByRole('button', { name: 'Filter by Author' }));

    expect(screen.getByRole('checkbox', { name: 'Proponent (2002)' })).not.toBe(
      screen.getByRole('checkbox', { name: 'Proponent (2018)' }),
    );
  });

  it('names the Act of a single pick on its button', () => {
    renderRow(AUTHOR, ['p18']);

    expect(within(screen.getByRole('button', { name: 'Filter by Author' })).getByText('Proponent (2018)')).toBeInTheDocument();
  });

  it('names every pick with its Act in the button title', () => {
    renderRow(AUTHOR, ['p02', 'p18']);

    const button = screen.getByRole('button', { name: 'Filter by Author' });
    expect(within(button).getByText('2 selected')).toBeInTheDocument();
    expect(button).toHaveAttribute('title', 'Proponent (2002), Proponent (2018)');
  });

  it('narrows to one Act when its year is typed', async () => {
    const user = userEvent.setup();
    renderRow(MANY_ACTS);

    await user.click(screen.getByRole('button', { name: 'Filter by Author' }));
    await user.type(screen.getByRole('textbox', { name: 'Search author' }), '2018');

    const newer = screen.getByRole('group', { name: '2018 Act Terms' });
    expect(within(newer).getAllByRole('checkbox')).toHaveLength(ACT_TERMS);
    expect(screen.getAllByRole('checkbox')).toHaveLength(ACT_TERMS);
    expect(screen.queryByRole('group', { name: '2002 Act Terms' })).not.toBeInTheDocument();
  });

  it('drops an Act heading once typing leaves that Act no terms', async () => {
    const user = userEvent.setup();
    renderRow(MANY_ACTS);

    await user.click(screen.getByRole('button', { name: 'Filter by Author' }));
    await user.type(screen.getByRole('textbox', { name: 'Search author' }), 'Legacy');

    expect(within(screen.getByRole('group', { name: '2002 Act Terms' })).getByRole('checkbox', { name: 'Legacy (2002)' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByRole('group', { name: '2018 Act Terms' })).not.toBeInTheDocument();
    expect(screen.queryByText('2018 Act Terms')).not.toBeInTheDocument();
  });
});

describe('AdvancedFilters', () => {
  it('groups a select\'s terms by Act, newest Act first', () => {
    renderPanel(BOTH_ACTS);
    const newer = screen.getByRole('group', { name: '2018 Act Terms' });
    const older = screen.getByRole('group', { name: '2002 Act Terms' });

    expect(follows(newer, older)).toBe(true);
    expect(within(newer).getByRole('option', { name: 'Proponent (2018)' })).toHaveValue('p18');
    expect(within(older).getByRole('option', { name: 'Proponent (2002)' })).toHaveValue('p02');
  });

  it('shows the picked term with its Act while the select is closed', () => {
    renderPanel(BOTH_ACTS, 'p02');

    expect(screen.getByRole('combobox', { name: 'Author' })).toHaveDisplayValue('Proponent (2002)');
  });

  it('lists the terms with no Act ahead of the Act groups, as the picker does', () => {
    renderPanel([...BOTH_ACTS, { value: 'other', label: 'Other' }]);

    const other = screen.getByRole('option', { name: 'Other' });
    expect(follows(other, screen.getByRole('group', { name: '2018 Act Terms' }))).toBe(true);
    expect(other.closest('optgroup')).toBeNull();
  });
});

describe('ChipRow', () => {
  const chip = (value: string): GridChip => ({ id: 'type', label: 'Type', value });

  it('forgets a press whose removal left as many chips, so a later drop moves no focus', async () => {
    const user = userEvent.setup();
    const fallback = createRef<HTMLElement>();
    const row = (chips: GridChip[], onRemove: () => void = () => undefined) => (
      <ChipRow chips={chips} onRemove={onRemove} onClearAll={() => undefined} fallbackFocus={fallback} />
    );
    // The removal swaps the pressed chip for another, as a relabelled pick would.
    const { rerender } = render(row([chip('a'), chip('b')], (): void => rerender(row([chip('c'), chip('b')]))));

    await user.click(screen.getByRole('button', { name: 'Remove Type a' }));
    rerender(row([chip('c')]));

    expect(screen.getByRole('button', { name: 'Remove Type c' })).not.toHaveFocus();
  });
});
