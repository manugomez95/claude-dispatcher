const { LinearClient } = require("@linear/sdk");
const fs = require("fs");

async function fetchHighestPriorityTask() {
  const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

  const projectIds = process.env.LINEAR_PROJECT_IDS?.split(",").filter(Boolean) || [];
  const teamKeys = process.env.LINEAR_TEAM_KEYS?.split(",").filter(Boolean) || [];

  // Build filter
  const filter = {
    state: { type: { in: ["backlog", "unstarted", "started"] } },
    assignee: { null: true },
    priority: { neq: 0 },
  };

  if (projectIds.length > 0) {
    filter.project = { id: { in: projectIds } };
  }

  if (teamKeys.length > 0) {
    filter.team = { key: { in: teamKeys } };
  }

  const issues = await client.issues({
    filter,
    first: 50,
  });

  if (!issues.nodes || issues.nodes.length === 0) {
    console.log("No matching tasks found in Linear");
    appendOutput("has_task", "false");
    return;
  }

  // Sort by priority (1 = urgent, 4 = low)
  const sorted = [...issues.nodes].sort((a, b) => a.priority - b.priority);
  const task = sorted[0];

  console.log(`Found task: ${task.identifier} - ${task.title}`);

  appendOutput("has_task", "true");
  appendOutput("task_id", task.id);
  appendOutput("task_identifier", task.identifier);
  appendOutput("task_title", task.title);
  appendOutput("task_description", task.description || "No description provided");
  appendOutput("task_url", task.url);
}

function appendOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    // Handle multiline values
    if (value.includes("\n")) {
      const delimiter = `EOF_${Date.now()}`;
      fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
    } else {
      fs.appendFileSync(outputFile, `${name}=${value}\n`);
    }
  } else {
    console.log(`${name}=${value}`);
  }
}

fetchHighestPriorityTask().catch((err) => {
  console.error("Error fetching task:", err);
  process.exit(1);
});
