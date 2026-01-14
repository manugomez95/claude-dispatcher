import { LinearClient } from "@linear/sdk";
import { Octokit } from "@octokit/rest";
import { WebClient } from "@slack/web-api";
import * as dotenv from "dotenv";

dotenv.config();

// Task source type
type TaskSource = "linear" | "github";

// Configuration from environment variables
const CONFIG = {
  // Task source selection
  TASK_SOURCE: (process.env.TASK_SOURCE || "linear") as TaskSource,

  // Slack config
  SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN || "",
  SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID || "",
  CLAUDE_USER_ID: process.env.CLAUDE_USER_ID || "",

  // Linear config
  LINEAR_API_KEY: process.env.LINEAR_API_KEY || "",
  LINEAR_PROJECT_IDS: process.env.LINEAR_PROJECT_IDS?.split(",").filter(Boolean) || [],
  LINEAR_TEAM_KEYS: process.env.LINEAR_TEAM_KEYS?.split(",").filter(Boolean) || [],

  // GitHub config
  GITHUB_TOKEN: process.env.GH_TOKEN || "",
  GITHUB_OWNER: process.env.GH_OWNER || "",
  GITHUB_REPO: process.env.GH_REPO || "",
  GITHUB_READY_LABEL: process.env.GH_READY_LABEL || "claude-ready",
};

// Priority label mapping for GitHub (label name -> priority number)
const GITHUB_PRIORITY_LABELS: Record<string, number> = {
  "priority:urgent": 1,
  "priority:high": 2,
  "priority:medium": 3,
  "priority:normal": 3,
  "priority:low": 4,
};

