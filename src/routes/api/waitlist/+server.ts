import type { RequestHandler } from '@sveltejs/kit';

const IS_VERCEL = process.env.VERCEL === '1';

/**
 * Minimal waitlist endpoint. On Vercel (no persistent SQLite), stores
 * emails in a module-scope Set for the lifetime of the serverless
 * function invocation and logs them so they appear in Vercel Logs.
 *
 * Locally, uses the existing SQLite `kv` table.
 */
const inMemoryEmails = new Set<string>();

function isValidEmail(email: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export const POST: RequestHandler = async ({ request }) => {
	let body: { email?: string };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const email = body.email?.trim().toLowerCase();
	if (!email || !isValidEmail(email)) {
		return Response.json({ error: 'A valid email is required.' }, { status: 400 });
	}

	if (IS_VERCEL) {
		// Vercel: log for now; a proper store (e.g. KV, Turso) can be wired later.
		if (inMemoryEmails.has(email)) {
			return Response.json({ ok: true, message: 'Already on the list.' });
		}
		inMemoryEmails.add(email);
		console.log(`[waitlist] ${email}`);
		return Response.json({ ok: true });
	}

	// Local: persist to SQLite kv table.
	try {
		const { getDb } = await import('$lib/server/db');
		const db = getDb();
		const key = `waitlist:${email}`;
		const existing = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
		if (existing) {
			return Response.json({ ok: true, message: 'Already on the list.' });
		}
		db.prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run(key, new Date().toISOString());
		console.log(`[waitlist] ${email}`);
		return Response.json({ ok: true });
	} catch {
		// DB not available (fresh workspace) — fall back to in-memory.
		inMemoryEmails.add(email);
		console.log(`[waitlist] ${email}`);
		return Response.json({ ok: true });
	}
};
