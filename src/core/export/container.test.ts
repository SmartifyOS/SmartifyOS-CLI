import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerName, platforms, syncSource } from './container.ts';

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
