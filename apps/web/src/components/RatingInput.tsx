import { useRef, useState } from 'react';
import { MAX_STAR_GLYPHS, ratingRendersAsStars, type FieldScale } from '@unbent/shared';
import { TOUCH_QUERY, useMediaQuery } from '../useMediaQuery.js';

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
 * Below this a press is a click, which is handled per input type — by position with a
 * mouse, by repeat with a thumb. See `HALF_BY_POSITION` and `HALF_BY_REPEAT`.
 */
const DRAG_SLOP = 6;

/**
 * How a half is asked for, which is not the same question on a mouse as on a thumb.
 *
 * `HALF_BY_POSITION` (mouse): which half of the star the pointer is over decides, and
 * hovering previews it before the click. This is Letterboxd's desktop behaviour, and it
 * works because a mouse has a hover state and lands where it is aimed.
 *
 * `HALF_BY_REPEAT` (touch): tapping a star sets the whole; tapping the *same* star again
 * drops it to the half, and again returns it to the whole. This is Letterboxd's mobile
 * behaviour, and it exists because position does not survive a thumb — a half zone is
 * about 13px on a phone, well under the 44px a finger wants, while the whole star is a
 * target worth aiming at.
 *
 * One mechanic per input rather than both everywhere: a device that previews on hover
 * needs no timer, and a device with no hover cannot show what a position would mean
 * before it commits. Offering both on both would make a tap near a star's midpoint
 * unpredictable, which is the failure each of these avoids in its own way.
 *
 * Decided by `TOUCH_QUERY` — hover and pointer, not width — because that is the question
 * being asked: a tablet at 1024px has a thumb and a desktop window dragged narrow does
 * not. Dragging works on both regardless, and is unaffected by either.
 */

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
 * Dragging works on every input and is the third way in: sliding along the row fills it as
 * the pointer moves and commits on release. A drag is told from a click by `DRAG_SLOP`, so
 * neither half-star mechanic has to guess whether a press was meant to slide.
 *
 * So four routes to a half, each the natural one for its input: the pointer's position on
 * a mouse (previewed on hover), a repeat tap on a thumb, the arrow keys on a keyboard, and
 * a drag on any of them.
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
  // What a click at the current mouse position would set, shown before it is clicked.
  // Touch never sets this: there is no hover to preview from.
  const [hovering, setHovering] = useState<number | null>(null);
  const byRepeat = useMediaQuery(TOUCH_QUERY);

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

  // A drag beats a hover beats the stored value: each is a better answer to "what would
  // happen if I let go right now" than the one behind it.
  const shown = dragging ?? hovering ?? value;
  const stars = Array.from({ length: Math.min(scale.max, MAX_STAR_GLYPHS) }, (_, i) => i + 1);

  const commit = (next: number) => {
    if (!readOnly) onChange(next);
  };

  /**
   * What clicking `star` means, given how this input asks for halves.
   *
   * On touch, a repeat tap on the star the rating already sits on toggles to its half and
   * back — `value` rather than `shown`, so the comparison is against what is stored and
   * not against a preview. On a mouse the pointer's own position has already been read
   * into `hovering`, so a click takes that; the radio's `star` is the fallback for a
   * click with no pointer behind it, which is what a keyboard's Space produces.
   */
  const clickValue = (star: number): number => {
    // A whole-step scale has no half to toggle to or position onto, so every click is
    // the star itself and both mechanics collapse to the same thing.
    if (scale.step !== 0.5) return star;
    if (byRepeat) return value === star ? star - 0.5 : star;
    return hovering ?? star;
  };

  return (
    <span className="note-field-rating">
      <div
        ref={rowRef}
        className="note-field-stars"
        role="radiogroup"
        aria-label={label ?? 'Rating'}
        data-dragging={dragging !== null || undefined}
        // Drawn a shade lighter while either preview is live, so the row never shows a
        // provisional rating in the same ink as a chosen one.
        data-preview={dragging !== null || hovering !== null || undefined}
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
          if (readOnly || !rowRef.current) return;
          // No button down: this is a mouse moving across the row, so preview what a
          // click here would set. Guarded off touch, where a "move" arrives with the tap
          // itself and would turn the repeat mechanic back into the position one.
          if (!down.current) {
            if (!byRepeat && scale.step === 0.5 && e.pointerType !== 'touch') {
              setHovering(ratingAt(e.clientX, rowRef.current, scale));
            }
            return;
          }
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
        // The preview belongs to the pointer, so it goes when the pointer does — otherwise
        // a row left mid-hover keeps showing a rating nobody chose.
        onPointerLeave={() => setHovering(null)}
      >
        {stars.map((star) => {
          const fill = fillAt(star, shown ?? 0);
          /*
             One radio per star. Its own value is the whole star, which is what a keyboard
             gets: arrows move by a half where the scale allows them, so tabbing does not
             need a stop per half as well. What a *click* on it means is `clickValue` —
             the pointer's position with a mouse, a toggle with a thumb.
          */
          return (
            <label key={star} className="note-field-star" data-fill={fill}>
              <input
                type="radio"
                name={`rating-${id ?? label ?? 'field'}`}
                className="note-field-star-radio"
                disabled={readOnly}
                /*
                   The stored value, not `shown`. The fill previews what a drag or a hover
                   would set, but which radio is *checked* is what the note actually holds
                   — tying it to the preview would move the checked control under the
                   mouse and have a screen reader announce a value nobody chose yet.
                */
                checked={value === star}
                /*
                   Always the whole star this radio is, never what tapping it again would
                   do. A name that changed with the value would leave the group's names
                   disagreeing with its values — arrowing onto the third star and hearing
                   "2.5 of 5" is a worse bug than the repeat toggle being undiscoverable
                   by ear. The half is reachable from the keyboard with the arrows, which
                   is the route that does not need this name to lie.
                */
                aria-label={`${star} of ${scale.max}`}
                /*
                   `onClick`, not `onChange`. A radio that is already checked fires no
                   change event — there is nothing to change — so the repeat tap that
                   halves it would have done silently nothing, which is the whole
                   mechanic. Click fires either way. Space and Enter on a focused radio
                   also arrive here, so the keyboard keeps working; a first activation of
                   an unchecked radio fires both, and `commit` with the same value twice
                   is harmless because the parent stores a value, not an event.
                */
                onClick={() => {
                  commit(clickValue(star));
                  // The click has consumed the preview; leaving it set would keep drawing
                  // a hover fill over the value that was just chosen.
                  setHovering(null);
                }}
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
