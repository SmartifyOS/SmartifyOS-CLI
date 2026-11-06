import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancelledError, CliError } from '../../utils/errors.ts';
import type { FlutterVersion } from '../flutter.ts';
import type { AptNeed, CarNeeds } from '../linux/collect.ts';
import { hostArch, type LinuxArch, officialLinux } from '../linux/distro.ts';
import { lastLines, type ProcessResult, run } from '../process.ts';
import type { CarState } from '../project/car.ts';
import { type BuildTools, parseLibraries, writeBuildTools } from './build.ts';
import { packSource } from './pack.ts';

/**
 * Building the car's app for Linux in a container of the official Linux, which is how any
 * computer, a Mac or Windows included, builds for a car.
 *
 * There is no image of SmartifyOS's own. A container of the plain official image is set up
 * with the same `linux.sh` a car that builds itself runs: `packages` for what building
 * needs, `flutter` for Flutter, `build` for the build. So a build in the container and a
 * build on the car are the same steps, and neither can drift from the other.
 *
 * The container is kept, stopped, between exports: Flutter, the pub cache and the build
 * folder stay in it, which makes every build after the first quick. There is one per
 * architecture, and one made from another image or an older Linux is replaced.
 */

/** Docker, or Podman, which takes the same commands. */
export type Engine = 'docker' | 'podman';

export type FindEngine =
	| { ok: true; engine: Engine }
	| {
			ok: false;
			reason: string;
			hint: string;
			/** What to do about it, said next to "On this computer" when asked where to build. */
			option: string;
	  };

/** The container engine to build with: one that is installed and running. */
export async function findEngine(): Promise<FindEngine> {
	let installed: Engine | undefined;
	for (const engine of ['docker', 'podman'] as const) {
		if (!Bun.which(engine)) continue;
		installed ??= engine;
		const info = await run(engine, ['info'], { timeoutMs: 20_000 });
		if (info.code === 0) return { ok: true, engine };
	}
	if (installed) {
		const name = installed === 'docker' ? 'Docker' : 'Podman';
		return {
			ok: false,
			reason: `${name} is installed, but not running, so this computer cannot build for a car right now.`,
			hint: `Start ${installed === 'docker' ? 'Docker Desktop' : 'Podman'}, then run this again.`,
			option: `${installed === 'docker' ? 'Docker Desktop' : 'Podman'} is not running yet. Start it, then pick this`,
		};
	}
	return {
		ok: false,
		reason: 'Building for a car on this computer needs Docker, which is not installed.',
		hint: 'Install Docker Desktop from https://docs.docker.com/get-docker/ and start it, then run this again.',
		option:
			'Needs Docker Desktop, from https://docs.docker.com/get-docker/. Install and start it, then pick this',
	};
}

/** The platform a container of an architecture runs as. */
export const platforms: Record<LinuxArch, string> = { x64: 'linux/amd64', arm64: 'linux/arm64' };

/** The name of the kept container for an architecture. */
export function containerName(arch: LinuxArch): string {
	return `smartify-os-builder-${arch}`;
}

/** The label saying which image a container was made from, so an old one is replaced. */
const imageLabel = 'smartify-os.image';

/** Where things are inside the container. */
const paths = {
	tools: '/work/tools',
	source: '/work/source.tar.gz',
	app: '/work/src/app',
	flutter: '/home/builder/flutter',
};

/** The user that builds, since Flutter warns against building as root. */
const user = 'builder';

/**
 * Internal: replaces the source in the container with the new one, keeping the app's
 * `build` and `.dart_tool`, so the build after it is incremental. Anything deleted on this
 * computer is deleted in there too. `work` is only ever not `/work` in a test.
 */
