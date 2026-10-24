import { z } from 'zod';

export const AGENT_ACTIONS = [
  'capture',
  'partial_capture',
  'request_evidence',
  'void',
  'escalate',
] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/**
 * What the model must return. Kept to plain types (no regex/refinements) so it maps cleanly to
 * every provider's structured-output schema; the policy layer does the real validation.
 */
export const agentDecisionSchema = z.object({
  action: z.enum(AGENT_ACTIONS),
  confidence: z.number().min(0).max(1).describe('How sure you are, from 0 to 1.'),
  captureAmount: z
    .string()
    .optional()
    .describe('USD decimal string such as "6.00". Only for partial_capture.'),
  reasoning: z.string().min(1).describe('Why you chose this action, for the ops team.'),
  evidenceSummary: z.string().min(1).describe('One or two sentences on what the evidence shows.'),
});
export type AgentDecision = z.infer<typeof agentDecisionSchema>;
