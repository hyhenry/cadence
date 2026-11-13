import { useEffect } from 'react';
import type { Calendar, Info } from '../api/client.ts';
import { Icon } from '../components/Sheet.tsx';

interface Props {
  open: boolean;
  calendars: Calendar[];
  info: Info | null;
  onClose: () => void;
  onToggle: (c: Calendar) => void;
  onEdit: (c: Calendar) => void;
  onAdd: () => void;
  onSettings: () => void;
  /** Tablet layout keeps the drawer docked. */
  docked: boolean;
}

function Group({ title, items, onToggle, onEdit }: { title: string; items: Calendar[]; onToggle: Props['onToggle']; onEdit: Props['onEdit'] }) {
  if (!items.length) return null;
  return (
    <section className="drawer-group">
      <h3>{title}</h3>
      <ul>
        {items.map((c) => (
          <li key={c.entity_id} className="cal-row">
            <button
              type="button"
              className="cal-toggle"
              role="switch"
              aria-checked={c.visible}
              aria-label={`Show ${c.name}`}
              onClick={() => onToggle(c)}
              style={{ ['--cal' as string]: c.color }}
            >
              <span className={`cal-check ${c.visible ? 'on' : ''}`}>{c.visible && <Icon name="check" size={16} />}</span>
              <span className="cal-name">{c.name}</span>
              {!c.can_create && <span className="cal-badge" title="Read-only"><Icon name="lock" size={14} /></span>}
            </button>
            <button type="button" className="icon-btn small" aria-label={`${c.name} settings`} onClick={() => onEdit(c)}>
              <Icon name="more" size={20} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Drawer({ open, calendars, info, onClose, onToggle, onEdit, onAdd, onSettings, docked }: Props) {
  useEffect(() => {
    if (!open || docked) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, docked, onClose]);
  // Docked (wide screens) and hidden by the user: no panel at all.
  if (docked && !open) return null;
  const mine = calendars.filter((c) => c.can_create);
  const others = calendars.filter((c) => !c.can_create);
  return (
    <>
      {open && !docked && <div className="drawer-backdrop" onClick={onClose} />}
      <nav className={`drawer ${open ? 'open' : ''} ${docked ? 'docked' : ''}`} aria-label="Calendars" aria-hidden={!open && !docked} inert={!open && !docked ? true : undefined}>
        <div className="drawer-head">
          <span className="brand">
            <Icon name="calendar" size={22} /> Calendar
          </span>
          {!docked && (
            <button type="button" className="icon-btn" aria-label="Close menu" onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </div>
        <div className="drawer-scroll">
          {!calendars.length && <p className="muted pad">No calendars yet.</p>}
          <Group title="My calendars" items={mine} onToggle={onToggle} onEdit={onEdit} />
          <Group title="Other calendars" items={others} onToggle={onToggle} onEdit={onEdit} />
        </div>
        <div className="drawer-foot">
          <button type="button" className="btn primary block" onClick={onAdd}>
            <Icon name="plus" size={20} /> Add calendar
          </button>
          <button type="button" className="btn block" onClick={onSettings}>
            <Icon name="settings" size={20} /> Settings &amp; reminders
          </button>
          {info && <p className="muted tiny">{info.mode === 'mock' ? 'Mock Home Assistant' : `Home Assistant ${info.ha_version ?? ''}`} · {info.time_zone}</p>}
        </div>
      </nav>
    </>
  );
}
