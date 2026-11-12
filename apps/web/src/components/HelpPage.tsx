import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { supportLink } from '../support-link.js';
import { buildInfo, feedbackUrl, type BuildInfo } from '../build-info.js';
import { BackArrow } from './BackArrow.js';
import { McpUrl } from './McpUrl.js';

/** Whether this device's shortcuts are written with ⌘ and ⌥ rather than Ctrl and Alt. */
function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/**
 * A shortcut as this device writes it: `['mod', 'shift', 'T']` is ⌘⇧T on a Mac and
 * Ctrl+Shift+T everywhere else.
 *
 * The toolbar's own tips say ⌘ everywhere, which is good enough for a hover; a page whose
 * whole purpose is to be read for the keys has to be right on a Windows or Linux keyboard
 * too, and CodeMirror's `Mod` is Ctrl there.
 */
function keys(apple: boolean, ...parts: string[]): string {
  const glyph: Record<string, [string, string]> = {
    mod: ['⌘', 'Ctrl'],
    shift: ['⇧', 'Shift'],
    alt: ['⌥', 'Alt'],
  };
  const named = parts.map((p) => glyph[p]?.[apple ? 0 : 1] ?? p);
  return apple ? named.join('') : named.join('+');
}

export interface FormatRow {
  name: string;
  writes: string;
  shortcut: string[] | null;
}

/**
 * The formatting bar, in its own order, with what each button writes into the note.
 *
 * Taken from `EditorToolbar`'s actions and `markdownKeymap` in `markdown-commands.ts`; a
 * button added or a key rebound there belongs here as well, and the test fails on a key
 * that the keymap no longer binds. The Markdown column is the
 * point: a note is plain Markdown underneath, and knowing what a button writes is what
 * lets someone type it instead, or read a note exported to a file.
 */
export const FORMATS: FormatRow[] = [
  { name: 'Bold', writes: '**text**', shortcut: ['mod', 'B'] },
  { name: 'Italic', writes: '_text_', shortcut: ['mod', 'I'] },
  { name: 'Strikethrough', writes: '~~text~~', shortcut: ['mod', 'shift', 'X'] },
  { name: 'Code', writes: '`text`', shortcut: ['mod', 'E'] },
  { name: 'Heading 1', writes: '# Heading', shortcut: ['mod', 'alt', '1'] },
  { name: 'Heading 2', writes: '## Heading', shortcut: ['mod', 'alt', '2'] },
  { name: 'Quote', writes: '> text', shortcut: ['mod', 'shift', '9'] },
  { name: 'Bullet list', writes: '- item', shortcut: ['mod', 'shift', '8'] },
  { name: 'Task list', writes: '- [ ] item', shortcut: null },
  { name: 'Link', writes: '[text](url)', shortcut: ['mod', 'K'] },
  // No keys: the editor binds Mod-Shift-T, but a browser tab keeps Ctrl+Shift+T (and
  // ⌘⇧T) for reopening a closed tab, so in a tab the key never reaches the page. Promising
  // it here would send someone to a key that reopens their last tab instead.
  { name: 'Table', writes: '| a | b |', shortcut: null },
];

/**
 * Help, `/help`: how the editor writes, the keys, and where import, export and the
 * assistants live (MAK-116).
 *
 * A page in the app rather than a section of the public support page: what it explains is
 * the app in front of the reader, and "how do I make a table" should be answered without
 * leaving it. The two divide the work: this one is how the app works, `/support` is the
 * account and the people behind it (a charge, signing in, a bug), and this page ends by
 * pointing there for anything it does not answer.
 *
 * Shown on every instance, unlike Support: nothing here depends on who runs it, and a
 * self-hosted copy's people need the table shortcut as much as anyone.
 *
 * Settings' frame without its tabs (the heading row, the phone's back arrow, the panels)
 * since it is read the way a settings page is: down, once, by someone looking for one
 * thing. Short on purpose; each panel says where the rest is rather than repeating it.
 */
