// api/_lib/reportPrompt.js

export function buildReportPrompt(data, ctx) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return `
CONTEXT: ${JSON.stringify(ctx)}

Generate a daily intelligence report. Output in markdown.
Use EXACTLY these section headers in this order — do not add others, do not omit any:

## PULSE DAILY REPORT — ${today}
**Role:** ${ctx.user_role} | **Inboxes monitored:** ${ctx.inbox_count} | **Messages reviewed:** ${data.messages.length}

### ⚡ Urgent — Act Today
Max 5 items. Format each as: - [SOURCE] Subject/description → Suggested action
If none: state "No urgent items."

### 📋 Action Required
Items needing response within 24-48h. Same format as above. Max 10 items.
If none: state "No pending actions."

### 📅 Today's Meetings
For each meeting today: Time | Title | Attendee count | Brief status (Ready / Not generated)
If none: state "No meetings today."

### 📬 Communication Summary
Total messages: [n] | Outlook: [n] | Gmail: [n] | Teams: [n] | Noise filtered: [n] | Drafts ready: [n]

### 🔒 Security Flags
For each message with non-empty phishing_flags: - [RISK LEVEL] From: [sender] — [signal description]
If none: "No threats detected."

### 🧠 Intelligence Notes
2-4 bullets. Patterns or insights across channels. Be specific — reference actual senders, topics, or trends.

Data:
Messages (triaged, last 24h): ${JSON.stringify(data.messages.slice(0, 40))}
Meetings (today + tomorrow): ${JSON.stringify(data.meetings)}
Open action items: ${JSON.stringify(data.action_items)}
`.trim();
}
