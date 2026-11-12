import { setThemeChoice, useTheme, useThemeChoice, type ThemeChoice } from '../theme.js';

const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Light, dark, or the device's: Settings › Appearance.
 *
 * A page of its own for one choice, rather than a switch in the chrome. A theme is set
 * once and then forgotten, so a control on every view would spend room on every visit for
 * a decision made on one, and the account menu holds the account, not the app (see
 * `AccountMenu`). A settings page is also where all three answers belong: the case for a
 * two-state toggle is a control that is always on screen, and this one is read on
 * purpose. See `theme.ts` for why Auto has to be an answer you can pick.
 *
 * Three tiles that each draw the app in their theme, rather than three words: what a
 * theme is is how it looks, and a picture says it before the label is read. Auto's tile
 * is both halves, the way the device's own setting usually draws it. They are real radio
 * buttons under the drawing, so arrow keys move between them and a screen reader hears
 * one choice of three, with the tile as the label's hit area.
 *
 * The line under them says what Auto means right now, since "Auto" alone does not say
 * which theme it is showing, and that is the question someone on this page has.
 */
export function Appearance() {
  const choice = useThemeChoice();
  const theme = useTheme();

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Appearance</h2>
      </div>

      <fieldset className="theme-choices">
        <legend className="visually-hidden">Theme</legend>
        {CHOICES.map(({ value, label }) => (
          <label key={value} className="theme-choice">
            <ThemePreview kind={value} />
            <span className="theme-choice-label">
              <input
                type="radio"
                name="theme"
                value={value}
                checked={choice === value}
                onChange={() => setThemeChoice(value)}
              />
              {label}
            </span>
          </label>
        ))}
      </fieldset>

      <p className="muted small" aria-live="polite">
        {choice === 'auto'
          ? `Follows this device, which is ${theme} now, and changes when it does.`
          : 'Kept on this device only. Your other devices keep their own.'}
      </p>
    </section>
  );
}

/**
 * The app in miniature: a rail, a heading, two lines of text and a green chip, in the
 * theme's own colours rather than the page's, so Dark's tile is dark on a light page.
 */
function ThemePreview({ kind }: { kind: ThemeChoice }) {
  return (
    <span className={`theme-preview theme-preview-${kind}`} aria-hidden="true">
      <Mini palette={kind === 'dark' ? 'dark' : 'light'} />
      {kind === 'auto' && <Mini palette="dark" />}
    </span>
  );
}

function Mini({ palette }: { palette: 'light' | 'dark' }) {
  return (
    <span className="theme-mini" data-theme={palette}>
      <span className="theme-mini-rail" />
      <span className="theme-mini-body">
        <span className="theme-mini-line theme-mini-head" />
        <span className="theme-mini-line" />
        <span className="theme-mini-line theme-mini-short" />
        <span className="theme-mini-chip" />
      </span>
    </span>
  );
}
