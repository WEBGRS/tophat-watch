// Page-world hook: forwards Top Hat server pushes (WebSocket frames) to content.js
(() => {
  if (window.__thwHooked) return;
  window.__thwHooked = true;
  const NOISE = /^(pong|ping|heartbeat|register-ok|ack|connected|welcome)$/i;
  const META_NOISE = /authori[sz]e|subscri|register|connect|ping|pong/i;
  // Classmate activity (discussion posts/upvotes), not instructor pushes
  const STUDENT_NOISE = /^discussion:/i;
  const THIRD_PARTY = /intercom|pendo|segment|sentry|fullstory|hotjar|launchdarkly|walkme|datadog|newrelic/i;

  // SockJS: o=open, h=heartbeat, a[...]=messages, m"..."=single, c[...]=close
  function unwrap(data) {
    if (typeof data !== 'string' || !data.length) return [];
    const k = data[0];
    if (data === 'o' || data === 'h' || k === 'c') return [];
    if (k === 'a') { try { return JSON.parse(data.slice(1)); } catch { return []; } }
    if (k === 'm') { try { return [JSON.parse(data.slice(1))]; } catch { return []; } }
    return [data];
  }

  function inspect(host, ev) {
    for (const f of unwrap(ev.data)) {
      let o = f;
      // Socket.IO: only 42/43 carry events; 0/2/3/40 are handshake/ping/pong
      const sio = typeof f === 'string' && f.match(/^(\d+)([\s\S]*)$/);
      if (sio) {
        if (!/^4[23]/.test(sio[1])) continue;
        try { const a = JSON.parse(sio[2]); o = Array.isArray(a) ? { type: a[0], data: a[1] } : a; } catch { continue; }
      } else if (typeof f === 'string') { try { o = JSON.parse(f); } catch { o = { type: 'raw', text: f }; } }
      if (!o || typeof o !== 'object') continue;
      const type = String(o.type || o.event || o.name || 'unknown');
      const d = o.data && typeof o.data === 'object' ? o.data : {};
      const event = String(d.event || d.type || d.action || '');
      if (NOISE.test(type) || STUDENT_NOISE.test(event)) continue;
      if (/^meta$/i.test(type) && (d.auth !== undefined || META_NOISE.test(event))) continue;
      // Module item state (id/name/module/status) drives the "opened" alert
      const pl = d.payload && typeof d.payload === 'object' ? d.payload : {};
      const info = { id: pl.id, name: pl.display_name, module: pl.module_id, status: pl.status };
      window.postMessage({ __thw: 'push', host, type, event, info, sample: JSON.stringify(o).slice(0, 500) }, location.origin);
    }
  }

  const Native = window.WebSocket;
  class Hooked extends Native {
    constructor(...args) {
      super(...args);
      let host = '';
      try { host = new URL(String(args[0]), location.href).host; } catch { /* bad url */ }
      if (!THIRD_PARTY.test(host)) this.addEventListener('message', ev => inspect(host, ev));
    }
  }
  window.WebSocket = Hooked;
})();
