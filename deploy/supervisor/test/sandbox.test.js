import { describe, expect, it } from 'vitest';
import { appEnv, buildCommand, bwrapArgs, passwdFiles, userDirs, INNER } from '../sandbox.js';

const config = {
	sandbox: 'bwrap',
	appDir: '/app/current',
	appEntry: '/app/current/build/index.js',
	nodePath: '/usr/bin/node',
	dataDir: '/data',
	wsUrl: 'wss://app.example.org/ws',
	publicOrigin: 'https://app.example.org',
	bodySizeLimit: '50M',
	passthroughEnv: ['ANTHROPIC_API_KEY']
};
const user = { id: 'gh:1', login: 'alice', uid: 20001, appPort: 41000, wsPort: 41001 };
const host = {
	mergedUsr: { bin: true, lib: true, lib64: true, sbin: true },
	present: { lib64: true, sbin: true, etcSsl: true, etcCaCerts: false, localtime: true, ldCache: true, nsswitch: true, hosts: true, resolv: true },
	nodeReal: '/usr/local/n/versions/22/bin/node'
};

describe('sandbox command', () => {
	it('lays out per-user host directories and passwd entries', () => {
		expect(userDirs('/data', 20001)).toEqual({
			root: '/data/users/20001',
			workspace: '/data/users/20001/workspace',
			home: '/data/users/20001/home',
			etc: '/data/users/20001/etc'
		});
		expect(passwdFiles(20001).passwd).toContain(`user:x:20001:20001:DocWriter user:${INNER.home}:/bin/sh`);
	});

	it('builds the app env the CLI launcher would, with fixed inner paths', () => {
		const env = appEnv({ config, user, secret: 's', inner: true, dirs: userDirs('/data', 20001), passthrough: { ANTHROPIC_API_KEY: 'k', PATH: '/x', OTHER: 'no' } });
		expect(env).toMatchObject({
			DOCWRITER_ROOT: '/workspace',
			HOME: '/home/user',
			PORT: '41000',
			HOST: '127.0.0.1',
			DOCWRITER_WS_PORT: '41001',
			PUBLIC_DOCWRITER_WS_PORT: '41001',
			PUBLIC_DOCWRITER_WS_URL: 'wss://app.example.org/ws',
			ORIGIN: 'https://app.example.org',
			PROTOCOL_HEADER: 'x-forwarded-proto',
			HOST_HEADER: 'x-forwarded-host',
			DOCWRITER_GATEWAY_SECRET: 's',
			ANTHROPIC_API_KEY: 'k'
		});
		expect(env.OTHER).toBeUndefined();
		expect(env.PATH).toContain('/opt/docwriter');
	});

	it('confines the process to its own directories under bwrap', () => {
		const dirs = userDirs('/data', 20001);
		const env = appEnv({ config, user, secret: 's', inner: true, dirs, passthrough: {} });
		const args = bwrapArgs({ config, user, dirs, env, host });
		const joined = args.join(' ');
		for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session', '--clearenv']) {
			expect(args).toContain(flag);
		}
		expect(args).not.toContain('--unshare-net');
		expect(joined).toContain('--ro-bind /usr /usr');
		expect(joined).toContain('--symlink usr/bin /bin');
		expect(joined).toContain('--symlink usr/lib64 /lib64');
		expect(joined).toContain('--ro-bind /app/current /app');
		expect(joined).toContain('--bind /data/users/20001/workspace /workspace');
		expect(joined).toContain('--bind /data/users/20001/home /home/user');
		expect(joined).toContain('--ro-bind /data/users/20001/etc/passwd /etc/passwd');
		expect(joined).toContain(`--ro-bind /usr/local/n/versions/22/bin/node ${INNER.node}`);
		expect(joined).toContain('--ro-bind /etc/ssl /etc/ssl');
		expect(joined).not.toContain('/etc/ca-certificates');
		expect(joined).toContain('--setenv DOCWRITER_GATEWAY_SECRET s');
		expect(args.slice(-3)).toEqual(['--', INNER.node, '/app/build/index.js']);
		// Nothing binds another user's directory or the data root itself.
		expect(joined).not.toMatch(/--(ro-)?bind \/data\/users\/(?!20001\/)/);
		expect(joined).not.toContain('--bind /data /');
	});

	it('drops to the user uid under bwrap and stays unconfined under none', () => {
		const dirs = userDirs('/data', 20001);
		const b = buildCommand({ config, user, secret: 's', dirs, host, passthrough: { PATH: '/usr/bin' } });
		expect(b.cmd).toBe('bwrap');
		expect(b.uid).toBe(20001);
		expect(b.env).toEqual({ PATH: '/usr/bin' });
		const n = buildCommand({ config: { ...config, sandbox: 'none' }, user, secret: 's', dirs, host: null, passthrough: { PATH: '/usr/bin' } });
		expect(n).toMatchObject({ cmd: '/usr/bin/node', args: ['/app/current/build/index.js'], cwd: dirs.workspace, uid: undefined });
		expect(n.env.DOCWRITER_ROOT).toBe(dirs.workspace);
		expect(n.env.HOME).toBe(dirs.home);
	});
});
