import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeCar } from '../../../tests/fake-car.ts';
import { appTitle, checkPackage, collectNeeds, forArch, mergeNeeds } from './collect.ts';
import { emptyLists } from './lists.ts';

const dir = await mkdtemp(join(tmpdir(), 'smartify-os-collect-'));
const app = await fakeCar(dir);

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('collectNeeds', () => {
	test('merges every package, keeping who asked for what', async () => {
		const needs = await collectNeeds(app);
		expect(needs.build.map((need) => need.package)).toEqual([
			'libgstreamer1.0-dev',
			'libusb-1.0-0-dev',
		]);
		expect(
			needs.run.map((need) => [need.package, need.arch, need.requesters.map((r) => r.title)]),
		).toEqual([
			['bluez', null, ['SmartifyOS', 'Dashcam']],
			['can-utils', null, [appTitle]],
			['gstreamer1.0-plugins-good', null, ['SmartifyOS']],
			['intel-media-va-driver', ['x64'], ['Dashcam']],
		]);
		expect(needs.groups).toEqual([
			{ group: 'plugdev', requesters: [{ name: 'smartify_os_dashcam', title: 'Dashcam' }] },
		]);
	});

	test('installs rules under a name no other package can take, refusing ones that run things', async () => {
		const needs = await collectNeeds(app);
		expect(needs.udev.map((rule) => rule.name)).toEqual(['70-smartify_os_dashcam-dashcam.rules']);
		expect(needs.udev[0]?.text).toContain('GROUP="plugdev"');
	});

	test('reports every problem with the package it is in', async () => {
		const needs = await collectNeeds(app);
		expect(needs.problems.map((p) => [p.requester.title, p.kind, p.path])).toEqual([
			['Dashcam', 'unknown', 'smartify_os.linux.run.systemd'],
			['Dashcam', 'invalid', 'smartify_os.linux.run.apt[2]'],
			['Dashcam', 'invalid', 'smartify_os.linux.run.groups[1]'],
			['Dashcam', 'invalid', 'smartify_os.linux.run.udev[1]'],
		]);
	});
});

describe('checkPackage', () => {
	test('finds the same mistakes a car would skip', async () => {
		const problems = await checkPackage(join(dir, 'smartify_os_dashcam'), 'smartify_os_dashcam');
		expect(problems.filter((p) => p.kind === 'invalid')).toHaveLength(3);
		expect(await checkPackage(join(dir, 'plain'), 'plain')).toEqual([]);
	});
});

describe('mergeNeeds', () => {
	const requester = (name: string) => ({ name, title: name });
	const lists = (run: { package: string; arch: ('x64' | 'arm64')[] | undefined }[]) => ({
		...emptyLists(),
		run,
	});

	test('anyone asking on every architecture means every architecture', () => {
		const needs = mergeNeeds([
			{
				requester: requester('a'),
				lists: lists([{ package: 'x', arch: ['x64'] }]),
				rules: [],
				problems: [],
			},
			{
				requester: requester('b'),
				lists: lists([{ package: 'x', arch: undefined }]),
				rules: [],
				problems: [],
			},
		]);
		expect(needs.run[0]?.arch).toBeNull();
	});

	test('architectures add up', () => {
		const needs = mergeNeeds([
			{
				requester: requester('a'),
				lists: lists([{ package: 'x', arch: ['x64'] }]),
				rules: [],
				problems: [],
			},
			{
				requester: requester('b'),
				lists: lists([{ package: 'x', arch: ['arm64'] }]),
				rules: [],
				problems: [],
			},
		]);
		expect(needs.run[0]?.arch).toEqual(['arm64', 'x64']);
		expect(forArch(needs.run, 'x64')).toHaveLength(1);
	});

	test('forArch drops what another architecture needs', () => {
		const needs = mergeNeeds([
			{
				requester: requester('a'),
				lists: lists([{ package: 'x', arch: ['x64'] }]),
				rules: [],
				problems: [],
			},
		]);
		expect(forArch(needs.run, 'arm64')).toEqual([]);
	});
});