export function HelpPage({ build = buildInfo }: { build?: BuildInfo | null }) {
  const config = useQuery(configQuery());
  const support = supportLink(config.data);
  const feedback = build ? feedbackUrl(build) : null;
  const apple = isApple();

  return (
    <div className="settings help">
      <div className="settings-head">
        <Link to="/notes" className="view-back" aria-label="Back to notes">
          <BackArrow />
        </Link>
        <h2>Help</h2>
      </div>

      <div className="settings-body">
        <Topic title="Formatting">
          <p className="muted small">
            A note is Markdown underneath. The bar above a note writes it for you, and typing
            the same characters works just as well. Rich shows the formatting as you write,
            Source shows the characters, and Read shows the finished note.
          </p>
          <table className="help-table">
            <thead>
              <tr>
                <th scope="col">Button</th>
                <th scope="col">Writes</th>
                <th scope="col">Keys</th>
              </tr>
            </thead>
            <tbody>
              {FORMATS.map((row) => (
                <tr key={row.name}>
                  <th scope="row">{row.name}</th>
                  <td>
                    <code>{row.writes}</code>
                  </td>
                  <td>{row.shortcut ? <kbd>{keys(apple, ...row.shortcut)}</kbd> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Not a row: the table is the bar, and the bar stops at Heading 2. */}
          <p className="muted small">
            A third-level heading (<code>### Heading</code>) has no button:{' '}
            <kbd>{keys(apple, 'mod', 'alt', '3')}</kbd> makes one.
          </p>
        </Topic>

        <Topic title="Tables">
          <p className="muted small">
            Press the table button in the bar and pick a size from the grid. In a table,{' '}
            <kbd>Tab</kbd> moves to the next cell and adds a row at the end, and{' '}
            <kbd>{keys(apple, 'mod', 'shift', 'F')}</kbd> lines the columns up.
          </p>
        </Topic>

        <Topic title="Keys">
          <dl className="help-keys">
            <div>
              <dt>
                <kbd>{keys(apple, 'mod', 'F')}</kbd>
              </dt>
              <dd>Search your notes</dd>
            </div>
            <div>
              <dt>
                <kbd>↑</kbd> <kbd>↓</kbd>
              </dt>
              <dd>Move through the list, from the search field or the list itself</dd>
            </div>
            <div>
              <dt>
                <kbd>Enter</kbd>
              </dt>
              <dd>Start writing in the note you are on</dd>
            </div>
            <div>
              <dt>
                <kbd>{keys(apple, 'mod', 'A')}</kbd>
              </dt>
              <dd>Select every note in the list, to move, tag or delete them together</dd>
            </div>
            <div>
              <dt>
                <kbd>Tab</kbd> <kbd>{keys(apple, 'shift', 'Tab')}</kbd>
              </dt>
              <dd>Indent or outdent a list item while writing</dd>
            </div>
            <div>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>Close search</dd>
            </div>
          </dl>
        </Topic>

        <Topic title="Bringing notes in">
          <p className="muted small">
            <Link to="/settings/import">Settings, then Import</Link> takes an Evernote export
            (<code>.enex</code>), a Notion or Joplin export, an Unbent export from this app or
            any other, and PDFs or images, one note per file. Notebooks, tags and files come
            across with the notes.
          </p>
        </Topic>

        <Topic title="Getting notes out">
          <p className="muted small">
            <Link to="/settings/export">Settings, then Export</Link> gives you every note as a
            Markdown file with its files beside it, at any time.
          </p>
        </Topic>

        <Topic title="Connecting an AI assistant">
          <p className="muted small">
            Claude, ChatGPT, Cursor and other assistants that speak MCP can search, read and
            write your notes. Add this address as a connector in the assistant, and approve it
            when asked:
          </p>
          <p>
            <McpUrl />
          </p>
          <p className="muted small">
            <Link to="/settings/connected-apps">Settings, then AI assistants</Link> has the
            steps for each one, and lists what is connected.
          </p>
        </Topic>

        {(support || feedback) && (
          <Topic title="Something else">
            <p className="muted small">
              {support?.kind === 'page' && (
                <>
                  <Link to={support.to}>Support</Link> answers questions about your plan,
                  signing in and your account, and says how to reach a person.{' '}
                </>
              )}
              {support?.kind === 'mail' && (
                <>
                  Write to <a href={support.href}>{support.email}</a> for anything this page
                  does not answer.{' '}
                </>
              )}
              {feedback && (
                <>
                  Found a bug or want something changed?{' '}
                  <a href={feedback} target="_blank" rel="noopener noreferrer">
                    Send feedback
                  </a>
                  .
                </>
              )}
            </p>
          </Topic>
        )}
      </div>
    </div>
  );
}

/** One panel: a heading and what is under it, as the settings pages draw theirs. */
function Topic({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}
