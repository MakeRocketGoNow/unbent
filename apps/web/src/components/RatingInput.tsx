import { useRef, useState } from 'react';
import { MAX_STAR_GLYPHS, ratingRendersAsStars, type FieldScale } from '@unbent/shared';

interface RatingInputProps {
  scale: FieldScale;
  /** The rating held, or null for none. */
  value: number | null;
  readOnly?: boolean;
  onChange: (value: number | null) => void;
  id?: string | undefined;
  /** An accessible name where no `<label>` points at the control — a table cell. */
  label?: string | undefined;
}

/**
 * How far a pointer must travel before the gesture counts as a drag rather than a click.
 *
 * A click has to keep working through the radio underneath, because a star's own centre
 * falls inside one of its two half-zones — so committing the position on a plain click
 * would read the middle of the third star as 2.5 where the radio, and the person, say 3.
 */
const DRAG_SLOP = 6;

/** The glyphs a star can be drawn as, given how much of it the rating fills. */
type Fill = 'full' | 'half' | 'empty';

function fillAt(star: number, rating: number): Fill {
  if (rating >= star) return 'full';
  if (rating >= star - 0.5) return 'half';
  return 'empty';
}

/**
 * Which rating a pointer at `clientX` is asking for.
 *
 * The row is measured rather than each star, so the arithmetic is one rect and a
 * division: a five-star row is ten half-star zones, and the tenth of the width the
 * pointer sits in is the value. That is what makes a drag work — the same function
 * answers every position, so moving across the row is a stream of values, not a set of
 * separate hit tests.
 *
 * Clamped to at least one step, because there is no zero rating: dragging off the left
 * edge asks for the lowest, and clearing is the button beside the row.
 */
function ratingAt(clientX: number, row: HTMLElement, scale: FieldScale): number {
  const { left, width } = row.getBoundingClientRect();
  if (width === 0) return scale.step;
  const zones = scale.max / scale.step;
  const zone = Math.ceil(((clientX - left) / width) * zones);
  const raw = zone * scale.step;
  return Math.min(scale.max, Math.max(scale.step, raw));
}

/**
 * A rating, as stars or as a number over its max.
 *
 * Stars up to five (`MAX_STAR_GLYPHS`); above that the row of tap targets is too long for
 * a property row on a phone, and the value reads as `7/10` in the same numeric input a
 * plain number gets. Half steps are what keep that rare: max 5 with halves already offers
 * ten levels, which is the scale most people mean by "out of ten".
 *
 * The stars are a radio group rather than buttons. A rating is one choice among a few, so
 * arrow keys should move it and a screen reader should say "3 of 5" — both of which come
 * free from radios and neither of which comes free from a row of buttons. The inputs are
 * the accessible control; the pointer handlers on the row are an addition for mice and
 * thumbs, not the mechanism.
 *
 * Dragging is why the half-star target is usable at all. Half of a star is around 20px
 * wide, under the 44px a finger wants, so tapping exactly is hard — but sliding along the
 * row and watching it fill is easy, and lands on the same values. `pointermove` is only
 * read while a pointer is down, so hovering does not rewrite the note.
 */
