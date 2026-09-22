import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useDismissable } from '../map/use-dismissable';
import { config } from '../config';
import { logout } from '../api/keycloak';
import { useSession } from '../session/session';

const ITEM_SELECTOR = '[role="menuitem"]';

function initialsOf(userName: string): string {
  const parts = userName.split(/[\s._@-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0]?.slice(0, 2) || 'BC';
  return letters.toUpperCase();
}

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { userName } = useSession();
  const c = config();

  // Navigating anywhere closes the menu, including from a link outside it.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }

  useDismissable(
    open,
    wrapper,
    chip,
    useCallback(() => setOpen(false), []),
  );

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = Array.from(wrapper.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
      if (items.length === 0) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length].focus();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const go = (to: string) => {
    setOpen(false);
    void navigate(to);
  };

  return (
    <div className="account" ref={wrapper}>
      <button
        type="button"
        ref={chip}
        className="account__chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
      >
        <span className="account__avatar">{initialsOf(userName)}</span>
        <span className="account__caret">▾</span>
      </button>
      {open && (
        <div className="account__menu" role="menu">
          <div className="account__identity">
            <div className="account__name">{userName || 'Local user'}</div>
            <div className="account__meta">{c.KEYCLOAK_REALM || 'eao-epic'} · staff</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="account__item"
            onClick={() => go('/workspace')}
          >
            My account
          </button>
          <button
            type="button"
            role="menuitem"
            className="account__item"
            onClick={() => go('/sessions')}
          >
            Active sessions
          </button>
          <button
            type="button"
            role="menuitem"
            className="account__item account__item--danger"
            onClick={() => {
              setOpen(false);
              logout();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
