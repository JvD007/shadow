export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      fill="none"
      aria-label="Dell Technologies logo"
      role="img"
    >
      {/* Blue circle */}
      <circle cx="20" cy="20" r="19" fill="#007DB8" />
      {/* "dell" in white italic bold — Dell brand style */}
      <text
        x="20"
        y="26"
        textAnchor="middle"
        fill="white"
        fontSize="13"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="bold"
        fontStyle="italic"
        letterSpacing="-0.5"
      >
        dell
      </text>
    </svg>
  );
}
