import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { comboClamp, comboOptions, comboStep, noMatchText, type RecordProject } from './record-header';
import './chart-controls.css';

const INPUT_ID = 'rec-pick';
const LIST_ID = 'rec-list';

/** "Open a project record": one option per project; arrows move without loading, Enter or a click opens. */
export function RecordPicker({
  projects,
  currentId,
  onPick,
}: {
  projects: readonly RecordProject[];
  currentId: string;
  onPick: (projectId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const options = useMemo(() => comboOptions(projects, query, currentId), [projects, query, currentId]);
  const at = comboClamp(active, options.length);
  const activeId = open ? options[at]?.id : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const choose = (projectId: string) => {
    setQuery('');
    setOpen(false);
    setActive(0);
    onPick(projectId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const { key } = event;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
      } else setActive(comboStep(at, options.length, key === 'ArrowDown'));
    } else if (key === 'Enter') {
      if (open && options.length) {
        event.preventDefault();
        choose(options[at].projectId);
      }
    } else if (key === 'Escape') {
      if (open) setOpen(false);
      else if (query) setQuery('');
    }
  };

  return (
    <div className="wp-rec-cb">
      <label htmlFor={INPUT_ID} className="wp-rec-cb__label">
        Open a project record
      </label>
      <div className="wp-field wp-rec-cb__field">
        <input
          id={INPUT_ID}
          className="wp-field__input"
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={LIST_ID}
          aria-activedescendant={activeId}
          placeholder="Name or project number"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onClick={() => {
            setOpen((was) => !was);
            setActive(0);
          }}
          onBlur={() => setOpen(false)}
        />
      </div>
      <ul id={LIST_ID} className="wp-rec-cb__list" role="listbox" aria-label="Projects" hidden={!open}>
        {open &&
          options.map((option, i) => (
            <li
              key={option.id}
              id={option.id}
              className={`wp-option wp-rec-cb__option${option.current ? ' wp-option--current' : ''}`}
              role="option"
              aria-selected={i === at}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option.projectId);
              }}
            >
              <span className="wp-option__text">
                <span className="wp-option__label">{option.label}</span>
                <span className="wp-option__sub">{option.sub}</span>
              </span>
            </li>
          ))}
        {open && !options.length && (
          <li className="wp-rec-cb__none" role="presentation">
            {noMatchText(query)}
          </li>
        )}
      </ul>
    </div>
  );
}
