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
    'This connection was given only some notebooks, so it cannot create or delete a notebook, or rename or delete a tag. The person can change what it may reach in Settings, under Connected apps.',
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
