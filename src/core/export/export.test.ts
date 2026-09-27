import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeCar } from '../../../tests/fake-car.ts';
import { collectNeeds } from '../linux/collect.ts';
import { readCar } from '../project/car.ts';
import { binaryName } from './build.ts';
import { exportSets, readExistingExport, renderConf, writeExport } from './export.ts';
import { isSkipped } from './pack.ts';

const dir = await mkdtemp(join(tmpdir(), 'smartify-os-export-'));
const app = await fakeCar(dir);
// A newer package_config than pubspec.yaml, so reading the car never runs pub.
await Bun.write(
	join(app, '.dart_tool', 'package_config.json'),
	await Bun.file(join(app, '.dart_tool', 'package_config.json')).text(),
);

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function input(buildOn: 'car' | 'computer') {
	const state = await readCar({ kind: 'car', dir: app });
	const needs = await collectNeeds(app);
	return {
		kind: 'installer' as const,
		buildOn,
		state,
		needs,
		binary: 'car_app',
		flutter: { version: '3.41.1', channel: 'stable' },
		now: new Date('2026-09-27T12:00:00Z'),
	};
}

describe('exportSets', () => {
	test('a car that builds itself also gets what building needs, Flutter included', async () => {
		const sets = exportSets(await input('car'));
		expect(sets.map((set) => set.name)).toEqual(['smartify-os-run', 'smartify-os-build']);
		const build = sets[1]?.apt.map((need) => need.package) ?? [];
		expect(build).toContain('clang');
		expect(build).toContain('libusb-1.0-0-dev');
		expect(sets[1]?.flutterToolchain).toBe(true);
	});

	test('a car that gets a finished build gets only what it needs to run, libraries included', async () => {
		const sets = exportSets({
			...(await input('computer')),
			built: {
				bundle: '/nowhere',
				arch: 'x64',
				libraries: [
					{ package: 'libgtk-3-0t64', arch: null, requesters: [{ name: 'a', title: 'a' }] },
				],
			},
		});
		expect(sets.map((set) => set.name)).toEqual(['smartify-os-run']);
		expect(sets[0]?.apt.map((need) => need.package)).toContain('libgtk-3-0t64');
	});
});

describe('renderConf', () => {
	test('says what is on the stick, one KEY=value per line', async () => {
		const conf = renderConf(await input('car'));
		expect(conf).toContain('\nKIND=installer\n');
		expect(conf).toContain('\nBUILD_ON=car\n');
		expect(conf).toContain('\nPAYLOAD=source.tar.gz\n');
		expect(conf).toContain('\nAPP=car\n');
		expect(conf).toContain('\nAPP_VERSION=1.0.0\n');
		expect(conf).toContain('\nBINARY=car_app\n');
		expect(conf).toContain('\nFLUTTER_VERSION=3.41.1\n');
		expect(conf).toContain('\nARCH=\n');
		expect(conf).toContain('\nCREATED=2026-09-27T12:00:00.000Z\n');
	});
});

describe('isSkipped', () => {
	test('leaves out what a build or an editor made, and what only this computer uses', () => {
		expect(isSkipped(join(app, 'build'))).toBe(true);
		expect(isSkipped(join(app, 'lib', 'build'))).toBe(false);
		expect(isSkipped(join(app, '.dart_tool'))).toBe(true);
		expect(isSkipped(join(app, 'pubspec_overrides.yaml'))).toBe(true);
		expect(isSkipped(join(app, 'car.iml'))).toBe(true);
		expect(isSkipped(join(app, 'lib'))).toBe(false);
	});
});

describe('binaryName', () => {
	test('reads the program name out of linux/CMakeLists.txt', async () => {
		expect(await binaryName(app)).toBe('car_app');
		expect(await binaryName(dir)).toBeUndefined();
	});
});

describe('writeExport', () => {
	test('writes an installer for a car that builds itself', async () => {
		const stick = join(dir, 'stick');
		await mkdir(stick);
		const result = await writeExport(await input('car'), stick);

		expect(result.folder).toBe(join(stick, 'smartify-os'));
		expect(result.files).toEqual([
			'README.txt',
			'export.conf',
			'install.sh',
			'linux.sh',
			'packages/build/apt.list',
			'packages/build/groups.list',
			'packages/build/set.conf',
			'packages/build/udev.list',
			'packages/run/apt.list',
			'packages/run/groups.list',
			'packages/run/set.conf',
			'packages/run/udev.list',
			'packages/run/udev/70-smartify_os_dashcam-dashcam.rules',
			'source.tar.gz',
		]);
		// Nothing half written is left next to it.
		expect(await readdir(stick)).toEqual(['smartify-os']);

		const listed = Bun.spawnSync(['tar', '-tzf', join(result.folder, 'source.tar.gz')])
			.stdout.toString()
			.split('\n');
		expect(listed).toContain('app/lib/main.dart');
		expect(listed).toContain('app/lib/build/keep.dart');
		expect(listed.some((line) => line.startsWith('app/build/'))).toBe(false);
		expect(listed.some((line) => line.startsWith('app/.dart_tool'))).toBe(false);

		expect(await readExistingExport(stick)).toEqual({
			kind: 'installer',
			app: 'car',
			created: '2026-09-27T12:00:00.000Z',
		});
	});

	test('an update is the same without install.sh, and replaces what was there', async () => {
		const stick = join(dir, 'stick-update');
		await mkdir(stick);
		await writeExport(await input('car'), stick);
		const result = await writeExport({ ...(await input('car')), kind: 'update' }, stick);
		expect(result.files).not.toContain('install.sh');
		expect(await Bun.file(join(result.folder, 'install.sh')).exists()).toBe(false);
		expect((await readExistingExport(stick))?.kind).toBe('update');
	});

	test('there is nothing on a stick that never had an export', async () => {
		expect(await readExistingExport(dir)).toBeUndefined();
	});
});