export function RatingInput({
  scale,
  value,
  readOnly = false,
  onChange,
  id,
  label,
}: RatingInputProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  // Where the pointer went down, to tell a click from a drag. A ref rather than state:
  // nothing renders from it, and a re-render per pointer press would be wasted work.
  const down = useRef<{ x: number; id: number } | null>(null);
  // What the pointer is currently over mid-drag, so the row can show the value it would
  // commit before the pointer is lifted. Null whenever no drag is in progress.
  const [dragging, setDragging] = useState<number | null>(null);

  if (!ratingRendersAsStars(scale)) {
    return (
      <span className="note-field-rating-num">
        <input
          id={id}
          className="note-field-input"
          type="text"
          inputMode="numeric"
          placeholder="Empty"
          disabled={readOnly}
          value={value === null ? '' : String(value)}
          aria-label={label}
          onChange={(e) => {
            const next = e.target.value.trim();
            if (next === '') return onChange(null);
            const n = Number(next);
            // Anything unreadable is held rather than cleared, as the number input does:
            // a half-typed "3." must not delete the rating. The server has the last word.
            onChange(Number.isFinite(n) ? n : null);
          }}
        />
        <span className="note-field-rating-max" aria-hidden="true">
          /{scale.max}
        </span>
      </span>
    );
  }

  const shown = dragging ?? value;
  const stars = Array.from({ length: Math.min(scale.max, MAX_STAR_GLYPHS) }, (_, i) => i + 1);

  const commit = (next: number) => {
    if (!readOnly) onChange(next);
  };

  return (
    <span className="note-field-rating">
      <div
        ref={rowRef}
        className="note-field-stars"
        role="radiogroup"
        aria-label={label ?? 'Rating'}
        data-dragging={dragging !== null || undefined}
        onPointerDown={(e) => {
          if (readOnly || e.button !== 0) return;
          // Only the origin is recorded here. Committing on a press would take every
          // click off the radio underneath — and a click on a star's own centre lands in
          // one of its two half-zones, so a plain click would have meant 2.5 where the
          // radio says 3. The radio stays the control for a click; the pointer path is
          // for the drag only, and does not exist until the pointer actually moves.
          down.current = { x: e.clientX, id: e.pointerId };
        }}
        onPointerMove={(e) => {
          if (readOnly || !down.current || !rowRef.current) return;
          const moved = Math.abs(e.clientX - down.current.x);
          // Past the slop a finger or a mouse wobbles by on a click, this is a drag: the
          // row takes the pointer so leaving it mid-gesture cannot strand the fill, and
          // the glyphs start following the pointer.
          if (dragging === null && moved < DRAG_SLOP) return;
          if (dragging === null) {
            // Optional because it is missing in jsdom, where the tests run. Capture keeps
            // a drag that leaves the row from stranding the fill with no pointerup; going
            // without it costs that recovery, not the gesture.
            e.currentTarget.setPointerCapture?.(down.current.id);
          }
          setDragging(ratingAt(e.clientX, rowRef.current, scale));
        }}
        onPointerUp={(e) => {
          down.current = null;
          if (readOnly || dragging === null || !rowRef.current) return;
          // A drag ends on the value under the pointer. `preventDefault` keeps the click
          // this gesture would otherwise synthesise from landing on a radio and
          // overwriting the dragged value with a whole star.
          e.preventDefault();
          commit(ratingAt(e.clientX, rowRef.current, scale));
          setDragging(null);
        }}
        onPointerCancel={() => {
          down.current = null;
          setDragging(null);
        }}
      >
        {stars.map((star) => {
          const fill = fillAt(star, shown ?? 0);
          /*
             One radio per star, and its value is the whole star. A half is reachable by
             pointer, where the position says which half is meant, and by the left arrow
             from the star above — not by tabbing, which would double the stops in the
             group for a distinction the keyboard has no way to express.
          */
          return (
            <label key={star} className="note-field-star" data-fill={fill}>
              <input
                type="radio"
                name={`rating-${id ?? label ?? 'field'}`}
                className="note-field-star-radio"
                disabled={readOnly}
                checked={shown === star}
                aria-label={`${star} of ${scale.max}`}
                onChange={() => commit(star)}
                onKeyDown={(e) => {
                  // Halves need a keyboard route, and the arrows are already moving
                  // within the group: a step of 0.5 rather than a whole star where the
                  // scale allows them.
                  if (scale.step !== 0.5) return;
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  e.preventDefault();
                  const from = shown ?? 0;
                  const next = e.key === 'ArrowRight' ? from + 0.5 : from - 0.5;
                  commit(Math.min(scale.max, Math.max(0.5, next)));
                }}
              />
              {/*
                 A half is the hollow glyph with a filled one clipped over its left half,
                 rather than a half-star character: no such glyph exists in a font that
                 can be relied on. Two stacked glyphs always line up, because they are the
                 same glyph at the same size in the same place.
              */}
              <span className="note-field-star-glyph" aria-hidden="true">
                {fill === 'full' ? '★' : '☆'}
                {fill === 'half' && <span className="note-field-star-half">★</span>}
              </span>
            </label>
          );
        })}
      </div>
      {/*
         The rating in words, and the only way back to no rating.

         There is no zero star to click twice, by design — an unlit row means "no value"
         and nothing else — so clearing needs its own affordance. It shows only when there
         is something to clear, so an empty row is the word "Empty" and nothing more.
      */}
      {value === null ? (
        <span className="note-field-rating-empty">Empty</span>
      ) : (
        !readOnly && (
          <button
            type="button"
            className="note-field-act"
            onClick={() => onChange(null)}
            aria-label={`Clear ${label ?? 'rating'}`}
          >
            Clear
          </button>
        )
      )}
    </span>
  );
}
