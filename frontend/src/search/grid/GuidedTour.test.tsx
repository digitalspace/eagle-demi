import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { GuidedTour } from './GuidedTour';

/**
 * A page with one stand-in control per `data-tour` key and a button that starts the tour. The
 * controls on the page come from `targets`, so a rerender can take one away mid-walk, which is
 * what a breakpoint or a tab switch does. `tourAllowed` lets a rerender unmount the tour without
 * the tour ending itself, as a route change would.
 */
function Page({
  targets,
  tourAllowed = true,
  onEnd,
}: {
  targets: string[];
  tourAllowed?: boolean;
  onEnd?: () => void;
}) {
  const opener = useRef<HTMLButtonElement>(null);
  const [touring, setTouring] = useState(false);
  return (
    <div>
      <button ref={opener} type="button" onClick={() => setTouring(true)}>
        Take the tour
      </button>
      {targets.map((target) => (
        <div key={target} data-tour={target}>
          {`${target} control`}
        </div>
      ))}
      {touring && tourAllowed && (
        <GuidedTour
          opener={opener}
          onEnd={() => {
            setTouring(false);
            onEnd?.();
          }}
        />
      )}
    </div>
  );
}

const ALL = ['search', 'types', 'more'];

async function startTour(targets: string[] = ALL) {
  const user = userEvent.setup();
  const view = render(<Page targets={targets} />);
  await user.click(screen.getByRole('button', { name: 'Take the tour' }));
  return { user, ...view };
}

/** The visible "Step N of M" line; the live region repeats it with the title after a full stop. */
const counter = (text: string) => screen.getByText(text, { selector: '.display-grid__tour-count' });

/** What takes a control away under the reader: a breakpoint change, reported as a resize. */
function relayout() {
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const control = (target: string) => document.querySelector(`[data-tour="${target}"]`);

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn(function ResizeObserver() {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GuidedTour', () => {
  it('counts only the steps this page can show, skipping the ones it cannot', async () => {
    await startTour();

    expect(screen.getByRole('dialog', { name: 'One search box' })).toBeInTheDocument();
    expect(counter('Step 1 of 3')).toBeInTheDocument();
  });

  it('walks forward past controls that are not on the page, and back again', async () => {
    const { user } = await startTour();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Pick a record type' })).toBeInTheDocument();
    expect(counter('Step 2 of 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Filters that are not columns' })).toBeInTheDocument();
    expect(counter('Step 3 of 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Pick a record type' })).toBeInTheDocument();
    expect(counter('Step 2 of 3')).toBeInTheDocument();
  });

  it('offers no way back from the first step', async () => {
    await startTour();

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('turns Next into Done on the last step, and Done ends the tour', async () => {
    const onEnd = vi.fn();
    const user = userEvent.setup();
    render(<Page targets={['search', 'types']} onEnd={onEnd} />);
    await user.click(screen.getByRole('button', { name: 'Take the tour' }));

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onEnd).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hands the slot of a control that goes mid-walk to the control after it', async () => {
    const { user, rerender } = await startTour();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Pick a record type' })).toBeInTheDocument();

    rerender(<Page targets={['search', 'more']} />);
    relayout();

    expect(screen.getByRole('dialog', { name: 'Filters that are not columns' })).toBeInTheDocument();
    expect(counter('Step 2 of 2')).toBeInTheDocument();
  });

  it('ends the walk on Next when the only control after this one has gone', async () => {
    const { user, rerender } = await startTour();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(counter('Step 2 of 3')).toBeInTheDocument();

    rerender(<Page targets={['search', 'types']} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ends the tour and hands focus back when every control has gone', async () => {
    const { rerender } = await startTour();

    rerender(<Page targets={[]} />);
    relayout();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take the tour' })).toHaveFocus();
  });

  it('ends at once on a page with none of its controls', async () => {
    const onEnd = vi.fn();
    const user = userEvent.setup();
    render(<Page targets={[]} onEnd={onEnd} />);

    await user.click(screen.getByRole('button', { name: 'Take the tour' }));

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const { user } = await startTour();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('puts focus on the card when it opens', async () => {
    await startTour();

    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('leaves focus on the button the reader is on when the page is resized', async () => {
    await startTour();
    const next = screen.getByRole('button', { name: 'Next' });
    next.focus();

    relayout();

    expect(next).toHaveFocus();
  });

  it('puts focus back on the card when the walk moves', async () => {
    const { user } = await startTour();

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('hands focus back to the control that started it when skipped', async () => {
    const { user } = await startTour();

    await user.click(screen.getByRole('button', { name: 'Skip tour' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take the tour' })).toHaveFocus();
  });

  it('keeps Tab inside the card, so the last control wraps to the first and back', async () => {
    const { user } = await startTour();
    const skip = screen.getByRole('button', { name: 'Skip tour' });
    const next = screen.getByRole('button', { name: 'Next' });
    next.focus();

    await user.tab();
    expect(skip).toHaveFocus();

    await user.tab({ shift: true });
    expect(next).toHaveFocus();
  });

  it('makes the page inert bar the tour and the control the step is lighting', async () => {
    const { user } = await startTour();

    expect(control('search')).not.toHaveAttribute('inert');
    expect(control('types')).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Take the tour' })).toHaveAttribute('inert');
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(control('search')).toHaveAttribute('inert');
    expect(control('types')).not.toHaveAttribute('inert');
  });

  it('gives the page back and returns focus when the tour is unmounted mid-walk', async () => {
    const { user, rerender } = await startTour();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(document.querySelectorAll('[inert]').length).toBeGreaterThan(0);

    rerender(<Page targets={ALL} tourAllowed={false} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Take the tour' })).toHaveFocus();
  });

  it('gives back content outside its own tree when the whole page unmounts mid-walk', async () => {
    const banner = document.createElement('header');
    banner.textContent = 'Site header';
    document.body.prepend(banner);
    onTestFinished(() => banner.remove());
    const { unmount } = await startTour();
    expect(banner).toHaveAttribute('inert');

    unmount();

    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
  });

  it('leaves alone content that was inert before the tour began', async () => {
    const aside = document.createElement('aside');
    aside.setAttribute('inert', '');
    document.body.append(aside);
    onTestFinished(() => aside.remove());
    const { user } = await startTour();

    await user.click(screen.getByRole('button', { name: 'Skip tour' }));

    expect(aside).toHaveAttribute('inert');
  });
});
