// Loads the skin chosen by SKIN=<id>. Nothing client-specific lives anywhere except skins/<id>/.
const fs = require('fs');
const path = require('path');

const ID = /^[a-z0-9-]+$/.test(process.env.SKIN || '') ? process.env.SKIN : 'ekp11';
const DIR = path.join(__dirname, '..', 'skins', ID);
const skin = JSON.parse(fs.readFileSync(path.join(DIR, 'skin.json'), 'utf8'));
skin.dir = DIR;
skin.logoFile = path.join(DIR, skin.logo || 'logo.png');
// binary files travel through git as <name>.b64 text; unpack on first start
for (const f of [skin.logoFile]) if (!fs.existsSync(f) && fs.existsSync(f + '.b64')) fs.writeFileSync(f, Buffer.from(fs.readFileSync(f + '.b64', 'utf8'), 'base64'));
skin.iconFile = path.join(DIR, 'icon.png');
skin.splashFile = path.join(DIR, 'splash.png');
skin.max_during = Math.max(0, Math.min(3, skin.max_during == null ? 3 : skin.max_during));
module.exports = skin;
