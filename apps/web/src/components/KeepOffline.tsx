import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { notebookFilesQuery } from '../queries.js';
import { useKeeper } from '../store/use-outbox.js';
import { useOffline } from '../connectivity.js';
import { formatBytes } from '../format-bytes.js';
import { Button } from './Button';
import { Confirm } from './Confirm.js';

/** What the browser will let this site store, less what it already has. Null where it will not say. */
export function useDeviceRoom(): { usage: number; quota: number; free: number } | null {
  const [room, setRoom] = useState<{ usage: number; quota: number; free: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void navigator.storage
      ?.estimate?.()
      .then((e) => {
        if (alive && e.quota !== undefined && e.usage !== undefined) setRoom({ usage: e.usage, quota: e.quota, free: Math.max(0, e.quota - e.usage) });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return room;
}

const count = (n: number) => `${n.toLocaleString()} file${n === 1 ? '' : 's'}`;

/**
 * "Keep offline" for one notebook: a section of its page, with the cost stated before
 * anything is fetched.
 *
 * The notebook's rows are on the device already; this is about its files, which are the
 * bulk of an archive and cannot all be on a phone. So keeping is asked for per notebook,
 * and the question names the size — "Keep 1.2 GB on this device?" — and what the device
 * has room for, from the browser's own estimate. That number is the point of the
 * confirmation, not decoration: the real archive is three gigabytes in thirteen thousand
 * files, and a toggle that started fetching that on a tap would be a mistake someone
 * finds out about from their phone's storage warning.
 *
 * A section with a button and an inline `Confirm`, like Delete below it, rather than a
 * switch: a switch says "this is on now", and this is on only once gigabytes have
 * arrived. What it shows while kept is how much has — the one thing someone about to
 * board a plane wants to know.
 *
 * Not drawn at all where files cannot be kept (a browser without the file system, or a
 * device with no local copy of the library): a control that could only ever refuse is
 * worse than none.
 */
export function KeepOffline({ notebookId, name }: { notebookId: string; name: string }) {
  const { keeper, status } = useKeeper();
  const offline = useOffline();
  const size = useQuery(notebookFilesQuery(notebookId)).data ?? { files: 0, bytes: 0 };
  const room = useDeviceRoom();
  const [asking, setAsking] = useState<'keep' | 'release' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A question about one notebook must not be standing when the page shows another.
  useEffect(() => {
    setAsking(null);
    setError(null);
  }, [notebookId]);

  if (!keeper || !status.supported) return null;
  const kept = status.kept.has(notebookId);
  const fits = room === null || size.bytes <= room.free;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setAsking(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /*
     How far along, in the keeper's own totals when this is the only notebook kept, and
     otherwise in words that do not claim a number: the keeper counts every kept notebook
     together, and a second notebook's progress is not this one's.
  */
  const alone = kept && status.kept.size === 1;
  const complete = status.counted && status.have.files >= status.wanted.files;
  const later = offline ? ' The rest will be fetched when there is a connection.' : '';
  function progress(): string {
    if (!status.counted) return '';
    if (size.files === 0) return 'It has no files yet. Files added to it are kept as they arrive.';
    if (complete) return `${alone ? 'All' : 'Its'} ${count(size.files)} are on this device, ${formatBytes(size.bytes)}.`;
    if (alone) {
      return `${status.have.files.toLocaleString()} of ${count(status.wanted.files)} on this device so far, ${formatBytes(status.have.bytes)} of ${formatBytes(status.wanted.bytes)}.${later}`;
    }
    return `Its ${count(size.files)}, ${formatBytes(size.bytes)}, are being fetched with the other kept notebooks’.${later}`;
  }

  return (
    <section className="notebook-section">
      <h3 className="notebook-section-head">Keep offline</h3>
      {kept ? (
        <>
          <p className="muted small" aria-live="polite">
            <strong>{name}</strong> is kept on this device, so its files open with no connection. {progress()}
          </p>
          {status.problem && <p className="bad small">{status.problem}</p>}
          <Button variant="secondary" disabled={busy} onClick={() => setAsking('release')}>
            Stop keeping
          </Button>
        </>
      ) : (
        <>
          <p className="muted small">
            Keep the files in <strong>{name}</strong> on this device, so they open with no connection.{' '}
            {size.files === 0 ? 'It has no files yet.' : `${count(size.files)}, ${formatBytes(size.bytes)}.`}
          </p>
          <Button variant="secondary" disabled={busy} onClick={() => setAsking('keep')}>
            Keep offline
          </Button>
        </>
      )}

      {asking === 'keep' &&
        (fits ? (
          <Confirm
            label="Confirm keep offline"
            question={size.files === 0 ? <>Keep “{name}” on this device?</> : <>Keep {formatBytes(size.bytes)} on this device?</>}
            detail={
              <>
                {size.files === 0 ? 'It has no files yet.' : `${count(size.files)} in “${name}”.`}
                {room ? ` This device has room for about ${formatBytes(room.free)}.` : ''} Files added to the notebook later are kept too.
                {offline ? ' They will be fetched when there is a connection.' : ''}
              </>
            }
            busy={busy}
            onCancel={() => setAsking(null)}
            actions={[{ label: 'Keep offline', busyLabel: 'Keeping…', tone: 'primary', onConfirm: () => run(() => keeper.keep(notebookId)) }]}
          />
        ) : (
          // The same box with no action in it: the answer to "keep this?" is that it does
          // not fit, said where the question would have been, and Cancel is the way out.
          <Confirm
            label="Not enough room to keep offline"
            question="There is not enough room on this device."
            detail={`“${name}” is ${formatBytes(size.bytes)}, and this device has room for about ${formatBytes(room.free)}.`}
            onCancel={() => setAsking(null)}
            actions={[]}
          />
        ))}

      {asking === 'release' && (
        <Confirm
          label="Confirm stop keeping"
          question={<>Remove the files in “{name}” from this device?</>}
          detail={`${size.files === 0 ? 'Nothing to remove yet.' : `${formatBytes(size.bytes)}.`} They stay in your account, and need a connection to open.`}
          busy={busy}
          onCancel={() => setAsking(null)}
          actions={[{ label: 'Remove from this device', busyLabel: 'Removing…', tone: 'danger', onConfirm: () => run(() => keeper.release(notebookId)) }]}
        />
      )}
      {error && <p className="bad small">{error}</p>}
    </section>
  );
}
