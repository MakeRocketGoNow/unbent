import { grantIsRestricted, type AssistantGrant, type NotebookSummary } from '@unbent/shared';

/**
 * What a connected assistant was given (MAK-264), in the words the consent screen and
 * Settings both use. Pure, so the two cannot come to describe one grant differently:
 * the row in Connected apps and the sentence above Allow are the same function.
 *
 * The Inbox is the app's name for the notes filed in no notebook, here as in the rail.
 */

/** The notebooks of `grant` that still exist. A deleted notebook's id stays in a grant and counts for nothing. */
export function grantedNotebooks(grant: AssistantGrant, notebooks: readonly NotebookSummary[]): NotebookSummary[] {
  if (grant.notebooks === null) return [...notebooks];
  const ids = new Set(grant.notebooks);
  return notebooks.filter((nb) => ids.has(nb.id));
}

/** "2 notebooks and the Inbox", "1 notebook", "The Inbox only", "No notebooks": what a list of notebooks reaches. */
function reach(count: number, inbox: boolean): string {
  if (count === 0) return inbox ? 'The Inbox only' : 'No notebooks';
  const some = `${count.toLocaleString()} ${count === 1 ? 'notebook' : 'notebooks'}`;
  return inbox ? `${some} and the Inbox` : some;
}

/**
 * One line for a row in Connected apps: "All notebooks, can edit", "2 notebooks, read
 * only". Counted against the notebooks the account has now, so a grant that named a
 * notebook since deleted says what it reaches today.
 */
export function grantSummary(grant: AssistantGrant, notebooks: readonly NotebookSummary[]): string {
  const seen = grant.notebooks === null ? 'All notebooks' : reach(grantedNotebooks(grant, notebooks).length, grant.unfiled);
  return `${seen}, ${grant.readOnly ? 'read only' : 'can edit'}`;
}

/**
 * What allowing this grant means, as the sentence the consent screen puts above its
 * buttons. `who` is the app's name, or "An application".
 *
 * Said in full each time, since it is the thing being agreed to: what it can read,
 * then what it can do with it. The whole library is said as "every note you have",
 * which is what the screen has always said and still the plainest way to say it.
 */
export function grantSentence(who: string, grant: AssistantGrant, notebooks: readonly NotebookSummary[]): string {
  const it = who === 'An application' ? 'it' : who;
  // Nothing picked yet is not a grant to describe: what it could do with no notes is
  // beside the point, and the screen will not allow it as it stands.
  if (grant.notebooks !== null && grantedNotebooks(grant, notebooks).length === 0 && !grant.unfiled) {
    return `No notebook is picked yet, so ${it} would not be able to read any of your notes.`;
  }
  let reads: string;
  if (grant.notebooks === null) {
    reads = 'every note you have';
  } else {
    const count = grantedNotebooks(grant, notebooks).length;
    if (count === 0) reads = 'the notes in your Inbox';
    else {
      const where = count === 1 ? 'the 1 notebook you picked' : `the ${count.toLocaleString()} notebooks you picked`;
      reads = grant.unfiled ? `the notes in ${where} and in your Inbox` : `the notes in ${where}`;
    }
  }
  const rest = grant.notebooks === null ? '' : ', and nothing else';
  const does = grant.readOnly
    ? 'It will not be able to change anything.'
    : grant.notebooks === null
      ? 'It will also be able to create notes, change them, and move them to the trash (the same things you can do).'
      : 'There, it will also be able to create notes, change them, and move them to the trash.';
  return `If you allow it, ${it} will be able to read ${reads}${rest}. ${does}`;
}

/** Whether a grant can be allowed as it stands: "only some notebooks" with nothing picked gives an assistant nothing to do. */
export function grantIsEmpty(grant: AssistantGrant): boolean {
  return grant.notebooks !== null && grant.notebooks.length === 0 && !grant.unfiled;
}

/**
 * The consent screen's answer, as the two requests it is: the grant saved, then the
 * provider told. Here rather than in the screen so the order has a test, because the
 * order is the safety of it.
 *
 * For an app connecting for the first time, a saved grant does nothing until the
 * provider records a consent, so saving first and failing after gives the app nothing.
 * Consenting first would connect it with the whole library and restrict it a moment
 * later, or not at all if the second request failed. So a grant that does not save ends
 * it: the provider is never asked. A refusal saves nothing.
 *
 * An app that is already connected is the other case, and the provider can bring
 * someone back here for one. Its consent stands whatever happens on this screen, so the
 * grant saved here is in force the moment it is saved. If the provider then fails, the
 * person is told it did not work, and it must not have: `before`, what the app had been
 * given when the screen opened, is put back. Without that, choosing "All notebooks" for
 * an app held to two and then meeting an error would leave it with the library under a
 * message saying nothing happened.
 *
 * Answers with where the browser goes next, which is the provider's to say.
 */
export async function answerConsent(
  accept: boolean,
  clientId: string,
  grant: AssistantGrant,
  io: {
    save: (clientId: string, grant: AssistantGrant) => Promise<void>;
    consent: (accept: boolean) => Promise<{ data?: { url?: string } | null; error?: { message?: string } | null }>;
  },
  before?: AssistantGrant,
): Promise<{ url: string } | { error: string }> {
  const failed = 'That did not work. Try connecting again.';
  let saved = false;
  // What the app had before, back in place; its own failure changes nothing we can say.
  const undo = async () => {
    if (saved && before) await io.save(clientId, before).catch(() => {});
  };
  try {
    if (accept) {
      await io.save(clientId, grant);
      saved = true;
    }
    const result = await io.consent(accept);
    const url = result.error ? undefined : result.data?.url;
    if (url) return { url };
    await undo();
    return { error: result.error ? result.error.message || failed : 'The sign-in service did not say where to go next.' };
  } catch (err) {
    await undo();
    return { error: (err as Error).message || failed };
  }
}

export { grantIsRestricted };
