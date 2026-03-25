import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth, decryptToken } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default withAuth(async (req, { user }) => {
  if (req.method !== 'POST') return error('Method not allowed', 405);

  const today = new Date().toISOString().split('T')[0];

  const [msgsResult, profileResult, settingsResult] = await Promise.all([
    supabaseAdmin.from('messages').select('source,type,sender,subject,category,priority,channel,received_at')
      .eq('user_id', user.id).gte('received_at', today + 'T00:00:00Z').order('priority', { ascending: false }),
    supabaseAdmin.from('profiles').select('*').eq('id', user.id).single(),
    supabaseAdmin.from('user_settings').select('claude_key_encrypted').eq('user_id', user.id).single(),
  ]);

  const messages = msgsResult.data || [];
  const profile  = profileResult.data || {};
  const apiKey   = settingsResult.data?.claude_key_encrypted
    ? await decryptToken(settingsResult.data.claude_key_encrypted)
    : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) return error('No Claude API key configured', 400);

  const client = new Anthropic({ apiKey });
  const model  = profile.model || 'claude-sonnet-4-20250514';

  const summary = messages.map(m =>
    `[${m.source.toUpperCase()} ${m.type}${m.channel ? ' in ' + m.channel : ''}] From: ${m.sender} | "${m.subject}" | Priority: ${m.priority}% | Category: ${m.category}`
  ).join('\n');

  const dateStr  = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  const userName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'the user';

  const stats = {
    total:    messages.length,
    action:   messages.filter(m => m.category === 'action').length,
    meetings: messages.filter(m => m.category === 'meeting').length,
    noise:    messages.filter(m => m.category === 'noise').length,
    sources:  [...new Set(messages.map(m => m.source))],
  };

  const prompt = `Generate a daily communication intelligence briefing for ${userName} on ${dateStr}.

Today's messages (${messages.length} total across ${stats.sources.join(', ')}):
${summary || 'No messages today.'}

Stats: ${stats.action} action required, ${stats.meetings} meetings, ${stats.noise} noise filtered.

Write a 4-5 sentence executive briefing covering:
1. Overall communication load and tone for the day
2. Top 2-3 items requiring immediate attention (name them specifically)
3. Any notable patterns or themes across platforms
4. Estimated time saved by AI filtering
5. One specific recommendation for tackling today's inbox

Confident, direct prose. No bullet points. No markdown. Address ${profile.first_name || 'the user'} by name if available.`;

  const message = await client.messages.create({
    model, max_tokens: 600,
    system: 'You are an AI chief of staff generating daily cross-platform communication intelligence reports. Specific, data-driven, direct. Flowing professional prose. No markdown.',
    messages: [{ role: 'user', content: prompt }]
  });

  return json({ report: message.content[0].text, stats, date: dateStr });
});

