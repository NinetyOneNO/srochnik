const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const encoder = new TextEncoder();
async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(value)));
}
async function verifiedUser(initData: string): Promise<string | null> {
  if (!initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  if (new Set([...params.keys()]).size !== [...params.keys()].length) return null;
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  const authDate = Number(params.get('auth_date'));
  const age = Date.now() / 1000 - authDate;
  if (!Number.isFinite(age) || age < -60 || age > 86400) return null;
  params.delete('hash');
  const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('server configuration');
  const secret = await hmac(encoder.encode('WebAppData'), token);
  const signature = await hmac(secret, data);
  const expected = Uint8Array.from(hash.match(/../g)!, (s) => parseInt(s, 16));
  let difference = 0;
  signature.forEach((byte, index) => difference |= byte ^ expected[index]);
  if (difference !== 0) return null;
  try {
    const user = JSON.parse(params.get('user') || '{}');
    return Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : null;
  } catch { return null; }
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'method' }, 405);
  try {
    const text = await req.text();
    if (text.length > 150000) return reply({ error: 'too large' }, 413);
    const body = JSON.parse(text);
    const id = await verifiedUser(body.initData);
    if (!id) return reply({ error: 'invalid telegram session' }, 401);
    if (!['login', 'load', 'save', 'leaderboard', 'admin'].includes(body.mode)) return reply({ error: 'mode' }, 400);
    if (body.mode !== 'leaderboard' && (typeof body.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.sessionId))) return reply({ error: 'session' }, 400);
    if (body.mode === 'save' && (!Number.isSafeInteger(body.revision) || body.revision < 0 || !body.data || typeof body.data !== 'object' || Array.isArray(body.data))) return reply({ error: 'invalid save' }, 400);
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('server configuration');
    const leaderboard = body.mode === 'leaderboard';
    const admin = body.mode === 'admin';
    if (admin && !['list', 'get', 'save', 'ban', 'unban'].includes(body.action)) return reply({ error: 'action' }, 400);
    const response = await fetch(`${url}/rest/v1/rpc/${leaderboard ? 'srochnik_leaderboard' : admin ? 'srochnik_admin' : 'srochnik_session_save'}`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(leaderboard
        ? { p_telegram_id: id, p_limit: 50 }
        : admin ? { p_actor: id, p_session: body.sessionId, p_action: body.action, p_target: body.target || null, p_data: body.data ?? null, p_revision: body.revision ?? null }
        : { p_telegram_id: id, p_session_id: body.sessionId, p_mode: body.mode, p_data: body.mode === 'save' ? body.data : null, p_revision: body.mode === 'save' ? body.revision : null }),
    });
    if (!response.ok) throw new Error('database error');
    const result = await response.json();
    return reply(result, result.session_expired || result.forbidden || (!admin && result.banned) ? 403 : result.conflict ? 409 : result.invalid ? 400 : result.not_found ? 404 : 200);
  } catch { return reply({ error: 'server error' }, 500); }
});
