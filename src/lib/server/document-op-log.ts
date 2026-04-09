import { appendFileSync, existsSync, readFileSync } from 'fs';
import type { DocumentOp } from '$lib/types';
import { OPS_FILE } from './document-files';

interface EnqueueDocumentOpEvent {
	event: 'enqueue_document_op';
	op: DocumentOp;
}

interface ResolveDocumentOpsEvent {
	event: 'resolve_document_ops';
	ids: string[];
	resolvedAt: number;
}

type DocumentOpLogEvent = EnqueueDocumentOpEvent | ResolveDocumentOpsEvent;

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

function appendLogEvent(event: DocumentOpLogEvent) {
	appendFileSync(OPS_FILE, `${JSON.stringify(event)}\n`);
}

export function appendDocumentOps(ops: DocumentOp[]) {
	for (const op of ops) {
		appendLogEvent({ event: 'enqueue_document_op', op });
	}
}

export function resolveDocumentOps(ids: string[]) {
	if (ids.length === 0) return;
	appendLogEvent({
		event: 'resolve_document_ops',
		ids,
		resolvedAt: Date.now()
	});
}

export function getUnresolvedDocumentOps(): DocumentOp[] {
	const unresolvedOps = new Map<string, DocumentOp>();
	for (const line of readLogLines()) {
		try {
			const event = JSON.parse(line) as DocumentOpLogEvent;
			if (event.event === 'enqueue_document_op') {
				unresolvedOps.set(event.op.id, event.op);
				continue;
			}
			if (event.event === 'resolve_document_ops') {
				for (const id of event.ids) unresolvedOps.delete(id);
			}
		} catch {
			continue;
		}
	}
	return [...unresolvedOps.values()].sort((a, b) => a.createdAt - b.createdAt);
}
