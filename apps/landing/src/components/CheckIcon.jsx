// The checkmark svg repeated in every .bullet-list item across the source file.
// Width/height varied per usage site (18px in the home hero, 16px on the facility
// overview list), so both are props rather than hardcoded.
export default function CheckIcon({ width = 18, height = 18 }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
