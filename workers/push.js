// Web Push (RFC 8291) + VAPID (RFC 8292) — pure Web Crypto API, no Node.js deps

const enc = new TextEncoder();

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromb64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function cat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrays) { out.set(a, i); i += a.length; }
  return out;
}

async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// HKDF(salt, ikm, info, length) — single-step, length ≤ 32
async function hkdf(salt, ikm, info, len) {
  const prk = await hmacSha256(salt, ikm);
  const infoBytes = typeof info === 'string' ? enc.encode(info) : info;
  return (await hmacSha256(prk, cat(infoBytes, new Uint8Array([1])))).slice(0, len);
}

async function encryptPayload(subscription, payload) {
  const uaPub = fromb64url(subscription.keys.p256dh);
  const authSecret = fromb64url(subscription.keys.auth);

  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));

  const uaPubKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPubKey }, kp.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 §3 key derivation
  const ikm = await hkdf(authSecret, ecdh, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      cat(enc.encode(payload), new Uint8Array([2])), // 0x02 = last-record delimiter
    ),
  );

  // aes128gcm record header: salt(16) | rs(4 BE) | idlen(1) | keyid(asPub)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

async function vapidJWT(endpoint, env) {
  const { origin } = new URL(endpoint);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: origin, exp: now + 43200, sub: env.VAPID_SUBJECT })));

  const pub = fromb64url(env.VAPID_PUBLIC_KEY);
  const privKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)) },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

export async function sendPush(subscription, payload, env) {
  const body = await encryptPayload(subscription, payload);
  const jwt = await vapidJWT(subscription.endpoint, env);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
    },
    body,
  });

  return res.status;
}
