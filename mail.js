// Sends the few emails the app needs (password reset) through Brevo SMTP. Keys live in the settings table (see /admin).
// Addresses on the test domain are never sent: they land in a small in-memory outbox that /admin can read, so tests can follow the link.
const nodemailer = require('nodemailer');

module.exports = function mail(secrets, SKIN, TEST_DOMAIN) {
  const outbox = [];
  async function configured() { return !!((await secrets.get('brevo_login')) && (await secrets.get('brevo_key')) && (await secrets.get('mail_from'))); }
  async function send({ to, subject, text }) {
    if (to.endsWith(TEST_DOMAIN)) { outbox.push({ to, subject, text, at: Date.now() }); if (outbox.length > 50) outbox.shift(); return true; }
    if (!(await configured())) { console.warn('mail: not configured, message not sent'); return false; }
    const tr = nodemailer.createTransport({ host: 'smtp-relay.brevo.com', port: 587, secure: false, requireTLS: true,
      auth: { user: await secrets.get('brevo_login'), pass: await secrets.get('brevo_key') }, connectionTimeout: 15000, socketTimeout: 20000 });
    await tr.sendMail({ from: `"${SKIN.name.replace(/["\r\n]/g, '')}" <${await secrets.get('mail_from')}>`, to, subject, text });
    return true;
  }
  return { send, configured, outbox };
};
