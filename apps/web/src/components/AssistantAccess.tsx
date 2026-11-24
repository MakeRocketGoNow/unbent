import { useId, useState } from 'react';
import type { AssistantGrant, NotebookSummary } from '@unbent/shared';
import { InboxRowIcon, NotebookGlyph } from './icons.js';

interface AssistantAccessProps {
  value: AssistantGrant;
  onChange: (next: AssistantGrant) => void;
  /** The account's notebooks and how many notes are in none; undefined while they load, or when `failed`. */
  notebooks: { notebooks: NotebookSummary[]; unfiled: number } | undefined;
  /** The notebooks could not be read: said in place of the list, which would otherwise say "Loading" for good. */
  failed?: boolean;
  disabled?: boolean;
  /** Shown under the notebook list, and tied to it for a screen reader: why this cannot be allowed yet. */
  error?: string | null;
}

/**
 * What a connected assistant may see and do (MAK-264): the two questions the consent
 * screen asks before Allow, and the same two again in Settings under Connected apps.
 *
 * Two groups of radio buttons, each with its choices in view, and no disclosure to open
 * first. This is the one place a person hands a program standing access to their notes,
 * and a choice folded away under "Advanced" is a choice most people never see was
 * theirs: the assistant they do not quite trust gets the library because that is what
 * the screen showed. Radios rather than a select or a switch for the same reason: both
 * answers of each question are read before either is taken.
 *
 * "Only some notebooks" opens the list where it is picked, under its own radio, so
 * nothing moves but what the choice itself brings. The list is the move sheet's shape,
 * a find field over a capped scrolling list, because the archive this is built for has
 * dozens of notebooks and a page of fifty checkboxes with no way to find one is a page
 * people give up on. Its rows are checkboxes, labelled by the whole row, with the
 * drawer's glyph and count so a notebook looks here as it does in the rail.
 *
 * The Inbox is a row of its own at the top: the notes filed in no notebook belong to
 * none of the rows below, and leaving them out without a word would make "only these
 * notebooks" quietly mean "and never the loose notes" with no way to say otherwise.
 *
 * A notebook made after this is saved is not in a list, and the hint under that radio
 * says so. That is the safe direction, and the one a person restricting an assistant
 * expects; it is also the thing they will otherwise meet as "why can it not find my
 * note" a month on.
 *
 * Controlled, and it saves nothing: the consent screen saves on Allow and Settings on
 * Save, each with its own failure to report.
 */
