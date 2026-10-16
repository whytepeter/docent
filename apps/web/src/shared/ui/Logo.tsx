/**
 * Docent's mark: two parts joined by a path, the way a board follows a request.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--logo-bg, #5B5BD6)" />
      <path d="M10 22C10 14 22 18 22 10" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="10" cy="22" r="3.4" fill="#fff" />
      <circle cx="22" cy="10" r="3.4" fill="#fff" />
    </svg>
  );
}
