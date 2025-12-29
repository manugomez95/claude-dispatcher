import { LinearClient, Issue } from "@linear/sdk";
import { WebClient } from "@slack/web-api";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration from environment variables
const CONFIG = {
  LINEAR_API_KEY: process.env.LINEAR_API_KEY || "",
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || "",
  SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID || "",
  CLAUDE_USER_ID: process.env.CLAUDE_USER_ID || "",
  LINEAR_PROJECT_IDS: process.env.LINEAR_PROJECT_IDS?.split(",").filter(Boolean) || [],
  LINEAR_TEAM_KEYS: process.env.LINEAR_TEAM_KEYS?.split(",").filter(Boolean) || [],
};

// Validate required configuration
function validateConfig(): void {
  const required = ["LINEAR_API_KEY", "SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID", "CLAUDE_USER_ID"];
  const missing = required.filter((key) => !CONFIG[key as keyof typeof CONFIG]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

// Initialize clients
const linearClient = new LinearClient({ apiKey: CONFIG.LINEAR_API_KEY });
const slackClient = new WebClient(CONFIG.SLACK_BOT_TOKEN);

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  url: string;
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
    state: { type: { in: ["unstarted", "started"] } },
    assignee: { null: true }, // Only unassigned tasks
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

  // Sort by priority (1 = urgent, 4 = low, 0 = no priority)
  // Priority order: 1 > 2 > 3 > 4 > 0
  const sortedIssues = [...issues.nodes].sort((a, b) => {
    const priorityA = a.priority === 0 ? 5 : a.priority;
    const priorityB = b.priority === 0 ? 5 : b.priority;
    return priorityA - priorityB;
  });

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

  let message = `<@${CONFIG.CLAUDE_USER_ID}>${projectInfo}${teamInfo}, work on: ${issue.title}`;

  if (issue.description) {
    // Truncate long descriptions
    const maxDescLength = 500;
    const desc =
      issue.description.length > maxDescLength
        ? issue.description.substring(0, maxDescLength) + "..."
        : issue.description;
    message += `\n\n${desc}`;
  }

  message += `\n\nLinear: ${issue.url}`;

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
 * Adds a comment to the Linear issue indicating it was dispatched
 */
async function markIssueAsDispatched(issueId: string): Promise<void> {
  console.log("Adding dispatch comment to Linear issue...");

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
