// api/ai/report.js  [nodejs runtime]
import Anthropic from '@anthropic-ai/sdk';
import { verifyJWT } from '../_lib/auth.js';
import { createSupabaseClient } from '../_lib/supabase.js';
import { SYSTEM_PROMPT } from '../_lib/systemPrompt.js';
import { buildReportPrompt } from '../_lib/reportPrompt.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  const user = await verifyJWT(req).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createSupabaseClient();
  const since24h    = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const todayStr    = new Date().toISOString().substring(0, 10);
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().substring(0, 10);

  const [{ data: messages }, { data: meetings }, { data: settings }] = await Promise.all([
    supabase
      .from('messages')
      .select('id,subject,from_name,sender,source,ai_priority,ai_category,ai_summary,ai_action,phishing_flags,draft_reply,received_at,category,priority')
      .eq('user_id', user.userId)
      .gte('received_at', since24h)
      .order('received_at', { ascending: false })
      .limit(60),
    supabase
      .from('meetings')
      .select('id,title,date,time,duration,platform,attendees,organizer,ai_brief,ai_summary')
      .eq('user_id', user.userId)
      .gte('date', todayStr)
      .lte('date', tomorrowStr),
    supabase.from('user_settings').select('*').eq('user_id', user.userId).single(),
  ]);

  const actionItems = (messages || []).filter(m => m.category === 'action' || m.ai_category === 'action_required');

  const ctx = {
    user_name:    `${settings?.first_name || ''} ${settings?.last_name || ''}`.trim() || 'User',
    user_role:    settings?.role    || 'professional',
    user_company: settings?.company || '',
    inbox_count:  2,
  };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = buildReportPrompt(
    { messages: messages || [], meetings: meetings || [], action_items: actionItems },
    ctx
  );

  // Stream the response
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const stream = client.messages.stream({
      model:      'claude-opus-4-7',
      max_tokens: 2000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: prompt }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ t: event.delta.text })}\n\n`);
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
    return;
  }

  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
}
