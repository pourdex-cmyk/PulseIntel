// api/_lib/emailPrompts.js
// Pure functions — no imports. Return strings used as the user: field in Claude API calls.

export function buildEmailPrompt(action, messages, ctx) {
  const c = JSON.stringify(ctx);

  if (action === 'triage') return `
CONTEXT: ${c}

Triage the following ${messages.length} messages. Return a JSON array only — no preamble, no markdown fences.
Each object must contain exactly these keys:
  id                — the message id passed in (preserve exactly)
  priority          — URGENT | HIGH | NORMAL | LOW | NOISE
  category          — action_required | fyi | client | vendor | internal | phishing_risk | spam
  phishing_signals  — array of strings describing signals. Empty array [] if none.
  summary           — one sentence, 15 words max. What the message is actually about.
  suggested_action  — concrete next step for the user. 10 words max.

Messages: ${JSON.stringify(messages)}`.trim();

  if (action === 'draft_reply') {
    const m = messages[0];
    return `
CONTEXT: ${c}

Draft a reply to the following email on behalf of the user.
Tone: match reply_style in context (formal or warm).
Format: Subject line on line 1. Blank line. Greeting. Body paragraphs. Sign-off with user name.
Do not use placeholder text in the draft body. If information is missing, list it AFTER the draft as: NEEDS: [item]
Return only the draft — no preamble.

From: ${m.from_email || m.from_name}
Subject: ${m.subject}
Body: ${m.body_preview}`.trim();
  }

  if (action === 'intro_email') {
    const { contact_a, contact_b, context_notes } = messages[0];
    return `
CONTEXT: ${c}

Write a professional networking introduction email connecting two contacts.
The user (${ctx.user_name}) is making this introduction from their own email address.
Tone: warm, specific, credible. Reference concretely why these two people should connect.
Length: 150-200 words. Format: Subject line on line 1. Blank line. Body. Sign-off.
Return only the email — no preamble.

Contact A: ${JSON.stringify(contact_a)}
Contact B: ${JSON.stringify(contact_b)}
Context/reason for introduction: ${context_notes}`.trim();
  }

  if (action === 'security_scan') return `
CONTEXT: ${c}

Perform a phishing/security analysis on the following ${messages.length} messages.
For each message check:
  - Sender display name vs actual email domain mismatch
  - Urgency language combined with payment or credential requests
  - Lookalike domains (e.g. micros0ft.com, pay-pal.net, secure-bank-alert.com)
  - Requests to change payment routing, bank details, or vendor information
  - Suspicious link descriptions or unexpected attachment mentions

Return a JSON array only — no preamble:
  { id, risk_level, signals, recommendation }
  risk_level: HIGH | MEDIUM | LOW | NONE
  signals: array of specific signal strings (empty if NONE)
  recommendation: one action sentence

Messages: ${JSON.stringify(messages)}`.trim();

  throw new Error(`Unknown email action: ${action}`);
}
