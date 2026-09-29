// A scripted fake runtime for the team examples: the lead calls the orchestration tools that a real
// model would call. Used by team-mailbox.ts and by team-host.ts, the host of team_mailbox.py.
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type {
  EngineConfig,
  RuntimeAdapter,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

type Tools = { call(name: string, request: unknown): Promise<unknown> };
const fresh = { requestedMode: 'fresh', independent: true };

/** The lead's goal names the editor's session, as a host tells an agent who is on its team. */
export const leadGoal = (editorSessionId: string) =>
  `Write the release notes. The editor works in session ${editorSessionId}.`;

/**
 * The lead delegates a helper, sends it a message, and asks to hand a review to the editor. Every
 * task's result is its prompt, so the helper's result shows the message it received.
 */
export function createTeamAdapter(): RuntimeAdapter {
  const fake = createFakeAdapter();
  return {
    ...fake,
    async *execute(input) {
      const editor = /^Write the release notes\. The editor works in session (\S+)\./.exec(
        input.prompt,
      );
      if (editor) {
        const tools = input.orchestrationTools as Tools;
        const helper = (await tools.call('work_delegate', {
          goal: 'Check the changelog links',
          contextPlan: fresh,
          idempotencyKey: 'helper',
        })) as TaskSnapshot;
        const session = (await tools.call('work_read', {
          kind: 'session',
          id: helper.sessionId,
        })) as { generation: number };
        await tools.call('work_send', {
          taskId: helper.id,
          toSessionId: helper.sessionId,
          expectedGeneration: session.generation,
          kind: 'finding',
          summary: 'The API pages moved from docs/api/ to docs/reference/',
          idempotencyKey: 'moved-pages',
        });
        // The editor's session is outside the lead's team, so this becomes a request to the host.
        await tools.call('work_delegate', {
          goal: 'Review the notes for tone',
          contextPlan: { ...fresh, requestedMode: 'reuse', candidateSessionId: editor[1] },
          idempotencyKey: 'tone-review',
        });
      }
      yield* fake.execute(input);
    },
  };
}

/** The host approves each delegation and decides each handoff. */
export const teamTools: EngineConfig['tools'] = {
  enabled: true,
  approveDelegation: true,
  handoffs: true,
};
