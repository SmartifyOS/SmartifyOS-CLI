import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterPub, containerName, platforms, syncSource, Zombies } from './container.ts';

const work = await mkdtemp(join(tmpdir(), 'smartify-os-container-'));

afterAll(async () => {
	await rm(work, { recursive: true, force: true });
});

/** Packs a source the way packSource lays it out, into `source.tar.gz` in `work`. */
async function source(files: Record<string, string>): Promise<void> {
	const staging = join(work, 'staging');
	await rm(staging, { recursive: true, force: true });
	for (const [path, text] of Object.entries(files)) await Bun.write(join(staging, path), text);
	const top = Object.keys(files).some((path) => path.startsWith('links/'))
		? ['app', 'links']
		: ['app'];
	Bun.spawnSync(['tar', '-czf', join(work, 'source.tar.gz'), '-C', staging, ...top]);
	await rm(staging, { recursive: true, force: true });
}

function sync(): void {
	const result = Bun.spawnSync(['bash', '-c', syncSource(work)]);
	expect(result.stderr.toString()).toBe('');
	expect(result.exitCode).toBe(0);
}

describe('syncSource', () => {
	test('keeps the build between exports, and drops what was deleted', async () => {
		await source({
			'app/lib/main.dart': 'a',
			'app/lib/old.dart': 'old',
			'links/x/pubspec.yaml': 'x',
		});
		sync();
		await Bun.write(join(work, 'src/app/build/linux/cache'), 'kept');
		await Bun.write(join(work, 'src/app/.dart_tool/package_config.json'), 'kept');

		await source({ 'app/lib/main.dart': 'b' });
		sync();

		expect(await Bun.file(join(work, 'src/app/lib/main.dart')).text()).toBe('b');
		expect(await Bun.file(join(work, 'src/app/lib/old.dart')).exists()).toBe(false);
		expect(await Bun.file(join(work, 'src/app/build/linux/cache')).text()).toBe('kept');
		expect(await Bun.file(join(work, 'src/app/.dart_tool/package_config.json')).exists()).toBe(
			true,
		);
		// Nothing is linked any more, so the old copy goes.
		expect(await readdir(join(work, 'src'))).toEqual(['app']);
		expect(await Bun.file(join(work, 'source.tar.gz')).exists()).toBe(false);
	});
});

describe('containers', () => {
	test('one per architecture, on its own platform', () => {
		expect(containerName('arm64')).toBe('smartify-os-builder-arm64');
		expect(platforms).toEqual({ x64: 'linux/amd64', arm64: 'linux/arm64' });
	});
});

describe('Zombies', () => {
	// What ps showed while CMake hung under Rosetta: pkg-config ended, CMake never noticed.
	const hung = ['    1     0 Ss', '  502     1 Sl', '  532   502 S', '  841   532 Z'].join('\n');

	test('finds the parent of a zombie that stays one for a minute', () => {
		const zombies = new Zombies();
		expect(zombies.see(hung, 0)).toBeUndefined();
		expect(zombies.see(hung, 30_000)).toBeUndefined();
		expect(zombies.see(hung, 60_000)).toBe(532);
	});

	test('leaves alone zombies that come and go, however old the process was', () => {
		const zombies = new Zombies();
		expect(zombies.see(hung, 0)).toBeUndefined();
		expect(zombies.see(hung.replace(' Z', ' S'), 30_000)).toBeUndefined();
		expect(zombies.see(hung, 60_000)).toBeUndefined();
		// Another child of the same parent is another zombie.
		expect(zombies.see(hung.replace('841', '842'), 90_000)).toBeUndefined();
	});

	test('leaves alone what init reaps, and a zombie whose parent is gone', () => {
		const zombies = new Zombies();
		const orphans = '    1     0 Ss\n   12     1 Z\n   20   999 Z';
		zombies.see(orphans, 0);
		expect(zombies.see(orphans, 120_000)).toBeUndefined();
	});
});

describe('afterPub', () => {
	test('leaves out fetching the packages', () => {
		const output =
			'Resolving dependencies...\n  riverpod 3.2.1 (3.5.0 available)\nGot dependencies!\nBuilding Linux application...\nUnable to generate build files';
		expect(afterPub(output)).toBe('Building Linux application...\nUnable to generate build files');
	});

	test('keeps everything when it never got to building', () => {
		expect(afterPub('Git error.\nexit code: 128')).toBe('Git error.\nexit code: 128');
	});
});
