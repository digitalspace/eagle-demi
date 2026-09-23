import { describe, expect, it, vi } from 'vitest';
import { useCallback, useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AccountMenu } from '../shell/AccountMenu';
import { useDismissable } from './use-dismissable';

function Panel({ name, overMap = false }: { name: string; overMap?: boolean }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const onClose = useCallback(() => setOpen(false), []);
  // Grid callers pass no options, so the default-off case must too.
  const options = overMap ? { swallowClosingClick: true } : undefined;
  useDismissable(open, panelRef, toggleRef, onClose, options);

  return (
    <div ref={panelRef}>
      <button type="button" ref={toggleRef} aria-expanded={open} onClick={() => setOpen(!open)}>
        {name}
      </button>
      {open && <input aria-label={`${name} field`} />}
    </div>
  );
}

const toggle = (name: string) => screen.getByRole('button', { name });

/** Opens a panel from the keyboard, which presses nothing outside the panels already open. */
async function openByKeyboard(user: ReturnType<typeof userEvent.setup>, name: string) {
  toggle(name).focus();
  await user.keyboard('{Enter}');
}

describe('useDismissable', () => {
  it('closes only the panel opened last when two are open', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Panel name="First" />
        <Panel name="Second" />
      </>,
    );
    await openByKeyboard(user, 'First');
    await openByKeyboard(user, 'Second');

    await user.keyboard('{Escape}');

    expect(toggle('Second')).toHaveAttribute('aria-expanded', 'false');
    expect(toggle('First')).toHaveAttribute('aria-expanded', 'true');
  });

  it('hands focus back to the toggle when focus was inside the panel', async () => {
    const user = userEvent.setup();
    render(<Panel name="Layers" />);
    await user.click(toggle('Layers'));
    await user.click(screen.getByRole('textbox', { name: 'Layers field' }));

    await user.keyboard('{Escape}');

    expect(toggle('Layers')).toHaveFocus();
  });

  it('leaves focus where it is when it was outside the panel', async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="Search" />
        <Panel name="Layers" />
      </>,
    );
    await openByKeyboard(user, 'Layers');
    screen.getByRole('textbox', { name: 'Search' }).focus();

    await user.keyboard('{Escape}');

    expect(toggle('Layers')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus();
  });

  it('keeps the press that closed a map panel from reaching what sat behind it', async () => {
    const user = userEvent.setup();
    const behind = vi.fn();
    render(
      <>
        <div data-testid="behind" />
        <Panel name="Layers" overMap />
      </>,
    );
    screen.getByTestId('behind').addEventListener('click', behind);
    await user.click(toggle('Layers'));

    await user.click(screen.getByTestId('behind'));

    expect(toggle('Layers')).toHaveAttribute('aria-expanded', 'false');
    expect(behind).not.toHaveBeenCalled();
  });

  it('lets the press that closed a panel through by default, so a grid row still acts', async () => {
    const user = userEvent.setup();
    const row = vi.fn();
    render(
      <>
        <div data-testid="row" />
        <Panel name="Columns" />
      </>,
    );
    screen.getByTestId('row').addEventListener('click', row);
    await user.click(toggle('Columns'));

    await user.click(screen.getByTestId('row'));

    expect(toggle('Columns')).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveBeenCalledTimes(1);
  });

  it('lets the next press through once a map panel is closed', async () => {
    const user = userEvent.setup();
    const behind = vi.fn();
    render(
      <>
        <div data-testid="behind" />
        <Panel name="Layers" overMap />
      </>,
    );
    screen.getByTestId('behind').addEventListener('click', behind);
    await user.click(toggle('Layers'));
    await user.click(screen.getByTestId('behind'));

    await user.click(screen.getByTestId('behind'));

    expect(behind).toHaveBeenCalledTimes(1);
  });

  it('still acts on a control pressed outside, so another toggle opens in one press', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Panel name="First" />
        <Panel name="Second" />
      </>,
    );
    await user.click(toggle('First'));

    await user.click(toggle('Second'));

    expect(toggle('First')).toHaveAttribute('aria-expanded', 'false');
    expect(toggle('Second')).toHaveAttribute('aria-expanded', 'true');
  });

  it('gives Escape to a menu opened after a panel, then to the panel', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Panel name="Layers" overMap />
        <AccountMenu />
      </MemoryRouter>,
    );
    await openByKeyboard(user, 'Layers');
    await openByKeyboard(user, 'Account menu');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(toggle('Layers')).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');

    expect(toggle('Layers')).toHaveAttribute('aria-expanded', 'false');
  });

  it('ignores the Escape that ends an IME composition', async () => {
    const user = userEvent.setup();
    render(<Panel name="Layers" />);
    await user.click(toggle('Layers'));
    const field = screen.getByRole('textbox', { name: 'Layers field' });

    fireEvent.keyDown(field, { key: 'Escape', isComposing: true });

    expect(toggle('Layers')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(field, { key: 'Escape' });

    expect(toggle('Layers')).toHaveAttribute('aria-expanded', 'false');
  });
});
