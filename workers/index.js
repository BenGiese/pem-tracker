import { sendPush } from './push.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

function toMin(utcTime) {
  const [h, m] = utcTime.split(':').map(Number);
  return h * 60 + m;
}

// forceSlot: 'morning' | 'evening' | null (null = check per-user UTC times)
async function sendAll(env, forceSlot) {
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();

  let cursor;
  do {
    const list = await env.KV.list({ prefix: 'sub:', cursor });
    cursor = list.list_complete ? undefined : list.cursor;
    await Promise.all(
      list.keys.map(async ({ name }) => {
        const stored = await env.KV.get(name, 'json');
        if (!stored?.subscription) return;

        const morningMin = toMin(stored.morningUTC || '05:30');
        const eveningMin = toMin(stored.eveningUTC || '18:00');
        const inWindow = (min) => nowMin - min >= 0 && nowMin - min < 30;

        const isMorning = forceSlot === 'morning' || (forceSlot == null && inWindow(morningMin));
        const isEvening = forceSlot === 'evening' || (forceSlot == null && inWindow(eveningMin));
        if (!isMorning && !isEvening) return;

        const title = isMorning ? 'PEM-Tracker: Morgen-Check' : 'PEM-Tracker: Abend-Check';
        const body = isMorning
          ? 'Guten Morgen! Bitte deinen Morgen-Eintrag machen.'
          : 'Wie war dein Tag? Bitte deinen Abend-Eintrag machen.';

        try {
          const { status } = await sendPush(stored.subscription, JSON.stringify({ title, body }), env);
          if (status === 410) await env.KV.delete(name);
        } catch { /* ignore invalid subscriptions */ }
      }),
    );
  } while (cursor);
}

export default {
  async fetch(request, env) {
    const { method } = request;
    const url = new URL(request.url);

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/api/subscribe') {
      if (method === 'POST') {
        const { deviceId, subscription, morningUTC, eveningUTC } = await request.json();
        if (!deviceId || !subscription?.endpoint) return json({ error: 'Missing fields' }, 400);
        await env.KV.put(`sub:${deviceId}`, JSON.stringify({ subscription, morningUTC, eveningUTC }));
        return json({ ok: true }, 201);
      }
      if (method === 'DELETE') {
        const { deviceId } = await request.json().catch(() => ({}));
        if (deviceId) await env.KV.delete(`sub:${deviceId}`);
        return json({ ok: true });
      }
    }

    // Manual trigger: GET /api/notify?slot=morning|evening (omit for time-based check)
    if (url.pathname === '/api/notify' && method === 'GET') {
      const slot = url.searchParams.get('slot') || null;
      await sendAll(env, slot);
      return json({ ok: true });
    }

    // Debug: GET /api/debug — sends to all subs and returns FCM status per device
    if (url.pathname === '/api/debug' && method === 'GET') {
      const results = [];
      const list = await env.KV.list({ prefix: 'sub:' });
      await Promise.all(list.keys.map(async ({ name }) => {
        const stored = await env.KV.get(name, 'json');
        if (!stored?.subscription) { results.push({ key: name, error: 'no subscription' }); return; }
        try {
          const result = await sendPush(stored.subscription, JSON.stringify({ title: 'PEM-Tracker Test', body: 'Debug-Nachricht' }), env);
          results.push({ key: name, morningUTC: stored.morningUTC, eveningUTC: stored.eveningUTC, ...result });
        } catch (e) {
          results.push({ key: name, error: String(e) });
        }
      }));
      return json({ results });
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env) {
    await sendAll(env, null);
  },
};
