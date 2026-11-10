// S1 worker_threads probe (P0-S1-T2 step 8): repeats steps 2-5 off the utilityProcess main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { probeCore } from './db.ts';

try { parentPort!.postMessage(probeCore(workerData.file)); } catch (e) { parentPort!.postMessage({ error: (e as Error).message }); }
