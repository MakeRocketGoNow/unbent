import { Sheet } from './Sheet.js';
import { AccountMenu } from './AccountMenu.js';
import { NotebookNav, type NotebookData } from './NotebookNav.js';

interface NotebookDrawerProps {
  open: boolean;
  onClose: () => void;
  notebook: string | undefined;
  /** Selected tags, only to know whether "All notes" is the current scope. */
  selectedTags: string[];
  notebooks: { data: NotebookData | undefined };
  trashed: number;
  email: string;
  onSignOut: () => void;
}

/**
 * Where the notes are, on a phone: `NotebookNav` in a sheet from the side.
 *
 * The notebooks, the trash and the account come out of the filter sheet and out of the
 * topbar, into the surface Evernote, Apple Notes and the Android app all use for them.
 * That is what lets the note list keep a single row of chrome: it has a heading naming
 * the notebook, and everything that heading refers to is one tap behind the ☰ beside it.
 *
 * The rows themselves, and the reasoning behind their order, are `NotebookNav`'s. What is
 * the drawer's own: it closes once a scope is picked, because the list behind it has
 * changed; and the account sits in its head beside the wordmark — where Keep's avatar sits
 * relative to its drawer, and out of the way of the rows that navigate — since on a phone
 * this is the only place the account is.
 */
export function NotebookDrawer({
  open,
  onClose,
  notebook,
  selectedTags,
  notebooks,
  trashed,
  email,
  onSignOut,
}: NotebookDrawerProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Unbent"
      side="start"
      headAction={<AccountMenu email={email} onSignOut={onSignOut} />}
    >
      <NotebookNav
        notebook={notebook}
        selectedTags={selectedTags}
        notebooks={notebooks}
        trashed={trashed}
        onNavigate={onClose}
      />
    </Sheet>
  );
}
