import { composeInstructions, type InstructionNotebook } from './standing-instructions.js';

/**
 * The text "Copy for ChatGPT" puts on the clipboard: for ChatGPT's custom instructions
 * (Settings, then Personalization), which apply to every chat.
 *
 * ChatGPT reaches Unbent as a custom MCP server the person added, which it calls an app,
 * so the text names it the way ChatGPT does. It keeps to ChatGPT's own limit on custom
 * instructions, which `composeInstructions` enforces for all three (`INSTRUCTIONS_LIMIT`).
 * See `standing-instructions.ts`.
 */
export function chatgptInstructions(url: string, notebooks: InstructionNotebook[]): string {
  return composeInstructions(
    `I keep my notes in Unbent, a notes app I have added to ChatGPT as an app (its MCP server is ${url}). It is where I file things on purpose. Keep using your own memory as you do now; I will say when something belongs in Unbent.`,
    notebooks,
  );
}
