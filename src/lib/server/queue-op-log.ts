import { appendFileSync, existsSync, readFileSync } from 'fs';
import type { QueueItem } from '$lib/types';
import { OPS_FILE } from './document-files';

interface EnqueueEvent {
	event: 'enqueue';
	item: QueueItem;
}

interface ResolveEvent {
	event: 'resolve';
	ids: string[];
	resolvedAt: number;
}

type QueueLogEvent = EnqueueEvent | ResolveEvent;

function readLogLines(): string[] {
	try {
		if (!existsSync(OPS_FILE)) return [];
		return readFileSync(OPS_FILE, 'utf-8')
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

function appendLogEvent(event: QueueLogEvent) {
	appendFileSync(OPS_FILE, `${JSON.stringify(event)}\n`);
}

export function appendQueueItems(items: QueueItem[]) {
	for (const item of items) {
		appendLogEvent({ event: 'enqueue', item });
	}
}

export function resolveQueueItems(ids: string[]) {
	if (ids.length === 0) return;
	appendLogEvent({
		event: 'resolve',
		ids,
		resolvedAt: Date.now()
	});
}

export function getUnresolvedQueueItems(): QueueItem[] {
	const unresolvedItems = new Map<string, QueueItem>();
	for (const line of readLogLines()) {
		try {
			const event = JSON.parse(line) as QueueLogEvent;
			if (event.event === 'enqueue') {
				unresolvedItems.set(event.item.id, event.item);
				continue;
			}
			for (const id of event.ids) {
				unresolvedItems.delete(id);
			}
		} catch {
			continue;
		}
	}
	return [...unresolvedItems.values()].sort((a, b) => a.createdAt - b.createdAt);
}
