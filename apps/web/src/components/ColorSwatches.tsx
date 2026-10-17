import { TAG_COLOR_NAMES } from '@unbent/shared';

interface ColorSwatchesProps {
  /** What the swatches colour, for the group's accessible name: "the tag Receipts". */
  of: string;
  /** The colour it wears now, an index into the palette; null for none yet. */
  value: number | null | undefined;
  disabled?: boolean;
  onPick: (color: number) => void;
}

/**
 * The palette as a row of ten swatches: one real button per colour, the chosen one
 * marked, each named for a screen reader and a tooltip since a dot of colour says
 * nothing in words.
 *
 * Shown beside a rename, on the Tags page's row and on a select option's chip, and
 * never at creation: a colour is assigned when a tag or an option is made (the one
 * fewest of its siblings wear), and the swatches are for changing it afterwards, so
 * "Yes" can be made green and "No" red by whoever wants that and nobody is asked.
 *
 * A radio group, which is what ten mutually exclusive choices are: arrowing between
 * them is the browser's. Pressing a swatch keeps focus where it was (`onMouseDown`
 * prevents the default), because beside a rename field a click that blurred the field
 * would end the rename and take the swatches with it before the pick landed.
 */
export function ColorSwatches({ of, value, disabled = false, onPick }: ColorSwatchesProps) {
  return (
    <span className="color-swatches" role="radiogroup" aria-label={`Colour of ${of}`}>
      {TAG_COLOR_NAMES.map((name, i) => (
        <button
          key={name}
          type="button"
          role="radio"
          className="color-swatch"
          data-color={i}
          aria-checked={value === i}
          aria-label={name}
          data-tip={name}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onPick(i);
          }}
        />
      ))}
    </span>
  );
}
