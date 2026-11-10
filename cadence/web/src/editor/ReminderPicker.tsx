import { useState } from 'react';
import type { ReminderRule } from '../api/client.ts';
import { Icon } from '../components/Sheet.tsx';

export const OFFSETS: { minutes: number; label: string }[] = [
  { minutes: 0, label: 'At start' },
  { minutes: 5, label: '5 min before' },
  { minutes: 10, label: '10 min before' },
  { minutes: 15, label: '15 min before' },
  { minutes: 30, label: '30 min before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 120, label: '2 hours before' },
  { minutes: 1440, label: '1 day before' },
  { minutes: 2880, label: '2 days before' },
  { minutes: 10080, label: '1 week before' },
];

export function offsetLabel(min: number, allDay = false): string {
  if (allDay) {
    if (min === 0) return 'At midnight';
    if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'} before`;
  }
  const known = OFFSETS.find((o) => o.minutes === min);
  if (known) return known.label;
  if (min % 1440 === 0) return `${min / 1440} days before`;
  if (min % 60 === 0) return `${min / 60} hours before`;
  return `${min} min before`;
}

interface Props {
  value: ReminderRule[];
  onChange: (v: ReminderRule[]) => void;
  allDay?: boolean;
  label?: string;
}

export function ReminderPicker({ value, onChange, allDay, label = 'Reminders' }: Props) {
  const [adding, setAdding] = useState(false);
  const used = new Set(value.map((r) => r.offset_minutes));
  const sorted = [...value].sort((a, b) => a.offset_minutes - b.offset_minutes);
  return (
    <div className="reminders" role="group" aria-label={label}>
      <div className="chips">
        {sorted.map((r) => (
          <span key={r.offset_minutes} className="chip">
            <Icon name="bell" size={16} />
            {offsetLabel(r.offset_minutes, allDay)}
            <button type="button" className="chip-x" aria-label={`Remove reminder ${offsetLabel(r.offset_minutes, allDay)}`} onClick={() => onChange(value.filter((x) => x.offset_minutes !== r.offset_minutes))}>
              <Icon name="close" size={14} />
            </button>
          </span>
        ))}
        {!adding && value.length < 10 && (
          <button type="button" className="chip chip-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add reminder
          </button>
        )}
      </div>
      {adding && (
        <div className="chips choose" role="listbox" aria-label="Reminder time">
          {OFFSETS.filter((o) => !used.has(o.minutes)).map((o) => (
            <button
              key={o.minutes}
              type="button"
              role="option"
              aria-selected="false"
              className="chip"
              onClick={() => {
                onChange([...value, { offset_minutes: o.minutes }]);
                setAdding(false);
              }}
            >
              {offsetLabel(o.minutes, allDay)}
            </button>
          ))}
          <button type="button" className="text-btn" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
