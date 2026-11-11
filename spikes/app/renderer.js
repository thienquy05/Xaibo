// Paints one element per event from the service port and acks once that frame has been painted.
const list = document.getElementById('events');
window.addEventListener('message', (e) => {
  if (e.data !== 'xaibo-port' || !e.ports[0]) return;
  const port = e.ports[0];
  port.onmessage = ({ data }) => {
    if (data?.type !== 'event') return;
    const el = document.createElement('div');
    el.textContent = `event ${data.id}`;
    list.append(el);
    // A rAF callback runs before its frame is painted: ack from the NEXT frame's callback, so the element's frame has
    // been painted (an upper bound that includes up to one extra frame).
    requestAnimationFrame(() => requestAnimationFrame(() => port.postMessage({ type: 'paint-ack', id: data.id })));
  };
});
