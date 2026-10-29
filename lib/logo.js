// The owner can replace the skin's logo. The custom logo lives with the media (survives restarts); the skin's logo is the fallback.
const fs = require('fs'), path = require('path');
module.exports = function logo(SKIN) {
  const dir = path.join(process.env.MEDIA_DIR || '/data/media', 'brand'), file = path.join(dir, 'logo.png');
  return {
    file,
    custom: () => fs.existsSync(file),
    current: () => fs.existsSync(file) ? file : SKIN.logoFile,                                   // what the video engine and the app use
    version: () => { try { return String(Math.floor(fs.statSync(file).mtimeMs)); } catch (e) { return '0'; } },
    save: buf => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf); },
    clear: () => { try { fs.unlinkSync(file); } catch (e) {} }
  };
};
