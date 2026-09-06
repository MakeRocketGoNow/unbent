interface FilterRowProps {
  label: string;
  /** What it is currently set to, or nothing when it is not set. */
  value?: string;
  onClick: () => void;
}

/**
 * One filter in the sheet's root: what it is, what it is set to, and that it opens.
 *
 * A row rather than the control itself, for the one filter whose control is too big to
 * inline. The notebook picker is a `<select>` and the dates are two inputs, so both sit on
 * the root page directly; tags are a find field and an unbounded list, and putting that on
 * the root would make the sheet mostly tags with the other filters pushed under it.
 *
 * The value is the point. A row reading only "Tags" says where to go and nothing about
 * where you already are, which on a surface whose whole job is reporting what is applied is
 * the thing worth saying. Android's `FilterRow` shows the same "3 tags".
 *
 * The chevron is drawn the way `.disclosure > summary::after` is — a rotated box with two
 * borders, no glyph, no asset, correct in dark mode for free.
 */
export function FilterRow({ label, value, onClick }: FilterRowProps) {
  return (
    <button
      type="button"
      className="filter-row"
      // The value goes in the accessible name too. A screen reader gets the label and the
      // chevron's meaning from the markup, but "3 tags" is only in the visual column.
      aria-label={value ? `${label}, ${value}` : label}
      onClick={onClick}
    >
      <span className="filter-row-label">{label}</span>
      {value && <span className="filter-row-value">{value}</span>}
    </button>
  );
}
