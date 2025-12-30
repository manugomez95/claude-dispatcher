import { LinearClient, Issue } from "@linear/sdk";
import { WebClient } from "@slack/web-api";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration from environment variables
const CONFIG = {
  LINEAR_API_KEY: process.env.LINEAR_API_KEY || "",
  SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN || "", // Use xoxp- user token, not xoxb- bot token
  SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID || "",
  CLAUDE_USER_ID: process.env.CLAUDE_USER_ID || "",
  LINEAR_PROJECT_IDS: process.env.LINEAR_PROJECT_IDS?.split(",").filter(Boolean) || [],
  LINEAR_TEAM_KEYS: process.env.LINEAR_TEAM_KEYS?.split(",").filter(Boolean) || [],
};

// Validate required configuration
function validateConfig(): void {
  const required = ["LINEAR_API_KEY", "SLACK_USER_TOKEN", "SLACK_CHANNEL_ID", "CLAUDE_USER_ID"];
  const missing = required.filter((key) => !CONFIG[key as keyof typeof CONFIG]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

// Initialize clients
const linearClient = new LinearClient({ apiKey: CONFIG.LINEAR_API_KEY });
const slackClient = new WebClient(CONFIG.SLACK_USER_TOKEN);

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  url: string;
  branchName: string;
  project?: { name: string } | null;
  team?: { key: string; name: string } | null;
}

/**
 * Fetches the highest-priority unstarted/in-progress task from Linear
 */
async function getHighestPriorityTask(): Promise<LinearIssue | null> {
  console.log("Fetching tasks from Linear...");

  // Build the filter
  const filter: Record<string, unknown> = {
    state: { type: { in: ["backlog", "unstarted", "started"] } },
    assignee: { null: true }, // Only unassigned tasks
    priority: { neq: 0 }, // Ignore tasks with no priority
  };

  // Add project filter if specified
  if (CONFIG.LINEAR_PROJECT_IDS.length > 0) {
    filter.project = { id: { in: CONFIG.LINEAR_PROJECT_IDS } };
  }

  // Add team filter if specified
  if (CONFIG.LINEAR_TEAM_KEYS.length > 0) {
    filter.team = { key: { in: CONFIG.LINEAR_TEAM_KEYS } };
  }

  const issues = await linearClient.issues({
    filter,
    orderBy: LinearClient.name ? undefined : undefined, // SDK handles ordering
    first: 50, // Fetch enough to sort by priority
  });

  if (!issues.nodes || issues.nodes.length === 0) {
    console.log("No matching tasks found in Linear");
    return null;
  }

  // Sort by priority (1 = urgent, 2 = high, 3 = medium, 4 = low)
  const sortedIssues = [...issues.nodes].sort((a, b) => a.priority - b.priority);

  const topIssue = sortedIssues[0];
  const project = await topIssue.project;
  const team = await topIssue.team;

  return {
    id: topIssue.id,
    identifier: topIssue.identifier,
    title: topIssue.title,
    description: topIssue.description ?? undefined,
    priority: topIssue.priority,
    url: topIssue.url,
    branchName: topIssue.branchName,
    project: project ? { name: project.name } : null,
    team: team ? { key: team.key, name: team.name } : null,
  };
}

/**
 * Formats the Slack message for Claude
 */
function formatSlackMessage(issue: LinearIssue): string {
  const projectInfo = issue.project ? ` in project "${issue.project.name}"` : "";
  const teamInfo = issue.team ? ` [${issue.team.key}]` : "";

  let message = `<@${CONFIG.CLAUDE_USER_ID}>${projectInfo}${teamInfo}, work on ${issue.identifier}: ${issue.title}`;

  if (issue.description) {
    // Truncate long descriptions
    const maxDescLength = 2000;
    const desc =
      issue.description.length > maxDescLength
        ? issue.description.substring(0, maxDescLength) + "..."
        : issue.description;
    message += `\n\n${desc}`;
  }

  // Add branch naming instruction for Linear integration
  message += `\n\nIMPORTANT: You MUST name the git branch exactly: ${issue.branchName}`;

  return message;
}

/**
 * Posts a message to Slack
 */
async function postToSlack(message: string): Promise<void> {
  console.log("Posting to Slack...");

  await slackClient.chat.postMessage({
    channel: CONFIG.SLACK_CHANNEL_ID,
    text: message,
    unfurl_links: false,
    unfurl_media: false,
  });

  console.log("Message posted to Slack successfully");
}

/**
 * Marks the issue as In Progress and adds a dispatch comment
 */
async function markIssueAsDispatched(issueId: string): Promise<void> {
  console.log("Marking issue as In Progress...");

  // Get the issue to find its team's "In Progress" state
  const issue = await linearClient.issue(issueId);
  const team = await issue.team;

  if (team) {
    const states = await team.states();
    const inProgressState = states.nodes.find(
      (s) => s.type === "started" && s.name.toLowerCase().includes("progress")
    ) || states.nodes.find((s) => s.type === "started");

    if (inProgressState) {
      await linearClient.updateIssue(issueId, {
        stateId: inProgressState.id,
      });
      console.log(`Issue state updated to: ${inProgressState.name}`);
    }
  }

  // Add dispatch comment
  await linearClient.createComment({
    issueId,
    body: "🤖 Task dispatched to Claude via Slack",
  });

  console.log("Dispatch comment added to Linear issue");
}

/**
 * Main dispatcher function
 */
async function dispatch(): Promise<void> {
  console.log("=".repeat(50));
  console.log("Linear → Slack → Claude Dispatcher");
  console.log("=".repeat(50));

  validateConfig();

  const task = await getHighestPriorityTask();

  if (!task) {
    console.log("\nNo tasks to dispatch.");
    return;
  }

  console.log(`\nFound task: ${task.identifier} - ${task.title}`);
  console.log(`Priority: ${task.priority || "None"}`);
  console.log(`Project: ${task.project?.name || "None"}`);
  console.log(`Team: ${task.team?.name || "None"}`);

  const message = formatSlackMessage(task);
  console.log("\nMessage to post:");
  console.log("-".repeat(40));
  console.log(message);
  console.log("-".repeat(40));

  await postToSlack(message);
  await markIssueAsDispatched(task.id);

  console.log("\n✅ Task dispatched successfully!");
}

// Run the dispatcher
dispatch().catch((error) => {
  console.error("Error running dispatcher:", error);
  process.exit(1);
});