// Validate required configuration
function validateConfig(): void {
  const required = ["SLACK_USER_TOKEN", "SLACK_CHANNEL_ID", "CLAUDE_USER_ID"];

  if (CONFIG.TASK_SOURCE === "linear") {
    required.push("LINEAR_API_KEY");
  } else if (CONFIG.TASK_SOURCE === "github") {
    required.push("GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO");
  }

  const missing = required.filter((key) => !CONFIG[key as keyof typeof CONFIG]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

// Initialize clients lazily
let linearClient: LinearClient | null = null;
let githubClient: Octokit | null = null;
const slackClient = new WebClient(CONFIG.SLACK_USER_TOKEN);

function getLinearClient(): LinearClient {
  if (!linearClient) {
    linearClient = new LinearClient({ apiKey: CONFIG.LINEAR_API_KEY });
  }
  return linearClient;
}

function getGitHubClient(): Octokit {
  if (!githubClient) {
    githubClient = new Octokit({ auth: CONFIG.GITHUB_TOKEN });
  }
  return githubClient;
}

// Unified task interface
interface Task {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  url: string;
  source: TaskSource;
  // Linear-specific
  project?: { name: string } | null;
  team?: { key: string; name: string } | null;
  // GitHub-specific
  labels?: string[];
  repo?: { owner: string; name: string };
}

/**
 * Fetches the highest-priority unstarted/in-progress task from Linear
 */
async function getHighestPriorityLinearTask(): Promise<Task | null> {
  console.log("Fetching tasks from Linear...");

  const client = getLinearClient();

  // Build the filter
  const filter: Record<string, unknown> = {
    state: { type: { in: ["backlog", "unstarted"] } },
    assignee: { null: true },
    priority: { neq: 0 },
  };

  if (CONFIG.LINEAR_PROJECT_IDS.length > 0) {
    filter.project = { id: { in: CONFIG.LINEAR_PROJECT_IDS } };
  }

  if (CONFIG.LINEAR_TEAM_KEYS.length > 0) {
    filter.team = { key: { in: CONFIG.LINEAR_TEAM_KEYS } };
  }

  const issues = await client.issues({
    filter,
    first: 50,
  });

  if (!issues.nodes || issues.nodes.length === 0) {
    console.log("No matching tasks found in Linear");
    return null;
  }

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
    source: "linear",
    project: project ? { name: project.name } : null,
    team: team ? { key: team.key, name: team.name } : null,
  };
}

/**
 * Extracts priority from GitHub issue labels
 */
function getGitHubIssuePriority(labels: Array<{ name?: string }>): number {
  for (const label of labels) {
    const labelName = label.name?.toLowerCase();
    if (labelName && GITHUB_PRIORITY_LABELS[labelName]) {
      return GITHUB_PRIORITY_LABELS[labelName];
    }
  }
  return 3; // Default to medium priority
}

/**
 * Fetches the highest-priority issue from GitHub
 */
async function getHighestPriorityGitHubTask(): Promise<Task | null> {
  console.log("Fetching issues from GitHub...");

  const client = getGitHubClient();

  const { data: issues } = await client.rest.issues.listForRepo({
    owner: CONFIG.GITHUB_OWNER,
    repo: CONFIG.GITHUB_REPO,
    state: "open",
    labels: CONFIG.GITHUB_READY_LABEL,
    sort: "created",
    direction: "asc",
    per_page: 50,
  });

  // Filter out pull requests (GitHub API returns PRs in issues endpoint)
  const realIssues = issues.filter((issue) => !issue.pull_request);

  if (realIssues.length === 0) {
    console.log("No matching issues found in GitHub");
    return null;
  }

  // Sort by priority labels
  const sortedIssues = [...realIssues].sort((a, b) => {
    const priorityA = getGitHubIssuePriority(a.labels as Array<{ name?: string }>);
    const priorityB = getGitHubIssuePriority(b.labels as Array<{ name?: string }>);
    return priorityA - priorityB;
  });

  const topIssue = sortedIssues[0];

  return {
    id: topIssue.id.toString(),
    identifier: `#${topIssue.number}`,
    title: topIssue.title,
    description: topIssue.body ?? undefined,
    priority: getGitHubIssuePriority(topIssue.labels as Array<{ name?: string }>),
    url: topIssue.html_url,
    source: "github",
    labels: (topIssue.labels as Array<{ name?: string }>)
      .map((l) => l.name)
      .filter((n): n is string => !!n),
    repo: { owner: CONFIG.GITHUB_OWNER, name: CONFIG.GITHUB_REPO },
  };
}

/**
 * Fetches the highest-priority task based on configured source
 */
async function getHighestPriorityTask(): Promise<Task | null> {
  if (CONFIG.TASK_SOURCE === "github") {
    return getHighestPriorityGitHubTask();
  }
  return getHighestPriorityLinearTask();
}

/**
 * Formats the Slack message for Claude
 */
function formatSlackMessage(task: Task): string {
  let contextInfo = "";

  if (task.source === "linear") {
    const projectInfo = task.project ? ` in project "${task.project.name}"` : "";
    const teamInfo = task.team ? ` [${task.team.key}]` : "";
    contextInfo = `${projectInfo}${teamInfo}`;
  } else if (task.source === "github") {
    const repoInfo = task.repo ? ` in ${task.repo.owner}/${task.repo.name}` : "";
    contextInfo = repoInfo;
  }

  let message = `<@${CONFIG.CLAUDE_USER_ID}>${contextInfo}, work on ${task.identifier}: ${task.title}`;

  if (task.description) {
    const maxDescLength = 2000;
    const desc =
      task.description.length > maxDescLength
        ? task.description.substring(0, maxDescLength) + "..."
        : task.description;
    message += `\n\n${desc}`;
  }

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
 * Marks a Linear issue as In Progress and adds a dispatch comment
 */
async function markLinearIssueAsDispatched(issueId: string): Promise<void> {
  console.log("Marking Linear issue as In Progress...");

  const client = getLinearClient();
  const issue = await client.issue(issueId);
  const team = await issue.team;

  if (team) {
    const states = await team.states();
    const inProgressState =
      states.nodes.find(
        (s) => s.type === "started" && s.name.toLowerCase().includes("progress")
      ) || states.nodes.find((s) => s.type === "started");

    if (inProgressState) {
      await client.updateIssue(issueId, {
        stateId: inProgressState.id,
      });
      console.log(`Issue state updated to: ${inProgressState.name}`);
    }
  }

  await client.createComment({
    issueId,
    body: "🤖 Task dispatched to Claude via Slack",
  });

  console.log("Dispatch comment added to Linear issue");
}

/**
 * Marks a GitHub issue as dispatched by removing ready label and adding comment
 */
async function markGitHubIssueAsDispatched(task: Task): Promise<void> {
  console.log("Marking GitHub issue as dispatched...");

  const client = getGitHubClient();
  const issueNumber = parseInt(task.identifier.replace("#", ""));

  // Add dispatch comment
  await client.rest.issues.createComment({
    owner: CONFIG.GITHUB_OWNER,
    repo: CONFIG.GITHUB_REPO,
    issue_number: issueNumber,
    body: "🤖 Task dispatched to Claude via Slack",
  });

  // Remove the ready label to prevent re-dispatch
  try {
    await client.rest.issues.removeLabel({
      owner: CONFIG.GITHUB_OWNER,
      repo: CONFIG.GITHUB_REPO,
      issue_number: issueNumber,
      name: CONFIG.GITHUB_READY_LABEL,
    });
    console.log(`Removed "${CONFIG.GITHUB_READY_LABEL}" label from issue`);
  } catch (error) {
    // Label might not exist or already removed
    console.log("Note: Could not remove ready label (may not exist)");
  }

  // Add "in-progress" label if it exists
  try {
    await client.rest.issues.addLabels({
      owner: CONFIG.GITHUB_OWNER,
      repo: CONFIG.GITHUB_REPO,
      issue_number: issueNumber,
      labels: ["in-progress"],
    });
    console.log('Added "in-progress" label to issue');
  } catch (error) {
    // Label might not exist in the repo
    console.log('Note: Could not add "in-progress" label (may not exist in repo)');
  }

  console.log("Dispatch comment added to GitHub issue");
}

/**
 * Marks the task as dispatched based on its source
 */
async function markTaskAsDispatched(task: Task): Promise<void> {
  if (task.source === "github") {
    await markGitHubIssueAsDispatched(task);
  } else {
    await markLinearIssueAsDispatched(task.id);
  }
}

/**
 * Main dispatcher function
 */
async function dispatch(): Promise<void> {
  console.log("=".repeat(50));
  console.log("Task → Slack → Claude Dispatcher");
  console.log(`Source: ${CONFIG.TASK_SOURCE.toUpperCase()}`);
  console.log("=".repeat(50));

  validateConfig();

  const task = await getHighestPriorityTask();

  if (!task) {
    console.log("\nNo tasks to dispatch.");
    return;
  }

  console.log(`\nFound task: ${task.identifier} - ${task.title}`);
  console.log(`Priority: ${task.priority || "None"}`);
  if (task.source === "linear") {
    console.log(`Project: ${task.project?.name || "None"}`);
    console.log(`Team: ${task.team?.name || "None"}`);
  } else {
    console.log(`Repo: ${task.repo?.owner}/${task.repo?.name}`);
    console.log(`Labels: ${task.labels?.join(", ") || "None"}`);
  }

  const message = formatSlackMessage(task);
  console.log("\nMessage to post:");
  console.log("-".repeat(40));
  console.log(message);
  console.log("-".repeat(40));

  await postToSlack(message);
  await markTaskAsDispatched(task);

  console.log("\n✅ Task dispatched successfully!");
}

// Run the dispatcher
dispatch().catch((error) => {
  console.error("Error running dispatcher:", error);
  process.exit(1);
});