export function syncSource(work = '/work'): string {
	const incoming = `${work}/incoming`;
	const app = `${work}/src/app`;
	return `set -e
rm -rf ${incoming}
mkdir -p ${incoming} ${app}
tar -xzf ${work}/source.tar.gz -C ${incoming}
find ${work}/src -mindepth 1 -maxdepth 1 ! -name app -exec rm -rf {} +
find ${app} -mindepth 1 -maxdepth 1 ! -name build ! -name .dart_tool -exec rm -rf {} +
cp -a ${incoming}/app/. ${app}/
if [ -d ${incoming}/links ]; then cp -a ${incoming}/links ${work}/src/links; fi
rm -rf ${incoming} ${work}/source.tar.gz
`;
}

/** A step of a build in the container, for a spinner. */
export type ContainerStep =
	| 'container'
	| 'packages'
	| 'flutter'
	| 'copy'
	| 'build'
	/** The emulated build got stuck and is started again, see {@link findStuck}. */
	| 'rebuild'
	| 'libraries';

export interface ContainerBuild {
	/** The finished build, copied out to a temporary folder on this computer. */
	bundle: string;
	libraries: AptNeed[];
	/** Libraries the build links against that no package installed. */
	warnings: string[];
	/** Deletes the temporary folder. */
	remove(): Promise<void>;
}

/**
 * Builds the car's app in a container of the official Linux for the given architecture,
 * and copies the finished build out.
 *
 * @throws {CliError} naming the step that failed, with the end of what it printed.
 */
export async function buildInContainer(options: {
	engine: Engine;
	arch: LinuxArch;
	flutter: FlutterVersion;
	state: CarState;
	needs: CarNeeds;
	onStep?: (step: ContainerStep) => void;
}): Promise<ContainerBuild> {
	const { engine, arch, flutter, state, needs, onStep } = options;
	const name = containerName(arch);
	const engineRun = (args: string[]) => run(engine, args);
	const inside = (args: string[]) => run(engine, ['exec', name, ...args]);

	const tools = await writeBuildTools(needs);
	const out = await mkdtemp(join(tmpdir(), 'smartify-os-bundle-'));
	const remove = () => rm(out, { recursive: true, force: true });

	const stopped = stopWhenCancelled(engine, name);
	try {
		onStep?.('container');
		await startContainer(engine, name, arch);
		try {
			return await buildIn({ engineRun, inside, name, arch, flutter, state, tools, out, onStep });
		} finally {
			// Kept for next time, but not running when nobody builds.
			await engineRun(['stop', name]);
		}
	} catch (error) {
		await remove();
		throw stopped.cancelled ? new CancelledError() : error;
	} finally {
		stopped.dispose();
		await tools.remove();
	}
}

/**
 * Internal: stops the container when the CLI is stopped while it builds (Ctrl+C, or Cancel
 * in the editor). Stopping `docker exec` leaves what it started running inside, so the build
 * would go on with nobody waiting for it. Stopping the container makes the step that runs
 * fail, which is then reported as cancelled.
 */
