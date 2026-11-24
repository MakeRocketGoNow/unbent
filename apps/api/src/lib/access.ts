import type { AssistantGrant } from '@unbent/shared';
import type { AccessRefusalReason } from '../store/access.js';

export { ACCESS_REFUSED_CODE, type AccessRefusalReason, type StoreAccess } from '../store/access.js';

/**
 * What a restricted connection is told when the store refuses its call (MAK-264): one
 * sentence per reason, written for an assistant to act on or relay, which is who reads
 * it. Each says what it may do instead, since a refusal that only says no leaves a
 * model trying the same call under another name.
 *
 * None names a notebook, a tag or a count from outside the grant, and `notebook` does
 * not say whether the name it was given exists: what the connection cannot see, it is
 * not told about by being refused either.
 */
const SENTENCES: Record<AccessRefusalReason, string> = {
  notebook:
    'This connection was given only some notebooks, and that is not one of them. Call list_notebooks to see the notebooks it can use, and name one of those.',
  unfiled:
    'This connection was given only some notebooks, so it cannot leave a note outside a notebook. Call list_notebooks and file the note in one of those.',
  manage:
    'This connection was given only some notebooks, so it cannot create or delete a notebook, or rename or delete a tag. The person can change what it may reach in Unbent, in Settings under AI assistants.',
  method: 'This connection was given only some notebooks, and that is not something it can do with them.',
};

/**
 * A restricted connection's call, refused by the store: rebuilt from its `AccessRefusal`
 * by `translateStoreError`, as `PlanRefused` is from a `PlanRefusal`, so a tool keeps
 * `instanceof` and the message is the sentence above. The MCP registrar turns it into a
 * tool error; nothing else can raise one, since only an assistant's connection is ever
 * restricted.
 */
export class AccessRefused extends Error {
  constructor(readonly reason: AccessRefusalReason) {
    super(SENTENCES[reason]);
    this.name = 'AccessRefused';
  }
}

export function isAccessRefusalReason(value: unknown): value is AccessRefusalReason {
  return typeof value === 'string' && Object.hasOwn(SENTENCES, value);
}

/**
 * What a listing says to a connection that was given only some notebooks, beside what
 * it lists: that the list is partial, and what to say when something is not in it.
 *
 * Without it an assistant reports the absence as a fact. "You have no note about the
 * boiler" is a wrong answer about someone's archive when the note is in a notebook the
 * assistant was not given, and it is the one failure a restriction would otherwise
 * introduce: everything it cannot see, it would confidently say is not there. It does
 * not say how many notebooks are withheld, or anything else about them.
 */
export const PARTIAL_NOTICE =
  'This connection was given only some of this account\'s notebooks, so this is not everything in it. If something is not here, say it was not found in the notebooks you can see, not that it does not exist.';

/**
 * The server's instructions for a restricted connection, which a client shows its model
 * once, when it connects: what it was not given, said up front, so the first thing an
 * assistant learns of a limit is not a refusal. Nothing for a connection given
 * everything, which is told what it always was: nothing.
 */
export function connectionInstructions(grant: AssistantGrant): string | undefined {
  const lines: string[] = [];
  if (grant.notebooks !== null) {
    lines.push(
      'The person gave this connection only some of their notebooks. Every tool here works within those: list_notebooks shows them, and notes anywhere else are not found, as if they did not exist. Notes can be filed only in those notebooks, and notebooks and tags cannot be created, renamed or deleted from here.',
    );
  }
  if (grant.readOnly) {
    lines.push('The person made this connection read only. It has no tool that creates, changes or deletes anything; if asked to, say that it was connected read only and that they can change that in Unbent, in Settings under AI assistants.');
  }
  return lines.length > 0 ? lines.join(' ') : undefined;
}
