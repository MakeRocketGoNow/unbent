import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  FIELD_TYPE_LABELS,
  NOTEBOOK_TEMPLATES,
  fieldHasOptions,
  isCurrencyField,
  type NotebookFileField,
  type NotebookTemplate,
} from '@unbent/shared';
import { Button } from './Button.js';
import { FieldTypeIcon, PlusIcon } from './icons.js';
import { applyNotebookTemplate } from '../store/actions.js';
import { useOffline } from '../connectivity.js';
import type { NotebookImportSkip } from '../notes-api.js';

interface NotebookChooserProps {
  /** The notebooks there are, to know a template's name is taken before asking the server. */
  existing: readonly { name: string }[];
  /** One line above the cards, when the list beside them has nothing to explain it. */
  intro?: ReactNode;
  /** Blank was chosen: the caller turns its create row into the name field it always was. */
  onBlank: () => void;
  /** Escape: the chooser closes, and the caller decides what that leaves on screen. */
  onClose: () => void;
  /** The caller's list may be behind: a template was applied, or the server refused a name it did not have. */
  onApplied: () => void;
  /** A notebook now has the template's fields; the caller opens it. */
  onDone: (name: string) => void;
}

/**
 * Where a notebook is made: Blank, then the templates (`NOTEBOOK_TEMPLATES`).
 *
 * Blank is first and takes the focus, so a blank notebook costs one more Enter than it did
 * when the create row went straight to a name field, and no more. That one step is the
 * price of the feature, paid by people who already know what they want so that people who
 * do not can find out that notebooks have fields at all.
 *
 * A card per template: its emoji, name, one line on what it is for, and its fields as
 * chips. The chips are the point of the card. They show what a field is before anyone has
 * made one, which no amount of describing did.
 *
 * Picking a card turns the chooser into that template, in the same box rather than a
 * dialog over it: its name in a field to change, every field with what kind it is, and
 * Create. Nothing is made until then. A name already taken is never merged into silently,
 * because adding fields to a notebook someone has is a different act from making one. The
 * name becomes the next free `Name 2`, and adding to the existing notebook is offered
 * beside it as a choice of its own. The server holds the same line (`?create=1`), for a
 * notebook made on another device since this list was read.
 */
