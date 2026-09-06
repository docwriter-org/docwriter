/**
 * Builds the command that runs one user's DocWriter process.
 *
 * `bwrap` mode confines the whole process (Node, the Hocuspocus server, the
 * agent subprocess, hooks, synctex) to the user's own directories with a
 * fresh mount, pid, ipc and uts namespace. The network namespace is shared:
 * the process must reach the model API and the supervisor must reach its
 * ports. Cross-user port access is stopped by the gateway secret instead
 * (see src/lib/server/gateway.ts).
 *
 * `none` mode runs the same entry point unconfined, for laptops and tests.
 *
 * Everything here is a pure function of its inputs so the argument list can
 * be unit tested without a Linux box.
 */
import { join } from 'node:path';

/** Paths inside the sandbox. Fixed so the app never sees a uid in a path. */
export const INNER = {
	app: '/app',
	workspace: '/workspace',
	home: '/home/user',
	node: '/opt/docwriter/node'
};

/** Host-side directories for one user. */
export function userDirs(dataDir, uid) {
	const root = join(dataDir, 'users', String(uid));
	return {
		root,
		workspace: join(root, 'workspace'),
		home: join(root, 'home'),
		etc: join(root, 'etc')
	};
}

/** Contents of the sandbox's /etc/passwd and /etc/group for uid `uid`. */
export function passwdFiles(uid) {
	return {
		passwd: `root:x:0:0:root:/root:/usr/sbin/nologin\nuser:x:${uid}:${uid}:DocWriter user:${INNER.home}:/bin/sh\n`,
		group: `root:x:0:\nuser:x:${uid}:\n`
	};
}

/**
 * Environment for the app process. `inner` says whether paths are the
 * sandbox's fixed ones (bwrap) or the host's real ones (none).
 */
export function appEnv({ config, user, secret, inner, dirs, passthrough = process.env }) {
	const env = {
		NODE_ENV: 'production',
		PATH: inner ? '/opt/docwriter:/usr/local/bin:/usr/bin:/bin' : passthrough.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: inner ? INNER.home : dirs.home,
		DOCWRITER_ROOT: inner ? INNER.workspace : dirs.workspace,
		PORT: String(user.appPort),
		HOST: '127.0.0.1',
		DOCWRITER_WS_PORT: String(user.wsPort),
		PUBLIC_DOCWRITER_WS_PORT: String(user.wsPort),
		PUBLIC_DOCWRITER_WS_URL: config.wsUrl,
		ORIGIN: config.publicOrigin,
		PROTOCOL_HEADER: 'x-forwarded-proto',
		HOST_HEADER: 'x-forwarded-host',
		BODY_SIZE_LIMIT: config.bodySizeLimit,
		DOCWRITER_GATEWAY_SECRET: secret
	};
	for (const name of config.passthroughEnv) {
		if (passthrough[name] !== undefined && passthrough[name] !== '') env[name] = passthrough[name];
	}
	return env;
}

/**
 * Host filesystem facts the bwrap argument list depends on. Read once at
 * boot with `probeHost()`; passed explicitly so tests can fake them.
 */
export function probeHost({ lstatSync, existsSync, realpathSync } , nodePath) {
	const symlinked = (p) => {
		try {
			return lstatSync(p).isSymbolicLink();
		} catch {
			return false;
		}
	};
	const exists = (p) => existsSync(p);
	return {
		mergedUsr: {
			bin: symlinked('/bin'),
			lib: symlinked('/lib'),
			lib64: symlinked('/lib64'),
			sbin: symlinked('/sbin')
		},
		present: {
			lib64: exists('/lib64'),
			sbin: exists('/sbin'),
			etcSsl: exists('/etc/ssl'),
			etcCaCerts: exists('/etc/ca-certificates'),
			localtime: exists('/etc/localtime'),
			ldCache: exists('/etc/ld.so.cache'),
			nsswitch: exists('/etc/nsswitch.conf'),
			hosts: exists('/etc/hosts'),
			resolv: exists('/etc/resolv.conf')
		},
		nodeReal: realpathSync(nodePath)
	};
}

/** The bwrap argument list (without the leading `bwrap`). */
export function bwrapArgs({ config, user, dirs, env, host }) {
	const args = [
		'--unshare-user',
		'--unshare-pid',
		'--unshare-ipc',
		'--unshare-uts',
		'--unshare-cgroup-try',
		'--die-with-parent',
		'--new-session',
		'--hostname', 'docwriter',
		'--ro-bind', '/usr', '/usr'
	];
	// Merged-/usr distros (Ubuntu, Fedora, Arch) have /bin etc. as symlinks;
	// recreate them as symlinks so paths resolve identically inside.
	for (const [name, key] of [['bin', 'bin'], ['lib', 'lib'], ['lib64', 'lib64'], ['sbin', 'sbin']]) {
		if (key !== 'bin' && key !== 'lib' && !host.present[key]) continue;
		if (host.mergedUsr[key]) args.push('--symlink', `usr/${name}`, `/${name}`);
		else args.push('--ro-bind', `/${name}`, `/${name}`);
	}
	const etcFiles = [
		['resolv', '/etc/resolv.conf'],
		['hosts', '/etc/hosts'],
		['nsswitch', '/etc/nsswitch.conf'],
		['ldCache', '/etc/ld.so.cache'],
		['localtime', '/etc/localtime'],
		['etcSsl', '/etc/ssl'],
		['etcCaCerts', '/etc/ca-certificates']
	];
	for (const [key, path] of etcFiles) {
		if (host.present[key]) args.push('--ro-bind', path, path);
	}
	args.push(
		'--ro-bind', join(dirs.etc, 'passwd'), '/etc/passwd',
		'--ro-bind', join(dirs.etc, 'group'), '/etc/group',
		'--ro-bind', host.nodeReal, INNER.node,
		'--ro-bind', config.appDir, INNER.app,
		'--bind', dirs.workspace, INNER.workspace,
		'--bind', dirs.home, INNER.home,
		'--dev', '/dev',
		'--proc', '/proc',
		'--tmpfs', '/tmp',
		'--chdir', INNER.workspace,
		'--clearenv'
	);
	for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
	args.push('--', INNER.node, config.appEntry.replace(config.appDir, INNER.app));
	return args;
}

/**
 * The full spawn spec: command, args, env for the *outer* process, and the
 * uid/gid the supervisor should drop to before exec.
 */
export function buildCommand({ config, user, secret, dirs, host, passthrough = process.env }) {
	if (config.sandbox === 'none') {
		return {
			cmd: config.nodePath,
			args: [config.appEntry],
			env: appEnv({ config, user, secret, inner: false, dirs, passthrough }),
			cwd: dirs.workspace,
			uid: undefined,
			gid: undefined
		};
	}
	const env = appEnv({ config, user, secret, inner: true, dirs, passthrough });
	return {
		cmd: 'bwrap',
		args: bwrapArgs({ config, user, dirs, env, host }),
		// bwrap itself only needs a PATH; the sandbox env is set via --setenv.
		env: { PATH: passthrough.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
		cwd: dirs.root,
		uid: user.uid,
		gid: user.uid
	};
}
