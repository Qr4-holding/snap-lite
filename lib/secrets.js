// API keys live in the database settings table (set from /admin), with environment variables as a fallback. Never logged, never sent to a browser.
module.exports = function secrets(pool) {
  const ENV = { elevenlabs_key: 'ELEVENLABS_API_KEY', anthropic_key: 'ANTHROPIC_API_KEY', brevo_login: 'BREVO_SMTP_LOGIN', brevo_key: 'BREVO_SMTP_KEY', mail_from: 'MAIL_FROM' };
  const cache = new Map();
  return {
    async get(name) {
      if (cache.has(name)) return cache.get(name);
      let v = '';
      try { const r = (await pool.query('SELECT value FROM settings WHERE key=$1', [name])).rows[0]; if (r) v = r.value; } catch (e) {}
      v = v || process.env[ENV[name]] || ''; cache.set(name, v); return v;
    },
    async set(name, value) {
      if (!ENV[name]) throw new Error('unknown secret');
      await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [name, value]); cache.delete(name);
    },
    async has(name) { return !!(await this.get(name)); }
  };
};