export function NotebookChooser({ existing, intro, onBlank, onClose, onApplied, onDone }: NotebookChooserProps) {
  const [picked, setPicked] = useState<NotebookTemplate | null>(null);
  /** The card to put focus back on when the preview is left, so Back lands where it began. */
  const returnTo = useRef<string | null>(null);
  const blankRef = useRef<HTMLButtonElement>(null);
  const cardsRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (picked) return;
    const id = returnTo.current;
    const card = id ? cardsRef.current?.querySelector<HTMLButtonElement>(`[data-template="${id}"]`) : null;
    (card ?? blankRef.current)?.focus();
  }, [picked]);

  if (picked) {
    return (
      <TemplatePreview
        template={picked}
        existing={existing}
        onBack={() => setPicked(null)}
        onApplied={onApplied}
        onDone={onDone}
      />
    );
  }

  return (
    <div
      className="nb-chooser"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {intro && <p className="nb-chooser-intro">{intro}</p>}
      <ul className="nb-templates" ref={cardsRef} aria-label="Start a notebook">
        <li>
          <button
            ref={blankRef}
            type="button"
            className="nb-template nb-template-blank"
            onClick={() => {
              returnTo.current = null;
              onBlank();
            }}
          >
            <span className="nb-template-mark" aria-hidden="true">
              <PlusIcon />
            </span>
            <span className="nb-template-name">Blank</span>
            <span className="nb-template-line">A name now, and fields when you want them</span>
          </button>
        </li>
        {NOTEBOOK_TEMPLATES.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="nb-template"
              data-template={t.id}
              onClick={() => {
                returnTo.current = t.id;
                setPicked(t);
              }}
            >
              <span className="nb-template-mark" aria-hidden="true">
                {t.emoji}
              </span>
              <span className="nb-template-name">{t.name}</span>
              <span className="nb-template-line">{t.description}</span>
              {/* Inside the button, so the whole card is one target; the chips are words
                  about the card, not controls of their own. */}
              <span className="nb-template-chips">
                {t.fields.map((f) => (
                  <span key={f.name} className="nb-template-chip">
                    <FieldGlyph field={f} />
                    {f.name}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Two notebook names are the same name the way the server compares them: trimmed, any case. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The next name not taken: `Receipts 2`, `Receipts 3`… compared the way the server does. */
export function freeName(name: string, existing: readonly { name: string }[]): string {
  const taken = new Set(existing.map((n) => n.name.trim().toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n += 1;
  return `${name} ${n}`;
}

function TemplatePreview({
  template,
  existing,
  onBack,
  onApplied,
  onDone,
}: {
  template: NotebookTemplate;
  existing: readonly { name: string }[];
  onBack: () => void;
  onApplied: () => void;
  onDone: (name: string) => void;
}) {
  /*
   * Names the server refused as taken, though the list did not have them: notebooks made
   * since it was read — on another device, in another tab, or by an assistant. Kept beside the list rather than instead of it,
   * so they count as taken until the refreshed list brings them in.
   */
  const [refused, setRefused] = useState<{ name: string }[]>([]);
  /** Set when a refusal renamed the notebook, to say why the name changed. */
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null);
  const known = [...existing, ...refused];
  /*
   * The notebook the template's own name would land on, if there is one: what "Add these
   * fields to …" names. Derived, not kept: the list can arrive, or be refreshed, after the
   * preview opened, and the offer should follow it. The person's edits to the name field
   * do not change which notebook it is about.
   */
  const clash = known.find((n) => sameName(n.name, template.name))?.name ?? null;
  /*
   * The name the preview itself put in the field. A refusal of that one numbers on from
   * the template's name; a refusal of one the person typed numbers from what they typed,
   * even when it happens to end in a number of its own, like "Receipts 2024".
   */
  const offered = useRef<string | null>(null);
  const [name, setName] = useState(() => (offered.current = freeName(template.name, existing)));
  const [busy, setBusy] = useState(false);
  /*
   * Making a notebook is a request (see `applyNotebookTemplate`), so Create and the add
   * wait for a connection the way the note's server-bound controls do, and say so here
   * rather than after a press. The preview itself is all on the device and stays open.
   */
  const offline = useOffline();
  const offlineTitle = offline ? 'Not available offline' : undefined;
  const [error, setError] = useState<string | null>(null);
  /** What the server could not apply, when adding to a notebook that already had some of it. */
  const [skipped, setSkipped] = useState<{ name: string; items: NotebookImportSkip[] } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  /*
   * Whether the preview is still on screen. A request outlives it when the person leaves
   * the page while Create waits; the list still wants refreshing then, but taking them
   * into the new notebook from wherever they went would be a jump they did not ask for.
   */
  const live = useRef(true);
  useEffect(() => {
    // Set on mount as well as cleared on unmount: StrictMode mounts twice in development.
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const trimmed = name.trim();
  const nameTaken = known.some((n) => sameName(n.name, trimmed));

  const definition = (as: string) => ({
    name: as,
    emoji: template.emoji,
    purpose: template.purpose,
    fields: template.fields,
  });

  async function create() {
    if (!trimmed || nameTaken || busy || offline) return;
    setBusy(true);
    setError(null);
    try {
      const out = await applyNotebookTemplate(definition(trimmed), { create: true });
      if (out === 'taken') {
        /*
         * Made elsewhere since the list was read. Nothing was written, but the list is
         * behind the server, so it is refreshed. A name numbered from the template's goes
         * on numbering from it — `Receipts 3`, not `Receipts 2 2` — and one the person
         * typed is numbered from what they typed.
         */
        onApplied();
        const now = [...known, { name: trimmed }];
        const base = offered.current !== null && sameName(trimmed, offered.current) ? template.name : trimmed;
        const next = freeName(base, now);
        offered.current = next;
        setRefused((r) => [...r, { name: trimmed }]);
        setRenamed({ from: trimmed, to: next });
        setName(next);
        return;
      }
      onApplied();
      if (live.current) onDone(trimmed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addToExisting(target: string) {
    setBusy(true);
    setError(null);
    try {
      // Fields only, which is what the button says. The template's emoji and purpose are
      // for a notebook it makes; on one the person already has, a purpose would quietly
      // become what Auto-fill reads to file notes there, and one the notebook already has
      // would come back as "left as it was" on every add.
      const out = await applyNotebookTemplate({ name: target, fields: template.fields }, { create: false });
      onApplied();
      if (!live.current) return;
      // Never 'taken' without `create`; the type allows it, so it is answered anyway.
      if (out !== 'taken' && out.skipped.length > 0) {
        setSkipped({ name: target, items: out.skipped });
        return;
      }
      onDone(target);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (skipped) {
    // Adding to a notebook that had some of this already: say what was left alone before
    // leaving, since the notebook's page would show the result but not why.
    return (
      <div className="nb-chooser nb-preview">
        <p className="nb-preview-done">
          Added to {skipped.name}.{' '}
          {skipped.items.length === 1 ? 'One thing was left as it was:' : 'Some things were left as they were:'}
        </p>
        <ul className="nb-preview-skipped">
          {skipped.items.map((s) => (
            <li key={`${s.kind ?? 'field'}:${s.name}`}>
              <strong>{s.name}</strong> <span className="muted">{s.reason}</span>
            </li>
          ))}
        </ul>
        <div className="nb-preview-actions">
          <Button variant="primary" onClick={() => onDone(skipped.name)}>
            Open {skipped.name}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="nb-chooser nb-preview"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // The preview is a step inside the chooser; Escape goes back a step, not out —
          // and not at all while Create waits, as Back does not.
          e.stopPropagation();
          if (!busy) onBack();
        }
      }}
    >
      <div className="nb-preview-head">
        <span className="nb-template-mark" aria-hidden="true">
          {template.emoji}
        </span>
        <input
          ref={nameRef}
          className="nb-preview-name"
          value={name}
          aria-label="Notebook name"
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            // The sentence about the name the server chose is stale once it is edited.
            setRenamed(null);
          }}
        />
      </div>
      <p className="nb-template-line">{template.description}</p>

      {renamed && (
        <p className="nb-preview-clash">
          “{renamed.from}” was taken while you were choosing, so this one is “{renamed.to}”.
        </p>
      )}
      {clash && !renamed && (
        <p className="nb-preview-clash">
          You already have a notebook called “{clash}”, so this one gets a name of its own.
        </p>
      )}
      {nameTaken && !renamed && !(clash && sameName(trimmed, clash)) && (
        <p className="nb-preview-clash">There is already a notebook called “{trimmed}”. Choose another name.</p>
      )}

      <p className="nb-preview-label">
        {template.fields.length} field{template.fields.length === 1 ? '' : 's'}
      </p>
      <ul className="nb-preview-fields">
        {template.fields.map((f) => (
          <li key={f.name}>
            <FieldGlyph field={f} />
            {/* One run of text, so a kind too long for the line wraps under the name
                rather than under the glyph. */}
            <span className="nb-preview-field-text">
              <span className="nb-preview-field-name">{f.name}</span>{' '}
              <span className="nb-preview-field-kind">{describeField(f)}</span>
            </span>
          </li>
        ))}
      </ul>

      {error && <p className="bad small">{error}</p>}
      {offline && <p className="muted small nb-preview-offline">Making a notebook needs a connection.</p>}

      <div className="nb-preview-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !trimmed || nameTaken || offline}
          tip={offlineTitle}
        >
          Create notebook
        </Button>
        {clash && (
          <Button disabled={busy || offline} tip={offlineTitle} onClick={() => void addToExisting(clash)}>
            Add these fields to {clash}
          </Button>
        )}
        <Button variant="quiet" disabled={busy} onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}

/** The glyph a field's row carries on its notebook's page, so the chip is the same picture. */
function FieldGlyph({ field }: { field: NotebookFileField }) {
  return (
    <FieldTypeIcon
      type={field.type}
      rating={Boolean(field.scale)}
      currency={isCurrencyField({ type: field.type, scale: field.scale ?? null, currency: field.currency ?? null })}
    />
  );
}

/**
 * What kind of field it is, in words: the type, and what the type carries — a rating's
 * top, an amount's currency, a select's choices. The choices are the part people most
 * want to see before choosing, and a long list is cut rather than wrapped into a
 * paragraph; all of them are on the notebook's page once it exists.
 */
export function describeField(field: NotebookFileField): string {
  if (field.scale) return `Rating out of ${field.scale.max}${field.scale.step === 0.5 ? ', in halves' : ''}`;
  if (field.currency) return `Amount in ${field.currency}`;
  const label = FIELD_TYPE_LABELS[field.type];
  if (fieldHasOptions(field.type) && field.options?.length) {
    const shown = field.options.slice(0, 4).join(', ');
    return `${label}: ${shown}${field.options.length > 4 ? '…' : ''}`;
  }
  return label;
}
