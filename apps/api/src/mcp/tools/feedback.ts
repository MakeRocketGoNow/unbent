import { z } from 'zod';
import { FEEDBACK_CATEGORIES, FEEDBACK_MAX_CHARS, type FeedbackCategory } from '@unbent/shared';
import { FEEDBACK_PER_DAY, recordFeedback, type FeedbackDb } from '../../lib/assistant-feedback.js';
import type { Registrar } from '../plan-gate.js';
import { toolError } from './result.js';

const categories = Object.keys(FEEDBACK_CATEGORIES) as [FeedbackCategory, ...FeedbackCategory[]];

/**
 * `send_feedback` (MAK-212): the assistant's word to whoever runs this instance about the
 * tools themselves, kept for the operator page (`lib/assistant-feedback.ts` says why
 * there, and how it is bounded).
 *
 * The description is most of the feature. It says when to call, so the model reaches for
 * it at the moment it worked round something rather than at the end of a session, when
 * it has forgotten; and it says what never to put in, because the text is free and the
 * model has the person's notes in its context. The operator page names the account the
 * feedback came from, so a quoted note there is a note read by someone it was not
 * written for. The privacy policy states the same rule, and that the model is told it.
 *
 * Not gated by the plan (`ALLOWED_INACTIVE`): it writes nothing of the person's, and a
 * lapsed account's assistant refused at every write is exactly one with something to say.
 * Not read-only either, which is honest and has a use: a client that asks before a
 * write asks before this, so the person sees what is being sent.
 */
export function registerFeedbackTool(server: Registrar, db: FeedbackDb, caller: { userId: string; clientId: string }) {
  server.registerTool(
    'send_feedback',
    {
      title: 'Send feedback about these tools',
      description:
        'Tell the people who run this Unbent instance about something in these tools that got ' +
        'in your way, or that worked well, so they can improve them. Call it when it happens, ' +
        'not at the end: a tool answered something wrong, incomplete or hard to use ' +
        '(tool-result); an error did not say how to recover (error-message); the person asked ' +
        'for something no tool can do (missing-capability); a description misled you ' +
        '(tool-description); a call was slow (performance); something worked notably well ' +
        '(praise). One call per point, written as a bug report: what you called, what came ' +
        'back, what you expected. Never include anything from the person\'s notes: no note ' +
        'text, titles, names, addresses, amounts or file names. Describe the shape instead ' +
        '("a title with brackets in it", "a note with a 40-page PDF"). The operator reads it ' +
        'with the account it came from; no reply comes back here. Tell the person in a line ' +
        'that you sent it.',
      inputSchema: z.object({
        category: z.enum(categories),
        feedback: z.string().trim().min(1).max(FEEDBACK_MAX_CHARS),
        tool: z
          .string()
          .trim()
          .max(64)
          .optional()
          .describe('The tool the feedback is about, by name, when it is about one.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ category, feedback, tool }) => {
      const outcome = await recordFeedback(db, { ...caller, category, tool: tool || null, body: feedback });
      if (outcome === 'repeat') {
        return toolError('This was already sent in the last day, word for word, so it was not kept again. There is no need to send it twice.');
      }
      if (outcome === 'full') {
        return toolError(
          'This instance has taken all the feedback it keeps for today, so this one was not kept. ' +
            'Carry on with what the person asked for; there is no need to tell them.',
        );
      }
      if (outcome === 'limit') {
        return toolError(
          `This account has sent its ${FEEDBACK_PER_DAY} pieces of feedback for the last day, so this one was not kept. ` +
            'Carry on with what the person asked for; there is no need to tell them.',
        );
      }
      return { content: [{ type: 'text' as const, text: 'Sent. Thank you: the operator of this instance reads these.' }] };
    },
  );
}
