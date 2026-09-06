/** The few HTML pages the supervisor serves itself. */

function page(title, body, { refresh } = {}) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<style>
body{font:16px/1.5 Inter,system-ui,sans-serif;color:#222;background:#faf9f7;margin:0;display:grid;place-items:center;min-height:100vh}
main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.25rem 0;color:#555}
a.btn{display:inline-block;margin-top:1rem;padding:.6rem 1rem;background:#222;color:#fff;border-radius:.4rem;text-decoration:none}
form{margin-top:1rem}input{font:inherit;padding:.5rem;border:1px solid #ccc;border-radius:.3rem}
</style></head><body><main>${body}</main></body></html>`;
}

export function escape(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const startingPage = () =>
	page('Starting your workspace', `<h1>Starting your workspace…</h1><p>This takes a few seconds the first time.</p>`, {
		refresh: 3
	});

export const restartingPage = () =>
	page('Restarting', `<h1>Your workspace is restarting</h1><p>It stopped a moment ago. Trying again shortly.</p>`, {
		refresh: 5
	});

export const capacityPage = () =>
	page('Busy', `<h1>DocWriter is at capacity</h1><p>Every slot is in use right now. This page retries by itself.</p>`, {
		refresh: 15
	});

export const failedPage = (reason) =>
	page('Could not start', `<h1>Your workspace could not start</h1><p>${escape(reason)}</p><a class="btn" href="/">Try again</a>`);

export const signInPage = ({ mode }) =>
	mode === 'github'
		? page('Sign in', `<h1>DocWriter</h1><p>Sign in to open your workspace.</p><a class="btn" href="/auth/login">Continue with GitHub</a>`)
		: page(
				'Sign in (dev)',
				`<h1>DocWriter (dev auth)</h1><p>Any name works. No real authentication.</p>
<form method="get" action="/auth/login"><input name="user" placeholder="alice" autofocus> <button>Open</button></form>`
			);

export const notAllowedPage = (login) =>
	page('Not invited', `<h1>Not on the list</h1><p>${escape(login)} is not invited to this DocWriter yet.</p><a class="btn" href="/auth/logout">Sign out</a>`);
