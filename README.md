# Linear → Slack → Claude Dispatcher

Automatically dispatches your highest-priority Linear tasks to a Slack channel, mentioning @claude to trigger a Claude Code web session.

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Linear Tasks   │────▶│  This Script    │────▶│  Slack Channel  │
│  (by priority)  │     │  (scheduled)    │     │  @claude        │
│                 │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                                ┌─────────────────┐
                                                │                 │
                                                │  Claude Code    │
                                                │  (activates)    │
                                                │                 │
                                                └─────────────────┘
```

1. **Scheduler runs** (every 3 hours or custom interval)
2. **Fetches from Linear** the highest-priority unstarted/in-progress task
3. **Posts to Slack** with `@claude In project X, work on: <task>`
4. **Claude Code activates** automatically via your existing Slack integration

## Setup

### 1. Create Linear API Key

1. Go to Linear → Settings → API → Personal API keys
2. Create a new key with read access to issues
3. Copy the `lin_api_...` token

### 2. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Choose "From scratch"
3. Add OAuth scopes under **OAuth & Permissions**:
   - `chat:write` (post messages)
   - `users:read` (optional, to resolve user mentions)
4. Install to your workspace
5. Copy the **Bot User OAuth Token** (`xoxb-...`)

### 3. Get Slack IDs

**Channel ID:**
- Right-click the channel → View channel details
- Scroll to the bottom to find the Channel ID (`C0XXXXXXXXX`)

**Claude User ID:**
- In Slack, type `@claude` and send a message
- Use Slack's API or inspect the network request to find the user ID (`U0XXXXXXXXX`)
- Alternatively: Slack App → Your App → Features → App Home → shows the bot user ID

### 4. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### 5. Optional: Filter Projects/Teams

Set these to limit which tasks are considered:

```bash
# Only these project IDs (comma-separated)
LINEAR_PROJECT_IDS=proj_abc123,proj_def456

# Only these team keys (comma-separated)
LINEAR_TEAM_KEYS=ENG,PRODUCT
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
   - `LINEAR_API_KEY`
   - `SLACK_BOT_TOKEN`
   - `SLACK_CHANNEL_ID`
   - `CLAUDE_USER_ID`
3. Optionally add variables:
   - `LINEAR_PROJECT_IDS`
   - `LINEAR_TEAM_KEYS`

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

### Priority Selection

By default, selects the highest-priority unassigned task. Modify `getHighestPriorityTask()` in `src/index.ts`:

```typescript
const filter = {
  state: { type: { in: ["unstarted", "started"] } },
  // Remove this line to include assigned tasks:
  assignee: { null: true },
  // Add label filter:
  labels: { name: { in: ["claude-ready"] } },
};
```

### Message Format

Customize `formatSlackMessage()` to change how tasks are presented to Claude:

```typescript
function formatSlackMessage(issue: LinearIssue): string {
  return `<@${CONFIG.CLAUDE_USER_ID}> Please work on this task:

Task: ${issue.title}
Description: ${issue.description}

Additional context: Focus on test coverage and documentation.`;
}
```

### Avoiding Duplicate Dispatches

The script adds a comment to dispatched issues. To skip already-dispatched tasks, add this filter:

```typescript
// In getHighestPriorityTask(), after fetching issues:
const undispatchedIssues = [];
for (const issue of issues.nodes) {
  const comments = await issue.comments();
  const wasDispatched = comments.nodes.some(c =>
    c.body.includes("🤖 Task dispatched to Claude")
  );
  if (!wasDispatched) undispatchedIssues.push(issue);
}
```

## Troubleshooting

**"No tasks to dispatch"**
- Check LINEAR_PROJECT_IDS and LINEAR_TEAM_KEYS filters
- Verify tasks are in "unstarted" or "started" state
- Check if tasks are assigned (default filters to unassigned)

**Slack API errors**
- Verify bot is invited to the channel (`/invite @yourbot`)
- Check bot has `chat:write` scope
- Verify SLACK_CHANNEL_ID is correct

**Claude not responding**
- Ensure your Claude Code Slack integration is active
- Verify CLAUDE_USER_ID is the correct bot user ID
- Check the channel is configured for Claude Code triggers

## License

MIT
