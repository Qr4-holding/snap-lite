// Which build is running: the version label and the git commit the container cloned on start.
const { execFileSync } = require('child_process');
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, timeout: 3000 }).toString().trim() || 'unknown'; } catch (e) {}
module.exports = { version: process.env.APP_VERSION || 'dev', commit, started: new Date().toISOString() };
