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

async function sendAll(env, isEvening) {
  const title = isEvening ? 'PEM-Tracker: Abend-Check' : 'PEM-Tracker: Morgen-Check';
  const body = isEvening
    ? 'Wie war dein Tag? Bitte deinen Abend-Eintrag machen.'
    : 'Guten Morgen! Bitte deinen Morgen-Eintrag machen.';

  let cursor;
  do {
    const list = await env.KV.list({ prefix: 'sub:', cursor });
    cursor = list.list_complete ? undefined : list.cursor;
    await Promise.all(
      list.keys.map(async ({ name }) => {
        const stored = await env.KV.get(name, 'json');
        if (!stored?.subscription) return;
        try {
          const status = await sendPush(stored.subscription, JSON.stringify({ title, body }), env);
          if (status === 410) await env.KV.delete(name); // subscription expired
        } catch { /* ignore invalid subscriptions */ }
      }),
    );
  } while (cursor);
}

export default {
  async fetch(request, env) {
    const { method } = request;
    const { pathname } = new URL(request.url);

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (pathname === '/api/subscribe') {
      if (method === 'POST') {
        const { deviceId, subscription, morningTime, eveningTime } = await request.json();
        if (!deviceId || !subscription?.endpoint) return json({ error: 'Missing fields' }, 400);
        await env.KV.put(`sub:${deviceId}`, JSON.stringify({ subscription, morningTime, eveningTime }));
        return json({ ok: true }, 201);
      }
      if (method === 'DELETE') {
        const { deviceId } = await request.json().catch(() => ({}));
        if (deviceId) await env.KV.delete(`sub:${deviceId}`);
        return json({ ok: true });
      }
    }

    // Manual trigger for testing: GET /api/notify?evening=1
    if (pathname === '/api/notify' && method === 'GET') {
      const isEvening = new URL(request.url).searchParams.get('evening') === '1';
      await sendAll(env, isEvening);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env) {
    await sendAll(env, new Date().getUTCHours() >= 12);
  },
};
