/** A notebook margin and a single observation, drawn in chalk and red ink. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 28 32" fill="none" aria-hidden="true">
      <path
        d="M8 3 3 4 3.5 28 9 29 M19 3 25 4 24.5 28 19 29 M8 23 12 17 16 19 21 10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="21" cy="10" r="2" fill="var(--ink)" />
    </svg>
  );
}
