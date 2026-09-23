// Alarm beeps via WebAudio
chrome.runtime.onMessage.addListener(m => {
  if (m.type !== 'beep') return;
  const ctx = new AudioContext();
  for (let i = 0; i < 6; i++) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = i % 2 ? 660 : 880;
    g.gain.value = 0.25;
    o.connect(g).connect(ctx.destination);
    const t = ctx.currentTime + i * 0.35;
    o.start(t);
    o.stop(t + 0.25);
  }
  setTimeout(() => ctx.close(), 3000);
});
