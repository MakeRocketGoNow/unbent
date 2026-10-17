import { useCallback, useEffect, useState } from 'react';
import { sameName } from '@unbent/shared';
import * as api from '../notes-api.js';
import { Confirm } from './Confirm.js';
import { LabelEditor, type LabelItem } from './LabelEditor.js';
import { useExactCount } from './use-exact-count.js';

interface TagsProps {
  /** Called after any change, so every note list and open note refetch their tags. */
  onChanged: () => void;
}

/**
 * Tag management: rename, merge, delete.
 *
 * The page an Evernote import needs most and the one the app did not have. Tags arrived
 * by the hundred, with the same idea spelt three ways, and the only way to fix one was
 * to open every note carrying it. This is the notebooks page's editor over the tag list,
 * with the two things that differ: there is no create row, because a tag exists only on a
 * note and one with no note would vanish from this list the moment it was made; and a
 * rename that lands on an existing name is not an error but an offer to merge, which is
 * what "rename Recipts to Receipts" means when Receipts already exists.
 *
 * Both merging and deleting are irreversible, so both go through `Confirm` naming what
 * is at stake. A find field appears once the list is long enough to need one.
 */
export function Tags({ onChanged }: TagsProps) {
  const [tags, setTags] = useState<api.TagSummary[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<api.TagSummary | null>(null);
  /** A rename that collided, waiting to be confirmed as a merge. */
  const [pendingMerge, setPendingMerge] = useState<{ tag: api.TagSummary; into: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setTags(await api.listTags());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs a mutation, refreshes both this page and the app behind it. True when it went through. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      onChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const rename = async (item: LabelItem, name: string): Promise<boolean> => {
    const tag = tags?.find((t) => t.id === item.id);
    if (!tag) return false;
    setBusy(true);
    setError(null);
    try {
      await api.renameTag(tag.id, name);
      await refresh();
      onChanged();
      return true;
    } catch (err) {
      if (err instanceof api.ConflictError) {
        // Not a failure: the question is whether the two should become one.
        setPendingMerge({ tag, into: name });
        return false;
      }
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Found without case, as the server found it (MAK-127): renaming Bills to "receipts"
  // beside Receipts merges into Receipts, which keeps its spelling.
  const other = pendingMerge && tags?.find((t) => sameName(t.name, pendingMerge.into));
  const into = other ? other.name : pendingMerge?.into;
  const noteLabel = (n: number) => `${n} note${n === 1 ? '' : 's'}`;
  // What each confirm names, counted from the notes once it opens; see `useExactCount`.
  const mergeCount = useExactCount(
    pendingMerge ? { tag: pendingMerge.tag.name } : null,
    pendingMerge?.tag.count ?? 0,
  );
  const otherCount = useExactCount(other ? { tag: other.name } : null, other ? other.count : 0);
  const deleteCount = useExactCount(
    pendingDelete ? { tag: pendingDelete.name } : null,
    pendingDelete?.count ?? 0,
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Tags</h2>
      </div>

      {error && <p className="bad small">{error}</p>}

      <LabelEditor
        kind="tag"
        items={tags}
        busy={busy}
        editingId={pendingDelete?.id ?? pendingMerge?.tag.id ?? null}
        findable
        onRename={rename}
        onDelete={(item) => {
          const tag = tags?.find((t) => t.id === item.id);
          if (tag) setPendingDelete(tag);
        }}
        emptyText="No tags yet. A tag is added on a note."
        hint="Renaming a tag updates every note that carries it. Renaming one to a name that already exists offers to merge the two."
      />

      {pendingMerge && (
        <Confirm
          label="Confirm merge tags"
          question={
            <>
              A tag named <strong>{into}</strong> already exists. Merge{' '}
              <strong>{pendingMerge.tag.name}</strong> into it?
            </>
          }
          detail={`The ${noteLabel(mergeCount)} tagged ${pendingMerge.tag.name} will be tagged ${into} instead${other ? `, joining its ${noteLabel(otherCount)}` : ''}. This cannot be undone.`}
          busy={busy}
          onCancel={() => setPendingMerge(null)}
          actions={[
            {
              label: 'Merge tags',
              busyLabel: 'Merging…',
              tone: 'primary',
              onConfirm: () => {
                const { tag, into } = pendingMerge;
                void run(async () => {
                  await api.renameTag(tag.id, into, { merge: true });
                  setPendingMerge(null);
                });
              },
            },
          ]}
        />
      )}

      {pendingDelete && (
        <Confirm
          label="Confirm delete tag"
          question={
            <>
              Remove the tag <strong>{pendingDelete.name}</strong>?
            </>
          }
          detail={
            deleteCount > 0
              ? `It comes off ${noteLabel(deleteCount)}. The notes themselves stay.`
              : 'No live notes carry it.'
          }
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          actions={[
            {
              label: 'Remove tag',
              busyLabel: 'Removing…',
              tone: 'danger',
              onConfirm: () => {
                const id = pendingDelete.id;
                void run(async () => {
                  await api.deleteTag(id);
                  setPendingDelete(null);
                });
              },
            },
          ]}
        />
      )}
    </div>
  );
}
