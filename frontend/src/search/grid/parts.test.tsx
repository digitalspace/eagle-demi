import { describe, expect, it } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GridColumn } from '../grid-types';
import { ChipRow, FilterRow, type GridChip } from './parts';

/** Past the typeahead threshold, so the picker offers its type-to-narrow box. */
const OPTIONS = Array.from({ length: 41 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` }));

const COLUMN: GridColumn<Record<string, unknown>> = { key: 'type', label: 'Type', filter: 'values', options: OPTIONS };

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
