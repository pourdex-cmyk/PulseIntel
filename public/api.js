// ═══════════════════════════════════════════════════════════════
// PULSE INTELLIGENCE — FRONTEND API CLIENT
// Replaces all localStorage calls with proper API calls
// Include this before your main app script
// ═══════════════════════════════════════════════════════════════

const API = (() => {

  // ── Auth state ─────────────────────────────────────────────
  let _token     = sessionStorage.getItem('pi_token')     || null;
  let _refreshTk = sessionStorage.getItem('pi_refresh')   || null;
  let _user      = JSON.parse(sessionStorage.getItem('pi_user') || 'null');
  let _profile   = JSON.parse(sessionStorage.getItem('pi_profile') || 'null');

  // ── Base request ───────────────────────────────────────────
  async function req(method, path, body = null, retry = true) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (_token) opts.headers['Authorization'] = `Bearer ${_token}`;
    if (body)   opts.body = JSON.stringify(body);

    const res = await fetch(`/api${path}`, opts);

    // Auto-refresh on 401
    if (res.status === 401 && retry && _refreshTk) {
      const refreshed = await refreshSession();
      if (refreshed) return req(method, path, body, false);
      logout(); return null;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  async function refreshSession() {
    try {
      const data = await req('POST', '/auth/refresh', { refresh_token: _refreshTk }, false);
      if (!data?.access_token) return false;
      setSession(data.access_token, data.refresh_token);
      return true;
    } catch { return false; }
  }

  function setSession(token, refresh) {
    _token     = token;
    _refreshTk = refresh;
    sessionStorage.setItem('pi_token',   token);
    sessionStorage.setItem('pi_refresh', refresh);
  }

  function logout() {
    _token = _refreshTk = _user = _profile = null;
    sessionStorage.clear();
    window.location.href = '/login';
  }

  // ── Auth ───────────────────────────────────────────────────
  const auth = {
    get user()      { return _user; },
    get profile()   { return _profile; },
    get isLoggedIn(){ return !!_token; },
    get _token()    { return _token; },   // exposed for Authorization header in app

    async login(email, password) {
      const data = await req('POST', '/auth/login', { email, password });
      setSession(data.access_token, data.refresh_token);
      _user    = data.user;
      _profile = data.profile;
      sessionStorage.setItem('pi_user',    JSON.stringify(_user));
      sessionStorage.setItem('pi_profile', JSON.stringify(_profile));
      return data;
    },

    async signup(email, password, firstName, lastName) {
      return req('POST', '/auth/signup', { email, password, firstName, lastName });
    },

    async logout() {
      try { await req('POST', '/auth/logout'); } catch {}
      logout();
    },
  };

  // ── Profile ────────────────────────────────────────────────
  const profile = {
    async get() {
      const data = await req('GET', '/settings/profile');
      _profile = data;
      sessionStorage.setItem('pi_profile', JSON.stringify(data));
      return data;
    },
    async update(fields) {
      const data = await req('PUT', '/settings/profile', fields);
      _profile = data;
      sessionStorage.setItem('pi_profile', JSON.stringify(data));
      return data;
    },
  };

  // ── Connectors ─────────────────────────────────────────────
  const connectors = {
    async get()              { return req('GET',    '/settings/connectors'); },
    async save(tokens)       { return req('PUT',    '/settings/connectors', tokens); },
    async disconnect(source) { return req('DELETE', '/settings/connectors', { source }); },
  };

  // ── Messages ───────────────────────────────────────────────
  const messages = {
    async list(params = {}) {
      const qs = new URLSearchParams(Object.entries(params).filter(([,v]) => v != null)).toString();
      return req('GET', `/messages${qs ? '?' + qs : ''}`);
    },
    async get(id)              { return req('GET',    `/messages/${id}`); },
    async patch(id, fields)    { return req('PATCH',  `/messages/${id}`, fields); },
    async archive(id)          { return req('PATCH',  `/messages/${id}`, { category: 'archived' }); },
    async markRead(id)         { return req('PATCH',  `/messages/${id}`, { unread: false }); },
    async delete(id)           { return req('DELETE', `/messages/${id}`); },
  };

  // ── Meetings ───────────────────────────────────────────────
  const meetings = {
    async list(filter = 'today') { return req('GET', `/meetings?filter=${filter}`); },
    async get(id)                { return req('GET',    `/meetings/${id}`); },
    async create(data)           { return req('POST',   '/meetings', data); },
    async update(id, data)       { return req('PUT',    `/meetings/${id}`, data); },
    async delete(id)             { return req('DELETE', `/meetings/${id}`); },
  };

  // ── AI ─────────────────────────────────────────────────────
  const ai = {
    async analyze(messageId, type = 'summary') {
      return req('POST', '/ai/analyze', { message_id: messageId, type });
    },
    async draft(messageId) {
      return req('POST', '/ai/draft', { message_id: messageId });
    },
    async report() {
      return req('POST', '/ai/report', {});
    },
    async meetingPrep(meetingId) {
      return req('POST', '/ai/meeting-prep', { meeting_id: meetingId });
    },
  };

  // ── Realtime subscription helper ───────────────────────────
  // Call this after login to get live message updates via Supabase Realtime
  function subscribeToMessages(onNew) {
    if (!window.supabase) return null;
    return window.supabase
      .channel('messages')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      }, payload => onNew(payload.new))
      .subscribe();
  }

  return { auth, profile, connectors, messages, meetings, ai, subscribeToMessages };
})();

// ── Supabase Realtime client (optional, for live updates) ─────
// Include Supabase JS CDN in your HTML if you want realtime:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
if (typeof window !== 'undefined' && window.supabaseUrl && window.supabaseAnonKey) {
  window.supabase = window.supabase?.createClient(window.supabaseUrl, window.supabaseAnonKey);
}

window.API = API;
