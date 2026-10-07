import { useEffect, useRef } from 'react';
import { Logo } from './icons';
import { hasNavigated, onLink } from './router';

export function Header() {
  return (
    <header className="site-header">
      <a className="wordmark" href="/" onClick={onLink}>
        <Logo />
        <span>Tabs to Trails</span>
      </a>
      <div className="running">Running on this computer</div>
    </header>
  );
}

/** A screen's h1: takes focus when the user arrives from another screen, and sets the tab title. */
export function ScreenTitle({
  children,
  title,
  className,
  focus = false,
}: {
  children: React.ReactNode;
  title: string;
  className?: string;
  /** Take focus even on a first load, for a screen that replaced another one in place. */
  focus?: boolean;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · Tabs to Trails`;
  }, [title]);
  useEffect(() => {
    if (focus || hasNavigated()) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className={className}>
      {children}
    </h1>
  );
}

export function Badge({ coverage }: { coverage: 'Full' | 'Condensed' | 'Brief' }) {
  return <span className={`badge ${coverage.toLowerCase()}`}>{coverage}</span>;
}
