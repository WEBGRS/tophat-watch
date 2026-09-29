// Soft two-note chime via WebAudio
chrome.runtime.onMessage.addListener(m => {
  if (m.type !== 'beep') return;
  const ctx = new AudioContext();
  [659, 880].forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = ctx.currentTime + i * 0.18;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 1);
  });
  setTimeout(() => ctx.close(), 2000);
});
