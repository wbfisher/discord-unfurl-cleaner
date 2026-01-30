import { logger } from '../utils/logger.js';

interface QueueItem {
  execute: () => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

const channelQueues = new Map<string, QueueItem[]>();
const channelProcessing = new Map<string, boolean>();

const RATE_LIMIT_MS = 3000; // 1 message per 3 seconds per channel

async function processQueue(channelId: string): Promise<void> {
  if (channelProcessing.get(channelId)) {
    return;
  }

  const queue = channelQueues.get(channelId);
  if (!queue || queue.length === 0) {
    return;
  }

  channelProcessing.set(channelId, true);

  while (queue.length > 0) {
    const item = queue.shift()!;

    try {
      await item.execute();
      item.resolve();
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    }

    // Wait before processing next item
    if (queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS));
    }
  }

  channelProcessing.set(channelId, false);
}

export function enqueue(channelId: string, execute: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!channelQueues.has(channelId)) {
      channelQueues.set(channelId, []);
    }

    const queue = channelQueues.get(channelId)!;
    queue.push({ execute, resolve, reject });

    logger.debug(`Enqueued task for channel ${channelId}, queue length: ${queue.length}`);

    // Start processing if not already
    processQueue(channelId);
  });
}

export function getQueueLength(channelId: string): number {
  return channelQueues.get(channelId)?.length || 0;
}

export function clearQueue(channelId: string): void {
  const queue = channelQueues.get(channelId);
  if (queue) {
    // Reject all pending items
    for (const item of queue) {
      item.reject(new Error('Queue cleared'));
    }
    queue.length = 0;
  }
}

export function clearAllQueues(): void {
  for (const channelId of channelQueues.keys()) {
    clearQueue(channelId);
  }
  channelQueues.clear();
  channelProcessing.clear();
}