export function AssistantAccess({ value, onChange, notebooks, failed, disabled, error }: AssistantAccessProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const some = value.notebooks !== null;
  const picked = new Set(value.notebooks ?? []);
  const all = notebooks?.notebooks ?? [];
  const needle = query.trim().toLowerCase();
  const matching = all.filter((nb) => needle === '' || nb.name.toLowerCase().includes(needle));
  const showInbox = needle === '' || 'inbox'.includes(needle);
  // Only what still exists: an id left by a deleted notebook is in the grant and not on the page.
  const pickedHere = all.filter((nb) => picked.has(nb.id)).length;

  const toggle = (notebookId: string) => {
    const next = new Set(picked);
    if (next.has(notebookId)) next.delete(notebookId);
    else next.add(notebookId);
    // The notebooks shown, in their own order, then any id this device does not hold.
    // Such an id is either a notebook since deleted, which grants nothing and costs
    // nothing to keep, or one this device has not been sent yet: a library still
    // filling on a phone, or a notebook made elsewhere a moment ago. Dropping those
    // (which this did at first) took a notebook away from an assistant because a
    // different box was ticked, with no sign of it on the page. A tick changes the box
    // it was made in and no other.
    const shown = new Set(all.map((nb) => nb.id));
    onChange({
      ...value,
      notebooks: [...all.filter((nb) => next.has(nb.id)).map((nb) => nb.id), ...(value.notebooks ?? []).filter((id) => !shown.has(id))],
    });
  };

  return (
    <div className="access">
      <fieldset className="access-group" disabled={disabled}>
        <legend>What it can see</legend>
        <label className="access-choice">
          <input
            type="radio"
            name={`${id}-see`}
            checked={!some}
            onChange={() => onChange({ ...value, notebooks: null, unfiled: true })}
          />
          <span>
            <span className="access-choice-name">All notebooks</span>
            <span className="access-choice-hint">Every note you have, and every notebook you add later.</span>
          </span>
        </label>
        <label className="access-choice">
          <input
            type="radio"
            name={`${id}-see`}
            checked={some}
            // Starting from nothing picked: the point of this choice is to say which.
            onChange={() => !some && onChange({ ...value, notebooks: [], unfiled: false })}
          />
          <span>
            <span className="access-choice-name">Only some notebooks</span>
            <span className="access-choice-hint">
              Just the ones you pick. A notebook you add later is not included until you pick it too.
            </span>
          </span>
        </label>

        {some && (
          <div className="access-notebooks">
            <search>
              <input
                className="search-field"
                type="search"
                value={query}
                placeholder="Find a notebook…"
                aria-label="Find a notebook"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
              />
            </search>
            {!notebooks ? (
              <p className={`small access-empty ${failed ? 'bad' : 'muted'}`} role={failed ? 'alert' : undefined}>
                {failed ? 'Your notebooks could not be loaded, so there is nothing to pick from. Try again in a moment.' : 'Loading your notebooks…'}
              </p>
            ) : (
              <ul
                className="access-list"
                aria-label="Notebooks it can see"
                aria-describedby={error ? `${id}-error` : undefined}
              >
                {showInbox && (
                  <li>
                    <label className="access-row">
                      <input
                        type="checkbox"
                        checked={value.unfiled}
                        onChange={() => onChange({ ...value, unfiled: !value.unfiled })}
                      />
                      <InboxRowIcon />
                      <span className="access-row-name">
                        Inbox
                        <span className="access-row-note">notes in no notebook</span>
                      </span>
                      <span className="tag-count">{notebooks.unfiled.toLocaleString()}</span>
                    </label>
                  </li>
                )}
                {matching.map((nb) => (
                  <li key={nb.id}>
                    <label className="access-row">
                      <input type="checkbox" checked={picked.has(nb.id)} onChange={() => toggle(nb.id)} />
                      <NotebookGlyph emoji={nb.emoji} />
                      <span className="access-row-name">{nb.name}</span>
                      <span className="tag-count">{nb.count.toLocaleString()}</span>
                    </label>
                  </li>
                ))}
                {matching.length === 0 && !showInbox && (
                  <li className="muted small access-empty">No notebook matches “{query.trim()}”.</li>
                )}
              </ul>
            )}
            {/* The count is said as it changes, since a tick in a scrolled list is easy to lose track of. */}
            <p className="muted small access-count" role="status">
              {notebooks
                ? `${pickedHere.toLocaleString()} of ${all.length.toLocaleString()} ${all.length === 1 ? 'notebook' : 'notebooks'} picked${value.unfiled ? ', and the Inbox' : ''}`
                : ''}
            </p>
            {error && (
              <p className="bad small access-error" id={`${id}-error`} role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="access-group" disabled={disabled}>
        <legend>What it can do</legend>
        <label className="access-choice">
          <input
            type="radio"
            name={`${id}-do`}
            checked={!value.readOnly}
            onChange={() => onChange({ ...value, readOnly: false })}
          />
          <span>
            <span className="access-choice-name">Read and change</span>
            <span className="access-choice-hint">Create notes, edit them, move them and put them in the trash.</span>
          </span>
        </label>
        <label className="access-choice">
          <input
            type="radio"
            name={`${id}-do`}
            checked={value.readOnly}
            onChange={() => onChange({ ...value, readOnly: true })}
          />
          <span>
            <span className="access-choice-name">Read only</span>
            <span className="access-choice-hint">Look things up. It cannot create, change or delete anything.</span>
          </span>
        </label>
      </fieldset>
    </div>
  );
}
