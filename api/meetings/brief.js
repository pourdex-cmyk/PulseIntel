// api/meetings/brief.js  [nodejs runtime]
import Anthropic from '@anthropic-ai/sdk';
import { verifyJWT } from '../_lib/auth.js';
import { createSupabaseClient } from '../_lib/supabase.js';
import { SYSTEM_PROMPT } from '../_lib/systemPrompt.js';
import { buildMeetingPrompt } from '../_lib/meetingPrompts.js';

export const config = { maxDuration: 45 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  const user = await verifyJWT(req).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { meeting_id, action = 'pre_brief' } = req.body || {};
  if (!meeting_id) return res.status(400).json({ error: 'meeting_id required' });

  const supabase = createSupabaseClient();
  const [{ data: meeting }, { data: settings }] = await Promise.all([
    supabase.from('meetings').select('*').eq('id', meeting_id).eq('user_id', user.userId).single(),
    supabase.from('user_settings').select('*').eq('user_id', user.userId).single(),
  ]);

  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  const ctx = {
    user_name:    `${settings?.first_name || ''} ${settings?.last_name || ''}`.trim() || 'User',
    user_role:    settings?.role    || 'professional',
    user_company: settings?.company || '',
  };

  const meetingData = {
    title:      meeting.title,
    date:       meeting.date,
    time:       meeting.time,
    duration:   meeting.duration,
    platform:   meeting.platform,
    attendees:  typeof meeting.attendees === 'string' ? JSON.parse(meeting.attendees || '[]') : (meeting.attendees || []),
    organizer:  meeting.organizer,
    notes:      meeting.notes,
    agenda:     typeof meeting.agenda === 'string' ? JSON.parse(meeting.agenda || '[]') : (meeting.agenda || []),
    transcript: meeting.transcript,
  };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = buildMeetingPrompt(action, meetingData, ctx);

  // deck_outline returns JSON — don't stream, return directly
  if (action === 'deck_outline') {
    let result;
    try {
      const response = await client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 3000,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: prompt }],
      });
      result = response.content[0]?.text || '';
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    await supabase.from('meetings')
      .update({ ai_deck: result })
      .eq('id', meeting_id)
      .eq('user_id', user.userId);
    return res.status(200).json({ ok: true, result, action });
  }

  // pre_brief and post_summary — stream the markdown response
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let fullText = '';
  try {
    const stream = client.messages.stream({
      model:      'claude-opus-4-7',
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: prompt }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullText += event.delta.text;
        res.write(`data: ${JSON.stringify({ t: event.delta.text })}\n\n`);
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
    return;
  }

  const updateField = action === 'post_summary' ? 'ai_summary' : 'ai_brief';
  await supabase.from('meetings')
    .update({ [updateField]: fullText })
    .eq('id', meeting_id)
    .eq('user_id', user.userId);

  res.write(`data: ${JSON.stringify({ done: true, action })}\n\n`);
  res.end();
}