function stopWhenCancelled(
	engine: Engine,
	name: string,
): { readonly cancelled: boolean; dispose(): void } {
	let cancelled = false;
	const stop = () => {
		if (cancelled) return;
		cancelled = true;
		Bun.spawnSync([engine, 'stop', '--time', '1', name], { stdout: 'ignore', stderr: 'ignore' });
		// Whatever was waiting on the container has ended by now. Should anything still hang,
		// the CLI goes anyway.
		setTimeout(() => process.exit(130), 15_000).unref();
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
	return {
		get cancelled() {
			return cancelled;
		},
		dispose() {
			process.off('SIGINT', stop);
			process.off('SIGTERM', stop);
		},
	};
}

async function buildIn(context: {
	engineRun: (args: string[]) => Promise<ProcessResult>;
	inside: (args: string[]) => Promise<ProcessResult>;
	name: string;
	arch: LinuxArch;
	flutter: FlutterVersion;
	state: CarState;
	tools: BuildTools;
	out: string;
	onStep?: (step: ContainerStep) => void;
}): Promise<ContainerBuild> {
	const { engineRun, inside, name, flutter, state, tools, out, onStep } = context;
	const linuxSh = (args: string[]) => inside(['bash', `${paths.tools}/linux.sh`, ...args]);

	await must(inside(['rm', '-rf', paths.tools]), 'The build container could not be set up.');
	await must(
		engineRun(['cp', `${tools.dir}/.`, `${name}:${paths.tools}`]),
		'The build container could not be set up.',
	);

	onStep?.('packages');
	await must(
		linuxSh(['packages', `${paths.tools}/build`]),
		'What building needs could not be installed in the build container.',
	);

	onStep?.('flutter');
	await must(
		linuxSh(['flutter', flutter.version, paths.flutter, '--user', user]),
		`Flutter ${flutter.version} could not be installed in the build container.`,
	);

	onStep?.('copy');
	const packed = join(out, 'source.tar.gz');
	await packSource(state.app.dir, state.pubspecText, state.links, packed);
	await must(
		engineRun(['cp', packed, `${name}:${paths.source}`]),
		"Your car's app could not be copied in.",
	);
	await rm(packed, { force: true });
	await must(
		inside(['bash', '-c', `${syncSource()}chown -R ${user}:${user} /work/src\n`]),
		"Your car's app could not be copied in.",
	);

	onStep?.('build');
	const build = () => linuxSh(['build', paths.app, '--flutter', paths.flutter, '--user', user]);
	let result = await watched(build, context);
	for (let again = 0; result.stuck && again < 2; again++) {
		onStep?.('rebuild');
		result = await watched(build, context);
	}
	const built = await must(Promise.resolve(result), 'SmartifyOS did not build.', 40, (output) =>
		context.arch === hostArch()
			? afterPub(output)
			: `${afterPub(output)}\n\nBuilding for ${context.arch} cars runs emulated on this computer, which now and then fails for reasons that have nothing to do with your app. Try once more, or pick On the car when asked where to build.`,
	);
	const bundle = built.stdout.trim().split('\n').pop() ?? '';

	onStep?.('libraries');
	const libraries = await must(
		linuxSh(['libraries', bundle]),
		'Could not read which libraries the build links against.',
	);
	await must(
		engineRun(['cp', `${name}:${bundle}`, out]),
		'The finished build could not be copied out.',
	);

	return {
		bundle: join(out, 'bundle'),
		...parseLibraries(libraries),
		remove: () => rm(out, { recursive: true, force: true }),
	};
}

/**
 * Internal: runs the build, and when it is emulated, looks into the container every so often
 * for a program stuck waiting on one it started that has long ended (a zombie left unreaped).
 * That happens now and then to CMake under Rosetta, which then waits forever: the end of its
 * child never reaches it. The stuck program is killed, which fails the build with `stuck` set,
 * so it can be started again. The build folder stays, so that goes on where it stopped.
 */
async function watched(
	build: () => Promise<ProcessResult>,
	context: { inside: (args: string[]) => Promise<ProcessResult>; arch: LinuxArch },
): Promise<ProcessResult & { stuck: boolean }> {
	const { inside, arch } = context;
	const zombies = new Zombies();
	let stuck = false;
	let looking = false;
	const timer =
		arch === hostArch()
			? undefined
			: setInterval(async () => {
					if (looking || stuck) return;
					looking = true;
					try {
						const ps = await inside(['ps', '-eo', 'pid=,ppid=,stat=']);
						const waiting = ps.code === 0 ? zombies.see(ps.stdout, Date.now()) : undefined;
						if (waiting !== undefined) {
							stuck = true;
							await inside(['kill', '-9', String(waiting)]);
						}
					} finally {
						looking = false;
					}
				}, 15_000);
	try {
		const result = await build();
		// The Dart runtime gives up when emulation interrupts a call it expects not to be, which
		// is as much luck as the CMake hang, and a build started again usually gets through.
		const crashed =
			timer !== undefined && /Unexpected EINTR errno/.test(result.stdout + result.stderr);
		return { ...result, stuck: (stuck || crashed) && result.code !== 0 };
	} finally {
		if (timer) clearInterval(timer);
	}
}

/**
 * Internal: the zombies in the container, and since when each has been one. A process that
 * just ended is a zombie only until its parent notices, a moment, so one that is still there
 * a minute later has a parent that is stuck. How old the process is says nothing about that,
 * a compiler that ran for minutes is just as briefly a zombie.
 */
export class Zombies {
	private readonly since = new Map<string, number>();

	constructor(private readonly minMs = 60_000) {}

	/**
	 * Takes `ps -eo pid=,ppid=,stat=` at `now`, and returns the parent of a zombie that has
	 * been one since at least a minute ago. Init (pid 1) reaps by itself, and is left out.
	 */
	see(ps: string, now: number): number | undefined {
		const processes = ps
			.trim()
			.split('\n')
			.map((line) => line.trim().split(/\s+/))
			.map(([pid, ppid, stat]) => ({ pid, ppid: Number(ppid), stat: stat ?? '' }));
		const alive = new Set(
			processes.filter((p) => !p.stat.startsWith('Z')).map((p) => Number(p.pid)),
		);
		const zombies = processes.filter(
			(p) => p.stat.startsWith('Z') && p.ppid > 1 && alive.has(p.ppid),
		);

		const current = new Set(zombies.map((p) => `${p.pid}:${p.ppid}`));
		for (const key of this.since.keys()) if (!current.has(key)) this.since.delete(key);
		for (const key of current) if (!this.since.has(key)) this.since.set(key, now);

		const stuck = zombies.find(
			(p) => now - (this.since.get(`${p.pid}:${p.ppid}`) ?? now) >= this.minMs,
		);
		return stuck?.ppid;
	}
}

/**
 * Internal: what a failed `flutter build` printed from where it started building. Before
 * that comes fetching the packages, which lists every one of them with its newer versions,
 * and would push why it failed out of the lines that are shown.
 */
export function afterPub(output: string): string {
	const start = output.lastIndexOf('Building Linux application');
	return start === -1 ? output : output.slice(start);
}

/**
 * Internal: starts the kept container for an architecture, making it first when there is
 * none, or when the one there was made from another image.
 */
async function startContainer(engine: Engine, name: string, arch: LinuxArch): Promise<void> {
	const image = officialLinux.image;
	const inspected = await run(engine, [
		'container',
		'inspect',
		'--format',
		`{{index .Config.Labels "${imageLabel}"}}`,
		name,
	]);
	const exists = inspected.code === 0;
	if (exists && inspected.stdout.trim() !== image) await run(engine, ['rm', '-f', name]);

	if (!exists || inspected.stdout.trim() !== image) {
		await must(
			run(engine, [
				'run',
				'--detach',
				'--init',
				'--name',
				name,
				'--platform',
				platforms[arch],
				'--label',
				`${imageLabel}=${image}`,
				image,
				'sleep',
				'infinity',
			]),
			`A ${officialLinux.name} container for ${arch} cars could not be started.`,
		);
		await must(
			run(engine, [
				'exec',
				name,
				'bash',
				'-c',
				`id ${user} >/dev/null 2>&1 || useradd --create-home ${user}; mkdir -p /work/src; chown -R ${user}:${user} /work`,
			]),
			'The build container could not be set up.',
		);
		return;
	}

	await must(run(engine, ['start', name]), 'The build container could not be started.');
}

/**
 * Internal: fails with the end of what a command printed, which is where it says why. A
 * program that cannot even start there is a machine that cannot run the architecture.
 */
async function must(
	running: Promise<ProcessResult>,
	message: string,
	lines = 20,
	shown: (output: string) => string = (output) => output,
): Promise<ProcessResult> {
	const result = await running;
	if (result.code === 0) return result;
	const output = shown(`${result.stdout}\n${result.stderr}`);
	const hint = /exec format error/i.test(output)
		? 'This computer cannot run programs for that architecture. Docker Desktop can, on Linux install qemu-user-static and binfmt-support.'
		: lastLines(output, lines);
	throw new CliError(message, { hint });
}
