import { TemporalService } from 'nestjs-temporal-core';

/**
 * Terminates a post's running workflows, so a post that must not go out is
 * not published when its timer fires: a deleted post (PostsService
 * deletePost), or one whose media the retention purge removed
 * (MediaRetentionService). Never throws.
 */
export async function terminatePostWorkflows(
  temporal: TemporalService,
  postId: string
) {
  try {
    const workflows = temporal.client.getRawClient()?.workflow.list({
      query: `postId="${postId}" AND ExecutionStatus="Running"`,
    });

    if (!workflows) return;
    for await (const executionInfo of workflows) {
      try {
        const workflow = await temporal.client.getWorkflowHandle(
          executionInfo.workflowId
        );
        if (
          workflow &&
          (await workflow.describe()).status.name !== 'TERMINATED'
        ) {
          await workflow.terminate();
        }
      } catch (err) {}
    }
  } catch (err) {}
}
