// api/_lib/meetingPrompts.js

export function buildMeetingPrompt(action, meeting, ctx) {
  const c = JSON.stringify(ctx);
  const m = JSON.stringify(meeting);

  if (action === 'pre_brief') return `
CONTEXT: ${c}

Generate a meeting prep brief for ${ctx.user_name} (${ctx.user_role}${ctx.user_company ? ' at ' + ctx.user_company : ''}).
Think like a chief of staff who knows this professional services firm deeply.
Pull out what actually matters — not a generic template, but specific intelligence for this specific meeting.

Output in markdown using EXACTLY these section headers — no others, no additions:

## MEETING BRIEF: ${meeting.title || 'Untitled Meeting'}
**When:** [datetime] | **Duration:** [X] min | **Platform:** [platform]

### Attendees
One line per attendee: **Name** | Company | Role | Relationship to user | Last known interaction or context

### What You Need to Know
3-5 bullets. Specific context, known priorities, recent activity, relationship dynamics.
If no attendee details are provided, infer what you can from names/roles and note what to research before the meeting.

### Suggested Agenda
Numbered list with time allocations that sum exactly to the meeting duration.
Make the agenda purposeful — not just topic labels, but what outcome each item should produce.

### Prep Checklist
Checkbox list (- [ ] item) of concrete actions ${ctx.user_name} should take before this meeting.
Be specific — "Review Q3 billing summary for [client]" not "Review materials."

### Risk Flags
Dynamics, sensitivities, or topics requiring care. If the meeting involves a client, note any known relationship risks.
State "None identified." only if the meeting data provides genuinely no risk signals.

Meeting data: ${m}`.trim();

  if (action === 'deck_outline') return `
CONTEXT: ${c}

Generate a PowerPoint slide deck outline for this meeting.
Think about the narrative arc — what story does this deck need to tell, and in what order?

Return a JSON array only — no preamble, no markdown fences.
Each slide object: { slide_number, title, layout, bullets, speaker_notes }
layout values: "title" | "content" | "two_column" | "divider" | "blank"
Max 12 slides. Min 5 slides.
Slide 1: title slide with meeting title, date, and presenter name (${ctx.user_name}).
Final slide: Next Steps — numbered list of clear follow-up actions with owners where possible.
bullets: array of strings (empty array for title/divider/blank layouts). Max 5 bullets per slide.
speaker_notes: 2-4 sentences of specific talking points — not a repeat of the bullets.

Meeting: ${m}`.trim();

  if (action === 'post_summary') return `
CONTEXT: ${c}

Analyze this meeting transcript and generate a structured post-meeting summary.
Focus on what was actually said, decided, and committed to — not what was planned.

Output in markdown using EXACTLY these section headers in this order:

## MEETING SUMMARY: ${meeting.title || 'Untitled Meeting'}
**Date:** [date] | **Duration:** [actual or estimated duration] | **Attendees:** [comma-separated names]

### Key Discussion Points
3-7 bullets on what was actually discussed. Be specific — name topics, positions taken, concerns raised.
Do not just repeat the agenda — describe the substance of the conversation.

### Decisions Made
Numbered list of explicit decisions reached during the meeting.
State "None recorded." if no decisions were made.

### Action Items
Table with header row: | Owner | Action | Deadline |
Extract only explicit commitments made during the call. Quote the speaker where possible.
Do NOT infer or assume action items — only record what was clearly stated.

### Open Questions
Items raised but unresolved. Include who raised them if identifiable.

### Relationship Intelligence
2-4 bullets: tone of the meeting, engagement level of each attendee, any buy signals or resistance, rapport observations.
⚠ Label this section clearly as: **Internal use only — do not share with attendees**

${meeting.transcript ? `Transcript: ${meeting.transcript}` : 'No transcript provided — base summary on meeting metadata and any notes available.'}`.trim();

  throw new Error(`Unknown meeting action: ${action}`);
}
