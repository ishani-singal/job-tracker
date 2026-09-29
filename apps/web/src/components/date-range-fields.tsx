'use client';

const MONTHS = [
  { value: '', label: 'Month' },
  { value: '1', label: 'Jan' },
  { value: '2', label: 'Feb' },
  { value: '3', label: 'Mar' },
  { value: '4', label: 'Apr' },
  { value: '5', label: 'May' },
  { value: '6', label: 'Jun' },
  { value: '7', label: 'Jul' },
  { value: '8', label: 'Aug' },
  { value: '9', label: 'Sep' },
  { value: '10', label: 'Oct' },
  { value: '11', label: 'Nov' },
  { value: '12', label: 'Dec' },
];

export interface DateRangeFormState {
  location: string;
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
  isPresent: boolean;
}

export const EMPTY_DATE_RANGE: DateRangeFormState = {
  location: '',
  startMonth: '',
  startYear: '',
  endMonth: '',
  endYear: '',
  isPresent: false,
};

export function dateRangeToPayload(form: DateRangeFormState) {
  return {
    location: form.location || undefined,
    startMonth: form.startMonth ? Number(form.startMonth) : undefined,
    startYear: form.startYear ? Number(form.startYear) : undefined,
    endMonth: form.isPresent || !form.endMonth ? undefined : Number(form.endMonth),
    endYear: form.isPresent || !form.endYear ? undefined : Number(form.endYear),
    isPresent: form.isPresent,
  };
}

export function DateRangeFields<T extends DateRangeFormState>({
  form,
  onChange,
}: {
  form: T;
  onChange: (form: T) => void;
}) {
  return (
    <>
      <input
        className="border rounded px-2 py-1 text-sm bg-transparent col-span-2"
        placeholder="Location"
        value={form.location}
        onChange={(e) => onChange({ ...form, location: e.target.value })}
      />
      <div className="col-span-4 grid grid-cols-4 gap-2 items-center">
        <select
          className="border rounded px-2 py-1 text-sm bg-transparent"
          value={form.startMonth}
          onChange={(e) => onChange({ ...form, startMonth: e.target.value })}
        >
          {MONTHS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <input
          className="border rounded px-2 py-1 text-sm bg-transparent"
          placeholder="Start year"
          value={form.startYear}
          onChange={(e) => onChange({ ...form, startYear: e.target.value })}
        />
        {form.isPresent ? (
          <div className="col-span-2 flex items-center text-xs opacity-60 px-2">
            Present
          </div>
        ) : (
          <>
            <select
              className="border rounded px-2 py-1 text-sm bg-transparent"
              value={form.endMonth}
              onChange={(e) => onChange({ ...form, endMonth: e.target.value })}
            >
              {MONTHS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <input
              className="border rounded px-2 py-1 text-sm bg-transparent"
              placeholder="End year"
              value={form.endYear}
              onChange={(e) => onChange({ ...form, endYear: e.target.value })}
            />
          </>
        )}
      </div>
      <label className="col-span-4 flex items-center gap-1 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={form.isPresent}
          onChange={(e) => onChange({ ...form, isPresent: e.target.checked })}
        />
        Present (ongoing)
      </label>
    </>
  );
}

const MONTH_ABBR = [
  '',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatEntryDateRange(entry: {
  startMonth: number | null;
  startYear: number | null;
  endMonth: number | null;
  endYear: number | null;
  isPresent: boolean;
}): string {
  const fmt = (month: number | null, year: number | null) => {
    if (!year) return '?';
    return month ? `${MONTH_ABBR[month]} ${year}` : `${year}`;
  };
  const start = fmt(entry.startMonth, entry.startYear);
  const end = entry.isPresent ? 'Present' : fmt(entry.endMonth, entry.endYear);
  if (start === '?' && end === '?') return '';
  return `${start} – ${end}`;
}
