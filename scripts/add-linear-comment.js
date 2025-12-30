const { LinearClient } = require("@linear/sdk");

async function addComment() {
  const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

  const issueId = process.env.ISSUE_ID;
  const workflowUrl = process.env.WORKFLOW_URL;

  await client.createComment({
    issueId,
    body: `🤖 Claude Code Action triggered\n\n[View workflow run](${workflowUrl})`,
  });

  console.log("Comment added to Linear issue");
}

addComment().catch((err) => {
  console.error("Error adding comment:", err);
  process.exit(1);
});
