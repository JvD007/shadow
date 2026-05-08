export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="GridWeave Inspector logo"
      role="img"
    >
      {/* Woven grid: two interlocking squares rotated, suggesting a fabric/grid */}
      <rect x="4" y="4" width="24" height="24" rx="4" />
      <path d="M4 11h24M4 21h24M11 4v24M21 4v24" />
      <circle cx="16" cy="16" r="2.25" fill="currentColor" stroke="none" />
    </svg>
  );
}
