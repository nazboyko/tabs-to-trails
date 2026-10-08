/** Line icons, one set, all decorative: the text next to them carries the meaning. */

const base = { fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" stroke="#1E3A2B" strokeWidth="1.8" {...base}>
      <path d="M3 21V9a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v2" />
      <path d="M15 11c5 0 2 10 10 10" stroke="#BF4A0F" strokeDasharray="1.5 3.5" />
    </svg>
  );
}

export function Arrow({ color = '#FFFFFF' }: { color?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" stroke={color} strokeWidth="2" {...base}>
      <path d="M4 10h12" />
      <path d="M11 5l5 5-5 5" />
    </svg>
  );
}

export function Back({ color = '#1E3A2B' }: { color?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" stroke={color} strokeWidth="1.8" {...base}>
      <path d="M15 9H3" />
      <path d="M7.5 4.5 3 9l4.5 4.5" />
    </svg>
  );
}

export function Download({ color = '#FFFCF5', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" stroke={color} strokeWidth="1.8" {...base}>
      <path d="M9 3v9" />
      <path d="M5 8.5 9 12l4-3.5" />
      <path d="M3 15h12" />
    </svg>
  );
}

export function Play({ color = '#1E3A2B', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" stroke={color} strokeWidth="1.6" {...base}>
      <path d="M6 4.5v9l7-4.5-7-4.5z" />
    </svg>
  );
}

export function Stop({ color = '#1E3A2B' }: { color?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" stroke={color} strokeWidth="1.6" {...base}>
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
    </svg>
  );
}

export function Check({ color = '#FFFCF5', size = 14 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" stroke={color} strokeWidth="2" {...base}>
      <path d="M3 7.5l2.5 2.5L11 4.5" />
    </svg>
  );
}

export function Notice({ color = '#6E2A08', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" stroke={color} strokeWidth="1.8" {...base}>
      <circle cx="10" cy="10" r="8" />
      <path d="M10 6v5" />
      <path d="M10 14h.01" />
    </svg>
  );
}

export function Lock() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" stroke="#55655A" strokeWidth="1.6" {...base}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function FileUp() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" stroke="#1E3A2B" strokeWidth="1.8" {...base}>
      <path d="M9 4h10l6 6v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      <path d="M19 4v6h6" />
      <path d="M16 23v-8" />
      <path d="M12.5 18.5 16 15l3.5 3.5" />
    </svg>
  );
}

export function Grip({ color = '#FFFCF5' }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill={color} aria-hidden="true">
      <circle cx="5" cy="3.5" r="1.3" />
      <circle cx="11" cy="3.5" r="1.3" />
      <circle cx="5" cy="8" r="1.3" />
      <circle cx="11" cy="8" r="1.3" />
      <circle cx="5" cy="12.5" r="1.3" />
      <circle cx="11" cy="12.5" r="1.3" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" stroke="#1E3A2B" strokeWidth="1.8" {...base}>
      <path d="M4.5 7 9 11.5 13.5 7" />
    </svg>
  );
}

export function TableIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" stroke="#55655A" strokeWidth="1.5" {...base}>
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
      <path d="M1.5 5.5h11M1.5 8.75h11M5.5 2v10" />
    </svg>
  );
}

export function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" stroke="#55655A" strokeWidth="1.5" {...base}>
      <path d="M4.5 4 1.5 7l3 3M9.5 4l3 3-3 3" />
    </svg>
  );
}

export function Pause({ color = '#1E3A2B' }: { color?: string }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill={color} aria-hidden="true">
      <rect x="7" y="5" width="5" height="18" rx="1.5" />
      <rect x="16" y="5" width="5" height="18" rx="1.5" />
    </svg>
  );
}

export function PlayFilled({ color = '#1E3A2B' }: { color?: string }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill={color} aria-hidden="true">
      <path d="M9 5.5v17l14-8.5-14-8.5z" />
    </svg>
  );
}

export function Tick({ color = '#D5DCCF' }: { color?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" stroke={color} strokeWidth="1.8" {...base}>
      <path d="M3.5 9.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

export function MoveUp() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" stroke="#1E3A2B" strokeWidth="1.8" {...base}>
      <path d="M9 14.5v-11M4.5 8 9 3.5 13.5 8" />
    </svg>
  );
}

export function MoveDown() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" stroke="#1E3A2B" strokeWidth="1.8" {...base}>
      <path d="M9 3.5v11M4.5 10 9 14.5 13.5 10" />
    </svg>
  );
}

export function Cross() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" stroke="#1E3A2B" strokeWidth="1.8" {...base}>
      <path d="m4.5 4.5 9 9M13.5 4.5l-9 9" />
    </svg>
  );
}
