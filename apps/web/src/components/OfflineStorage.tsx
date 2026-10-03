import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { notebookFilesQuery, notebooksQuery } from '../queries.js';
import { useKeeper, useSyncStatus } from '../store/use-outbox.js';
import { currentLibraryUser } from '../store/library.js';
import { listShelf, storagePersisted } from '../store/files.js';
import { FILES_BUDGET, openedFilesUsage } from '../sw/budget.js';
import { FILES_CACHE } from '../sw/routes.js';
import { formatBytes } from '../format-bytes.js';
import { Button } from './Button';
import { Confirm } from './Confirm.js';
import { useDeviceRoom } from './KeepOffline.js';

const count = (n: number) => `${n.toLocaleString()} file${n === 1 ? '' : 's'}`;

/**
 * What this device holds of the account's files, and the way to give the room back.
 *
 * Three things take room, and they are listed apart because each is there for a different
 * reason and leaves a different way: notebooks someone chose to keep (until they stop),
 * files they opened (within a budget, oldest-opened out first, or all at once from here),
 * and files added with no connection that have not uploaded yet (until they do — there is
 * no button for those, since removing one would be deleting the only copy).
 *
 * A settings page rather than a line under each notebook: "what is using my phone's
 * storage" is asked about the device as a whole, usually when the phone has just
 * complained, and the answer has to be in one place with the buttons beside it.
 */
export function OfflineStorage() {
  const { keeper, status } = useKeeper();
  const sync = useSyncStatus();
  const room = useDeviceRoom();
  const notebooks = useQuery(notebooksQuery()).data?.notebooks ?? [];
  const kept = notebooks.filter((nb) => status.kept.has(nb.id));

  const [opened, setOpened] = useState<{ files: number; bytes: number } | null>(null);
  const [waiting, setWaiting] = useState<{ files: number; bytes: number }>({ files: 0, bytes: 0 });
  /** Whether the browser has agreed not to clear this storage under pressure; null until it says, or where it will not. */
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const refresh = useCallback(async () => {
    setOpened(await openedFilesUsage());
    setPersisted(await storagePersisted());
    const user = currentLibraryUser();
    const shelf = user ? await listShelf(user, 'pending').catch(() => []) : [];
    setWaiting({ files: shelf.length, bytes: shelf.reduce((sum, f) => sum + f.size, 0) });
  }, []);
  // Again when the outbox moves: an upload going through takes a file off the shelf.
  useEffect(() => {
    void refresh();
  }, [refresh, sync.pending]);

  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      setAsking(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel offline-storage">
      <div className="panel-head">
        <h2>Offline</h2>
      </div>
      <p className="muted small">
        Your notes are always on this device. Their files are kept when you open one, and for whole notebooks you choose.
        {room ? ` Unbent is using ${formatBytes(room.usage)} of the ${formatBytes(room.quota)} this device allows it.` : ''}
        {/* Said only when it is not so: what is kept here can then go without a word, and
            someone relying on it for a flight should know before the flight. */}
        {persisted === false && ' This browser has not agreed to keep it if the device runs low on space; installing the app usually settles that.'}
      </p>

      <section className="notebook-section">
        <h3 className="notebook-section-head">Kept notebooks</h3>
        {!status.supported ? (
          <p className="muted small">This browser cannot keep whole notebooks. Files you open are still kept.</p>
        ) : kept.length === 0 ? (
          <p className="muted small">
            None yet. Open a notebook from <Link to="/settings/notebooks" className="link">Notebooks</Link> and choose Keep offline.
          </p>
        ) : (
          <>
            <ul className="offline-kept">
              {kept.map((nb) => (
                <KeptRow
                  key={nb.id}
                  id={nb.id}
                  name={nb.name}
                  asking={asking === nb.id}
                  busy={busy}
                  onAsk={() => setAsking(nb.id)}
                  onCancel={() => setAsking(null)}
                  onRelease={() => run(() => keeper!.release(nb.id))}
                />
              ))}
            </ul>
            <p className="muted small" aria-live="polite">
              {!status.counted
                ? 'Counting…'
                : status.have.files >= status.wanted.files
                ? `All ${count(status.wanted.files)} are on this device, ${formatBytes(status.wanted.bytes)}.`
                : `${status.have.files.toLocaleString()} of ${count(status.wanted.files)} on this device so far, ${formatBytes(status.have.bytes)} of ${formatBytes(status.wanted.bytes)}.`}
            </p>
            {status.problem && <p className="bad small">{status.problem}</p>}
          </>
        )}
      </section>

      <section className="notebook-section">
        <h3 className="notebook-section-head">Opened files</h3>
        <p className="muted small">
          {opened === null || opened.files === 0
            ? 'Nothing kept from opening files yet.'
            : `${count(opened.files)} you have opened, ${formatBytes(opened.bytes)}.`}{' '}
          Up to {Math.round(FILES_BUDGET.maxBytes / 1024 ** 2)} MB is kept; the ones opened longest ago go first.
        </p>
        <Button variant="secondary" disabled={busy || !opened || opened.files === 0} onClick={() => setAsking('opened')}>
          Remove opened files
        </Button>
        {asking === 'opened' && opened && (
          <Confirm
            label="Confirm remove opened files"
            question={<>Remove {count(opened.files)} from this device?</>}
            detail={`${formatBytes(opened.bytes)}. They stay in your account, and are kept again when you next open them.`}
            busy={busy}
            onCancel={() => setAsking(null)}
            actions={[{ label: 'Remove from this device', busyLabel: 'Removing…', tone: 'danger', onConfirm: () => run(() => caches.delete(FILES_CACHE)) }]}
          />
        )}
      </section>

      {waiting.files > 0 && (
        <section className="notebook-section">
          <h3 className="notebook-section-head">Waiting to upload</h3>
          <p className="muted small">
            {count(waiting.files)}, {formatBytes(waiting.bytes)}, added with no connection. They leave this list as they upload.
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * One kept notebook: its name, which goes to its page; what it holds; and Stop keeping,
 * quiet because it repeats down the list.
 */
function KeptRow({ id, name, asking, busy, onAsk, onCancel, onRelease }: { id: string; name: string; asking: boolean; busy: boolean; onAsk: () => void; onCancel: () => void; onRelease: () => void }) {
  const size = useQuery(notebookFilesQuery(id)).data ?? { files: 0, bytes: 0 };
  return (
    <li className="offline-kept-row">
      <div className="offline-kept-info">
        <Link to="/settings/notebooks/$notebookId" params={{ notebookId: id }} className="link offline-kept-name">
          {name}
        </Link>
        <span className="muted small">
          {count(size.files)}, {formatBytes(size.bytes)}
        </span>
      </div>
      <Button variant="quiet" size="small" disabled={busy} onClick={onAsk}>
        Stop keeping
      </Button>
      {asking && (
        <Confirm
          label="Confirm stop keeping"
          question={<>Remove the files in “{name}” from this device?</>}
          detail={`${formatBytes(size.bytes)}. They stay in your account, and need a connection to open.`}
          busy={busy}
          onCancel={onCancel}
          actions={[{ label: 'Remove from this device', busyLabel: 'Removing…', tone: 'danger', onConfirm: onRelease }]}
        />
      )}
    </li>
  );
}
