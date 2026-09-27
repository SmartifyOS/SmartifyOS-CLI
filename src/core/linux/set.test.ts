import { describe, expect, test } from 'bun:test';
import type { AptNeed } from './collect.ts';
import { addNeeds, flutterToolchainNeeds, parseAptList, renderSet } from './set.ts';

const need = (name: string, who: string, arch: AptNeed['arch'] = null): AptNeed => ({
	package: name,
	arch,
	requesters: [{ name: who, title: who }],
});

describe('renderSet', () => {
	test('writes tab separated lists linux.sh can read', () => {
		const files = renderSet({
			name: 'smartify-os-run',
			description: 'SmartifyOS',
			apt: [need('bluez', 'SmartifyOS'), need('intel-media-va-driver', 'Android\tAuto', ['x64'])],
			udev: [
				{
					name: '70-smartify_os_x-x.rules',
					text: 'MODE="0660"\n',
					requester: { name: 'smartify_os_x', title: 'X' },
				},
			],
			groups: [{ group: 'plugdev', requesters: [{ name: 'a', title: 'A' }] }],
			flutterToolchain: false,
		});
		expect(files.get('set.conf')).toBe(
			'NAME=smartify-os-run\nDESCRIPTION=SmartifyOS\nFLUTTER_TOOLCHAIN=0\n',
		);
		const apt = files
			.get('apt.list')
			?.split('\n')
			.filter((line) => !line.startsWith('#'));
		// A tab in a title cannot break a line.
		expect(apt).toEqual(['bluez\t*\tSmartifyOS', 'intel-media-va-driver\tx64\tAndroid Auto', '']);
		expect(files.get('groups.list')).toContain('plugdev\tA');
		expect(files.get('udev.list')).toContain('70-smartify_os_x-x.rules\tX');
		expect(files.get('udev/70-smartify_os_x-x.rules')).toBe('MODE="0660"\n');
	});
});

describe('addNeeds', () => {
	test('merges who asked for a package asked for twice', () => {
		const merged = addNeeds(flutterToolchainNeeds(), [need('git', 'Dashcam'), need('zzz', 'X')]);
		const git = merged.find((n) => n.package === 'git');
		expect(git?.requesters.map((r) => r.title)).toEqual(['Flutter', 'Dashcam']);
		expect(merged.at(-1)?.package).toBe('zzz');
	});

	test('never changes the lists it was given', () => {
		const list = [need('git', 'A')];
		addNeeds(list, [need('git', 'B')]);
		expect(list[0]?.requesters).toHaveLength(1);
	});
});

describe('parseAptList', () => {
	test('reads what linux.sh libraries prints', () => {
		const needs = parseAptList(
			'libgtk-3-0t64\t*\tcar_app, libfoo_plugin.so\n# a comment\nNot Valid\t*\tx\n\n',
		);
		expect(needs).toEqual([
			{
				package: 'libgtk-3-0t64',
				arch: null,
				requesters: [
					{ name: 'car_app', title: 'car_app' },
					{ name: 'libfoo_plugin.so', title: 'libfoo_plugin.so' },
				],
			},
		]);
	});
});
