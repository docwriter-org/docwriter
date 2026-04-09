import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { DocumentOp } from '$lib/types';
import { appendDocumentOps, getUnresolvedDocumentOps, resolveDocumentOps, compactLog } from '$lib/server/document-op-log';

export const GET: RequestHandler = async () => {
	try {
		return json({ ops: getUnresolvedDocumentOps() });
	} catch (error) {
		return json({ error: String(error), ops: [] }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const ops = ((body.ops || []) as DocumentOp[]).filter((op) => op?.id && op?.type && op?.createdAt);
		appendDocumentOps(ops);
		return json({ ok: true, count: ops.length });
	} catch (error) {
		return json({ error: String(error) }, { status: 500 });
	}
};

export const PATCH: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const ids = ((body.ids || []) as string[]).filter((id) => typeof id === 'string' && id.length > 0);
		resolveDocumentOps(ids);
		// Compact WAL after resolving to prevent unbounded growth
		compactLog();
		return json({ ok: true, count: ids.length });
	} catch (error) {
		return json({ error: String(error) }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async () => {
	try {
		const ids = getUnresolvedDocumentOps().map((op) => op.id);
		resolveDocumentOps(ids);
		return json({ ok: true, count: ids.length });
	} catch (error) {
		return json({ error: String(error) }, { status: 500 });
	}
};
