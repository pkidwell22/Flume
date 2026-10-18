/** A clean vector redraw of the supplied portfolio's three diagonal rails.
 * Decorative by default; Brand supplies its accessible name as text.
 */
export function FlumeMark() {
  return (
    <svg className="fl-brand__mark" viewBox="0 0 96 80" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M0 35 60 0 66 4 66 14 6 49 0 45Z" />
      <path d="M15 50 75 15 81 19 81 29 21 64 15 60Z" />
      <path d="M30 65 90 30 96 34 96 44 36 79 30 75Z" />
    </svg>
  );
}

export interface BrandProps {
  /** Navigation is opt-in. Omit this for a non-interactive identity. */
  href?: string;
  /** Mark-only layout; keeps an accessible Flume name. */
  compact?: boolean;
  className?: string;
}

export function Brand({ href, compact = false, className }: BrandProps = {}) {
  const classes = ['fl-brand', className].filter(Boolean).join(' ');
  const content = <><FlumeMark />{!compact && <span className="fl-brand__wordmark">Flume</span>}</>;
  if (href !== undefined) {
    return <a className={classes} href={href} aria-label={compact ? 'Flume' : undefined}>{content}</a>;
  }
  return <span className={classes} role={compact ? 'img' : undefined} aria-label={compact ? 'Flume' : undefined}>{content}</span>;
}
