// api/_lib/emailPrompts.js
// Pure functions — no imports. Return strings used as the user: field in Claude API calls.

export function buildEmailPrompt(action, messages, ctx) {
  const c = JSON.stringify(ctx);

  if (action === 'triage') return `
CONTEXT: ${c}

You are triaging the inbox of ${ctx.user_name}, a ${ctx.user_role} at a professional services firm.
Apply your full professional services industry judgment to each message.

Triage the following ${messages.length} messages. Return a JSON array only — no preamble, no markdown fences.

Each object must contain exactly these keys:
  id                — the message id passed in (preserve exactly)
  priority          — URGENT | HIGH | NORMAL | LOW | NOISE
  category          — action_required | fyi | client | vendor | internal | phishing_risk | spam
  phishing_signals  — array of strings describing specific signals. Empty array [] if none.
  summary           — one crisp sentence, max 18 words, describing what the message actually requires or contains
  suggested_action  — the single most important concrete next step, max 12 words

TRIAGE CALIBRATION FOR THIS USER:
- Role context: ${ctx.user_role}
- Security mode: ${ctx.security_mode || 'high'} — flag anything suspicious immediately
- Reply style: ${ctx.reply_style || 'professional'}

PRIORITY RULES (apply strictly):
- URGENT: client escalation, C-suite/partner request, regulatory/compliance deadline, deal at risk, security threat, anything needing action within 2 hours
- HIGH: active client request, senior stakeholder meeting request, deliverable due within 24-48h, overdue follow-up
- NORMAL: routine correspondence requiring response within 48h, scheduling, non-urgent requests
- LOW: FYI with no action, soft-interest notifications, low-stakes administrative items
- NOISE: marketing, promotional, auto-generated system notifications, obvious spam — anything that should be archived without reading

PHISHING SIGNALS to check for each message:
- Sender display name doesn't match email domain (e.g. "Microsoft Support" from support@microsooft.net)
- Urgency language combined with payment, credential, or wire transfer requests
- Lookalike domains (0 for o, 1 for l, extra hyphens, misspelled brand names)
- Requests to change payment routing, vendor banking details, or W-9 information
- Unexpected password reset, account verification, or "click to confirm" links
- Impersonation of a known colleague, partner, or executive with unusual requests

IMPORTANT: When multiple messages from the same sender appear, note the pattern in the summary of the most recent one.

Messages: ${JSON.stringify(messages)}`.trim();

  if (action === 'draft_reply') {
    const m = messages[0];
    return `
CONTEXT: ${c}

Draft a reply to the following message on behalf of ${ctx.user_name}.

DRAFTING RULES:
- Tone: ${ctx.reply_style || 'professional'} — match this register precisely
- Length: proportional to the original. Short question → short answer. Complex request → thorough response.
- Format: Subject line on line 1 (re-use original subject with Re: prefix). Blank line. Greeting. Body paragraphs. Sign-off.
- Sign-off: use "${ctx.signoff || ctx.user_name}" as the sign-off name
- Do NOT use placeholder text like [insert X here] inside the draft body
- If critical information is missing to write the reply, list it AFTER the draft as: NEEDS: [specific item]
- Do NOT add a preamble before the draft — begin with the subject line immediately
- Write as if you are ${ctx.user_name}. First person. Confident. No over-apologizing.
- If the message is from a client, be attentive and responsive. If internal, be direct and efficient.

Message to reply to:
From: ${m.from_name || m.from_email || 'Unknown'}${m.from_email ? ` <${m.from_email}>` : ''}
Subject: ${m.subject || '(no subject)'}
Source: ${m.source || 'email'}
Body: ${m.body_preview || '(no body preview available)'}`.trim();
  }

  if (action === 'intro_email') {
    const { contact_a, contact_b, context_notes } = messages[0];
    return `
CONTEXT: ${c}

Write a professional introduction email from ${ctx.user_name} connecting two contacts.

RULES:
- ${ctx.user_name} is writing from their own address — this is their email to send
- Tone: warm, specific, credible. Avoid generic phrases like "I thought you two should connect"
- Must explain concretely WHY these two people will find value in knowing each other
- Reference specific details from their backgrounds where provided
- Length: 150-220 words. Tight and purposeful — busy people don't read long intro emails.
- Format: Subject line on line 1. Blank line. Body. Sign-off with ${ctx.user_name}.
- Begin the email immediately — no preamble before the subject line.

Contact A: ${JSON.stringify(contact_a)}
Contact B: ${JSON.stringify(contact_b)}
Context / reason for introduction: ${context_notes || 'No additional context provided.'}`.trim();
  }

  if (action === 'security_scan') return `
CONTEXT: ${c}

Perform a professional-grade phishing and security analysis on the following ${messages.length} messages.
This is a high-stakes security review for a professional services firm. Be thorough and specific.

For each message, check:
  1. Sender identity mismatch — display name vs actual email domain
  2. Urgency language combined with payment, credential, wire transfer, or vendor change requests
  3. Lookalike or typosquatted domains (micros0ft, pay-pal, secure-login, etc.)
  4. Requests to change payment routing, banking details, W-9, or vendor ACH information
  5. Unexpected links to login pages, document confirmations, or "verify your account" flows
  6. Impersonation of known executives, partners, or colleagues with unusual or out-of-character requests
  7. BEC (business email compromise) patterns — e.g., CEO asking for gift cards, wire transfers, or confidential data
  8. Attachment-based threats — password-protected ZIPs, executable files, or unusual Office docs

Return a JSON array only — no preamble, no markdown fences:
  { id, risk_level, signals, recommendation }
  risk_level: HIGH | MEDIUM | LOW | NONE
  signals: array of specific, quoted signal strings (empty array if NONE)
  recommendation: one concrete action sentence (e.g. "Delete and block sender" or "Verify via phone call before acting")

Messages: ${JSON.stringify(messages)}`.trim();

  throw new Error(`Unknown email action: ${action}`);
}
