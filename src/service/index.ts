// Service process (utilityProcess). P1-T04: announces readiness and exits on request; P1-T06 adds supervision and
// health, P1-T07/T10 wiring the store and Claude ingest.
const parent = process.parentPort;

parent.on('message', (e: { data?: { type?: unknown } }) => { if (e.data?.type === 'quit') process.exit(0); });
parent.postMessage({ type: 'ready' });
