'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function LocationInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), 200);
    return () => clearTimeout(timer);
  }, [value]);

  const { data: suggestions } = useQuery({
    queryKey: ['location-search', debounced],
    queryFn: () => api.searchLocations(debounced),
    enabled: open && debounced.trim().length >= 2,
  });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative col-span-2">
      <input
        className="border rounded px-2 py-1 text-sm bg-transparent w-full"
        placeholder="Location (e.g. Seattle)"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && suggestions && suggestions.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto border rounded bg-white dark:bg-neutral-900 shadow-lg text-sm">
          {suggestions.map((s) => (
            <li key={s.label}>
              <button
                type="button"
                className="w-full text-left px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/10"
                onClick={() => {
                  onChange(s.label);
                  setOpen(false);
                }}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
