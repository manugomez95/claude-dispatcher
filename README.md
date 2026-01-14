# Task → Slack → Claude Dispatcher

Automatically dispatches your highest-priority tasks from **Linear** or **GitHub Issues** to a Slack channel, mentioning @claude to trigger a Claude Code web session.

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Linear Tasks   │     │                 │     │                 │
│  (by priority)  │────▶│  This Script    │────▶│  Slack Channel  │
├─────────────────┤     │  (scheduled)    │     │  @claude        │
│  GitHub Issues  │────▶│                 │     │                 │
│  (by labels)    │     └─────────────────┘     └─────────────────┘
└─────────────────┘                                     │
                                                        ▼
                                                ┌─────────────────┐
                                                │                 │
                                                │  Claude Code    │
                                                │  (activates)    │
                                                │                 │
                                                └─────────────────┘
```

1. **Scheduler runs** (every 3 hours or custom interval)
2. **Fetches from Linear or GitHub** the highest-priority task
3. **Posts to Slack** with `@claude In project X, work on: <task>`
4. **Claude Code activates** automatically via your existing Slack integration

## Setup

### 1. Choose Your Task Source

Set `TASK_SOURCE` in your environment:
- `linear` (default) - Use Linear for task management
- `github` - Use GitHub Issues

### 2. Create Slack App

> **Important:** You need a **User Token** (`xoxp-...`), not a Bot Token. Claude's Slack integration ignores bot messages to prevent loops, so messages must appear from a human user.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Choose "From scratch"
3. Under **OAuth & Permissions**, scroll to **User Token Scopes** (not Bot Token Scopes):
   - `chat:write` (post messages as yourself)
4. Install to your workspace
5. Copy the **User OAuth Token** (`xoxp-...`)

### 3. Get Slack IDs

**Channel ID:**
- Right-click the channel → View channel details
- Scroll to the bottom to find the Channel ID (`C0XXXXXXXXX`)

**Claude User ID:**
- In Slack, type `@claude` and send a message
- Use Slack's API or inspect the network request to find the user ID (`U0XXXXXXXXX`)
- Alternatively: Slack App → Your App → Features → App Home → shows the bot user ID

### 4. Configure Task Source

#### Option A: Linear Setup

1. Go to Linear → Settings → API → Personal API keys
2. Create a new key with read access to issues
3. Copy the `lin_api_...` token

```bash
TASK_SOURCE=linear
LINEAR_API_KEY=lin_api_xxxxxxxxxxxx

# Optional: Filter to specific projects/teams
LINEAR_PROJECT_IDS=proj_abc123,proj_def456
LINEAR_TEAM_KEYS=ENG,PRODUCT
```

#### Option B: GitHub Issues Setup

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Create a Personal Access Token with `repo` scope
3. Copy the `ghp_...` token

```bash
TASK_SOURCE=github
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_OWNER=your-username
GITHUB_REPO=your-repo

# Optional: Custom label for ready issues (default: claude-ready)
GITHUB_READY_LABEL=claude-ready
```

**GitHub Priority Labels:**

The dispatcher sorts GitHub issues by priority labels:
- `priority:urgent` - Highest priority (1)
- `priority:high` - High priority (2)
- `priority:medium` or `priority:normal` - Medium priority (3)
- `priority:low` - Low priority (4)

Issues without priority labels default to medium priority.

**GitHub Workflow:**
1. Add the `claude-ready` label to issues you want dispatched
2. Optionally add priority labels to control order
3. When dispatched, the `claude-ready` label is removed and `in-progress` is added

### 5. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

## Running

### Local (one-time)

```bash
npm install
npm run dispatch
```

### Scheduled (GitHub Actions)

1. Push this repo to GitHub
2. Add secrets in Settings → Secrets and variables → Actions:

   **Required (always):**
   - `SLACK_USER_TOKEN`
   - `SLACK_CHANNEL_ID`
   - `CLAUDE_USER_ID`

   **For Linear:**
   - `LINEAR_API_KEY`

   **For GitHub Issues:**
   - `GITHUB_TOKEN`
   - `GITHUB_OWNER`
   - `GITHUB_REPO`

3. Add variables:
   - `TASK_SOURCE` (set to `linear` or `github`)
   - `LINEAR_PROJECT_IDS` (optional)
   - `LINEAR_TEAM_KEYS` (optional)
   - `GITHUB_READY_LABEL` (optional)

The workflow runs every 3 hours. Edit `.github/workflows/dispatch.yml` to change the schedule:

```yaml
schedule:
  - cron: '0 */3 * * *'  # Every 3 hours
  - cron: '0 9 * * *'    # Daily at 9 AM UTC
  - cron: '0 9,14 * * 1-5' # 9 AM and 2 PM, weekdays only
```

### Alternative: Cron Job

```bash
# Add to crontab (every 3 hours)
0 */3 * * * cd /path/to/linear-slack-dispatcher && npm run dispatch >> /var/log/dispatcher.log 2>&1
```

## Customization

### Priority Selection (Linear)

By default, selects the highest-priority unassigned task. Modify `getHighestPriorityLinearTask()` in `src/index.ts`:

```typescript
const filter = {
  state: { type: { in: ["backlog", "unstarted", "started"] } },
  // Remove this line to include assigned tasks:
  assignee: { null: true },
  // Only tasks with a priority set:
  priority: { neq: 0 },
  // Add label filter:
  labels: { name: { in: ["claude-ready"] } },
};
```

### Priority Selection (GitHub)

Modify `getHighestPriorityGitHubTask()` in `src/index.ts` to change filtering:

```typescript
const { data: issues } = await client.rest.issues.listForRepo({
  owner: CONFIG.GITHUB_OWNER,
  repo: CONFIG.GITHUB_REPO,
  state: "open",
  labels: CONFIG.GITHUB_READY_LABEL,
  assignee: "none",  // Only unassigned issues
  sort: "created",
  direction: "asc",
  per_page: 50,
});
```

### Message Format

Customize `formatSlackMessage()` to change how tasks are presented to Claude.

> **Note:** Claude cannot access external links, so the task title and description should contain all necessary context.

```typescript
function formatSlackMessage(task: Task): string {
  return `<@${CONFIG.CLAUDE_USER_ID}> Please work on this task:

Task: ${task.title}
Description: ${task.description}

Additional context: Focus on test coverage and documentation.`;
}
```

## Troubleshooting

**"No tasks to dispatch"**
- **Linear:** Check LINEAR_PROJECT_IDS and LINEAR_TEAM_KEYS filters; verify tasks are in "backlog"/"unstarted" state; check if tasks are assigned; ensure tasks have a priority set
- **GitHub:** Ensure issues have the `claude-ready` label; check GITHUB_OWNER and GITHUB_REPO are correct

**Slack API errors**
- Check user token has `chat:write` scope
- Verify SLACK_CHANNEL_ID is correct

**Claude not responding**
- Ensure you're using a **User Token** (`xoxp-...`), not a Bot Token — Claude ignores bot messages
- Ensure your Claude Code Slack integration is active
- Verify CLAUDE_USER_ID is the correct user ID for @claude
- Check the channel is configured for Claude Code triggers

**GitHub label errors**
- Ensure the `claude-ready` label exists in your repository
- Optionally create an `in-progress` label for dispatched issues

## License

MIT
