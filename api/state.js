// API de synchro : stocke l'état du projet dans Upstash Redis et fusionne les modifications.
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'gestion-projet:state';

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Même logique que dans index.html. En cas d'égalité, `a` (l'état déjà stocké) gagne.
function merge(a, b) {
  const r = {};
  const pm = (b.mu || 0) > (a.mu || 0) ? b : a;
  r.members = pm.members; r.mu = pm.mu || 0;
  const pc = (b.cu || 0) > (a.cu || 0) ? b : a;
  r.columns = pc.columns; r.cu = pc.cu || 0;
  r.deleted = { ...(a.deleted || {}) };
  for (const k in b.deleted || {}) r.deleted[k] = Math.max(r.deleted[k] || 0, b.deleted[k]);
  const m = {};
  for (const t of [...(a.tasks || []), ...(b.tasks || [])]) {
    if (!m[t.id] || (t.u || 0) > (m[t.id].u || 0)) m[t.id] = t;
  }
  const ids = new Set(r.columns.map((c) => c.id));
  r.tasks = Object.values(m)
    .filter((t) => !(r.deleted[t.id] >= (t.u || 0)))
    .map((t) => (ids.has(t.col) ? t : { ...t, col: r.columns[0] && r.columns[0].id }));
  return r;
}

function valid(s) {
  return s && Array.isArray(s.members) && Array.isArray(s.columns) && Array.isArray(s.tasks) &&
    s.columns.length > 0 && typeof s.deleted === 'object';
}

function passwordOk(given) {
  const expected = process.env.APP_PASSWORD || '';
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return expected !== '' && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Base Redis non configurée' });
  if (!process.env.APP_PASSWORD) return res.status(500).json({ error: 'APP_PASSWORD non défini' });
  if (!passwordOk(req.headers['x-password'])) return res.status(401).json({ error: 'Mot de passe incorrect' });

  try {
    const raw = await redis(['GET', KEY]);
    const stored = raw ? JSON.parse(raw) : null;

    if (req.method === 'GET') return res.status(200).json(stored);

    if (req.method === 'POST') {
      const incoming = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!valid(incoming)) return res.status(400).json({ error: 'Données invalides' });
      const out = stored && valid(stored) ? merge(stored, incoming) : merge(incoming, incoming);
      await redis(['SET', KEY, JSON.stringify(out)]);
      return res.status(200).json(out);
    }
    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
