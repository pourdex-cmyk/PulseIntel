// api/_lib/meetingPrompts.js

export function buildMeetingPrompt(action, meeting, ctx) {
  const c = JSON.stringify(ctx);
  const m = JSON.stringify(meeting);

  if (action === 'pre_brief') return `
CONTEXT: ${c}

Generate a meeting prep brief. Output in markdown using EXACTLY these section headers — no others:

## MEETING BRIEF: [title]
**When:** [datetime] | **Duration:** [X] min | **Platform:** [platform]

### Attendees
One line per attendee: Name | Company | Role | Relationship | Last known interaction

### What You Need to Know
3-5 bullets: key context, recent activity, known priorities or concerns

### Suggested Agenda
Numbered list with time allocations that sum exactly to the meeting duration

### Prep Checklist
Checkbox list (- [ ] item) of concrete actions to take before the meeting

### Risk Flags
Any dynamics, sensitivities, or topics to be aware of. State "None identified." if clean.

Meeting data: ${m}`.trim();

  if (action === 'deck_outline') return `
CONTEXT: ${c}

Generate a PowerPoint slide outline for this meeting.
Return a JSON array only — no preamble, no markdown fences.
Each object: { slide_number, title, layout, bullets, speaker_notes }
layout values: "title" | "content" | "two_column" | "blank"
Max 12 slides. Slide 1: title slide with attendee names. Final slide: Next Steps.
bullets: array of strings (empty array for title/blank layouts).
speaker_notes: string, 1-3 sentences of talking points.

Meeting: ${m}`.trim();

  if (action === 'post_summary') return `
CONTEXT: ${c}

Analyze this meeting transcript. Output in markdown using EXACTLY these section headers:

## MEETING SUMMARY: [title]
**Date:** [date] | **Duration:** [actual duration] | **Attendees:** [comma-separated list]

### Key Discussion Points
3-7 bullets on what was actually discussed (content, not agenda items)

### Decisions Made
Numbered list. State "None recorded." if none.

### Action Items
Table with header row: | Owner | Action | Deadline |
Extract only explicit commitments made during the call — do not infer.

### Open Questions
Items raised but not resolved during the meeting.

### Relationship Intelligence
1-3 bullets: tone of the meeting, any buy signals, concerns surfaced, rapport observations.
Label this section: "⚠ Internal use only — do not share with client"

Transcript: ${meeting.transcript ?? 'No transcript provided.'}`.trim();

  throw new Error(`Unknown meeting action: ${action}`);
}
