import { composeInstructions, type InstructionNotebook } from './standing-instructions.js';

/**
 * The text "Copy for a Claude Project" puts on the clipboard: the instructions of a
 * Project kept for filing, which apply to the chats inside it and nowhere else.
 *
 * What a project adds over the account-wide text is that every message in it can be read
 * as something to file or look up, so a line typed on a phone needs no verb at all. That
 * is said here and not in `claudeInstructions`, where it would turn every unrelated chat
 * into a filing attempt. A project is the one place the person has chosen Unbent over
 * the assistant's memory for everything, so the text may say so.
 */
export function claudeProjectInstructions(url: string, notebooks: InstructionNotebook[]): string {
  return composeInstructions(
    `This project is for filing into Unbent, my notes app, and looking things up there. Unbent is added to Claude as a connector (its server is ${url}).

Read each message here as something to file or something to look up, unless I say otherwise. A bare line with no verb is a note to file: work out which notebook from the notebooks' purposes and fields, and ask only when nothing fits or a field it needs is missing.`,
    notebooks,
  );
}
