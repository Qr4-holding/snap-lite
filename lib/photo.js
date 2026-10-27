// Turns whatever a phone sends into a JPEG: finds out what the file really is, converts HEIC, rotates, caps the size, drops hidden data.
const sharp = require('sharp');

function sniff(buf) {
  if (!buf || buf.length < 12) return { type: 'too-small', brand: '' };
  const b = buf, s4 = b.toString('latin1', 4, 8), brand = b.toString('latin1', 8, 12);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'jpeg', brand: '' };
  if (b.toString('latin1', 1, 4) === 'PNG') return { type: 'png', brand: '' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { type: 'webp', brand: '' };
  if (b.toString('latin1', 0, 3) === 'GIF') return { type: 'gif', brand: '' };
  if (s4 === 'ftyp') return { type: /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(brand) ? 'heic' : (/^avi[fs]/.test(brand) ? 'avif' : 'ftyp'), brand };
  return { type: 'unknown', brand: '' };
}

async function normalize(buf) {
  const detected = sniff(buf);
  const heic = async () => Buffer.from(await require('heic-convert')({ buffer: buf, format: 'JPEG', quality: 0.92 }));
  let b = buf, via = 'sharp';
  try {
    if (detected.type === 'heic') { try { b = await heic(); via = 'heic-convert'; } catch (e) { b = buf; via = 'sharp'; } }
    let img = sharp(b, { failOn: 'none' }).rotate();
    try { await img.clone().resize({ width: 8, height: 8, fit: 'inside' }).raw().toBuffer(); }
    catch (e) { if (via === 'heic-convert') throw e; b = await heic(); via = 'heic-convert'; img = sharp(b, { failOn: 'none' }).rotate(); }
    const full = await img.clone().resize({ width: 2160, height: 2160, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    const thumb = await img.clone().resize({ width: 320, height: 320, fit: 'inside' }).jpeg({ quality: 78 }).toBuffer();
    return { full: full.data, thumb, width: full.info.width, height: full.info.height, via, detected };
  } catch (e) { e.detected = detected; throw e; }
}
module.exports = { sniff, normalize };
