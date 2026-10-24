import { parentPort, workerData } from 'node:worker_threads';
import { serveMusicWorker } from './music-worker-server.mjs';

if (!parentPort) throw new Error('Music worker requires a parent port');
serveMusicWorker(parentPort, workerData);
