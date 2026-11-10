// Paints one element per event from the service port and acks after the next frame.
const list = document.getElementById('events');
window.addEventListener('message', (e) => {
  if (e.data !== 'xaibo-port' || !e.ports[0]) return;
  const port = e.ports[0];
  port.onmessage = ({ data }) => {
    if (data?.type !== 'event') return;
    const el = document.createElement('div');
    el.textContent = `event ${data.id}`;
    list.append(el);
    requestAnimationFrame(() => port.postMessage({ type: 'paint-ack', id: data.id }));
  };
});
