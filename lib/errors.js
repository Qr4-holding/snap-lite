// Plain-words messages for things that go wrong while a video is made.
// A failure is stored as a short tag (the raw detail goes to the event log), and turned into a sentence here,
// worded for whoever is looking: the owner gets the fix, crew get who to ask. No servers, keys or codes.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TAGS = ['voice_off', 'voice_rejected', 'voice_busy', 'photos', 'other'];
function renderFailure(tag, role, bizName) {
  const owner = role === 'owner', who = esc(bizName || 'the owner');
  switch (TAGS.includes(tag) ? tag : 'other') {
    case 'voice_off': return owner
      ? `Voice isn't switched on for this app yet. Set it up under <a href="/settings">Settings → Keys</a>, or choose <b>No voice</b> to make a silent video.`
      : `Voice isn't switched on for this app yet. Ask ${who}. Or choose <b>No voice</b> to make a silent video.`;
    case 'voice_rejected': return owner
      ? `The voice could not be added, so the video was not made. Check the voice account (the key and any credit left) under <a href="/settings">Settings → Keys</a>, or choose <b>No voice</b> for a silent video.`
      : `The voice could not be added, so the video was not made. Ask ${who} to check the voice setup, or choose <b>No voice</b> for a silent video.`;
    case 'voice_busy': return `The voice service is busy right now. Wait a minute and tap <b>Try again</b>, or choose <b>No voice</b> for a silent video.`;
    case 'photos': return `The video needs a BEFORE and an AFTER photo. Tap <b>Change photos</b>, then try again.`;
    default: return owner
      ? `Something went wrong making the video. Tap <b>Try again</b>. If it fails a second time, tell us when it happened.`
      : `Something went wrong making the video. Tap <b>Try again</b>. If it fails a second time, tell ${who}.`;
  }
}
const plain = (t, role, name) => renderFailure(t, role, name).replace(/<[^>]+>/g, '');
module.exports = { renderFailure, plain, TAGS };
