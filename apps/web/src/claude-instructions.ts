import { composeInstructions, type InstructionNotebook } from './standing-instructions.js';

/**
 * The text "Copy for Claude" puts on the clipboard: for Instructions for Claude
 * (Settings, then Your Claude), which Claude reads in every chat on every device.
 *
 * Account-wide, so it says what Unbent is and how Claude reaches it, and otherwise only
 * which requests mean it and what the notebooks are: a chat about anything else should
 * not feel it, and Claude's memory is left to do what it does. See
 * `standing-instructions.ts`.
 */
export function claudeInstructions(url: string, notebooks: InstructionNotebook[]): string {
  return composeInstructions(
    `I keep my notes in Unbent, a notes app I have added to Claude as a connector (its server is ${url}). It is where I file things on purpose. Keep using your own memory as you do now; I will say when something belongs in Unbent.`,
    notebooks,
  );
}
