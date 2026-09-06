/** One JSON object per line on stdout; journald keeps them greppable by user. */
export function log(level, msg, fields = {}) {
	const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
	if (level === 'error') process.stderr.write(line + '\n');
	else process.stdout.write(line + '\n');
}
export const info = (msg, f) => log('info', msg, f);
export const warn = (msg, f) => log('warn', msg, f);
export const error = (msg, f) => log('error', msg, f);
