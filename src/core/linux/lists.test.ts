import { describe, expect, test } from 'bun:test';
import {
	checkUdevPath,
	checkUdevRule,
	emptyLists,
	installedRuleName,
	parseLists,
} from './lists.ts';

/** The example from EXTENSIONS.md, which is what authors copy. */
const documented = Bun.YAML.parse(`
smartify_os:
  linux:
    build:
      apt:
        - libusb-1.0-0-dev
    run:
      apt:
        - iw
        - package: intel-media-va-driver
          arch: [x64]
      udev:
        - system/udev/70-dashcam.rules
      groups:
        - plugdev
`) as { smartify_os: unknown };

describe('parseLists', () => {
	test('reads the documented example', () => {
		const { lists, problems } = parseLists(documented.smartify_os);
		expect(problems).toEqual([]);
		expect(lists).toEqual({
			build: [{ package: 'libusb-1.0-0-dev', arch: undefined }],
			run: [
				{ package: 'iw', arch: undefined },
				{ package: 'intel-media-va-driver', arch: ['x64'] },
			],
			udev: ['system/udev/70-dashcam.rules'],
			groups: ['plugdev'],
		});
	});

	test('nothing listed means nothing needed', () => {
		expect(parseLists(undefined)).toEqual({ lists: emptyLists(), problems: [] });
		expect(parseLists(null)).toEqual({ lists: emptyLists(), problems: [] });
		expect(parseLists({ linux: { run: { apt: null } } }).problems).toEqual([]);
	});

	test('takes a single arch without the brackets', () => {
		const { lists, problems } = parseLists({
			linux: { run: { apt: [{ package: 'intel-media-va-driver', arch: 'x64' }] } },
		});
		expect(problems).toEqual([]);
		expect(lists.run).toEqual([{ package: 'intel-media-va-driver', arch: ['x64'] }]);
	});

	test('leaves out a broken entry and keeps the rest', () => {
		const { lists, problems } = parseLists({
			linux: {
				run: {
					apt: ['iw', 'Not A Package', 'foo=1.2', 42, { package: 'x', arch: ['armhf'] }, 'bluez'],
				},
			},
		});
		expect(lists.run.map((entry) => entry.package)).toEqual(['iw', 'bluez']);
		expect(problems.map((problem) => problem.path)).toEqual([
			'smartify_os.linux.run.apt[1]',
			'smartify_os.linux.run.apt[2]',
			'smartify_os.linux.run.apt[3]',
			'smartify_os.linux.run.apt[4].arch',
		]);
		expect(problems.every((problem) => problem.kind === 'invalid')).toBe(true);
	});

	test('refuses groups that are root in disguise', () => {
		const { lists, problems } = parseLists({
			linux: { run: { groups: ['plugdev', 'sudo', 'docker', 'dialout'] } },
		});
		expect(lists.groups).toEqual(['plugdev', 'dialout']);
		expect(problems).toHaveLength(2);
		expect(problems[0]?.message).toContain('sudo');
	});

	test('refuses udev paths outside the package or named wrong', () => {
		const { lists, problems } = parseLists({
			linux: {
				run: {
					udev: [
						'system/udev/70-ok.rules',
						'../other/70-x.rules',
						'/etc/udev/rules.d/70-x.rules',
						'system/udev/dashcam.rules',
					],
				},
			},
		});
		expect(lists.udev).toEqual(['system/udev/70-ok.rules']);
		expect(problems).toHaveLength(3);
	});

	test('reports keys it does not know as unknown, not as mistakes', () => {
		const { lists, problems } = parseLists({
			linux: { run: { apt: ['iw'], systemd: ['x.service'] }, pipewire: {} },
			android: {},
		});
		expect(lists.run).toEqual([{ package: 'iw', arch: undefined }]);
		expect(problems.map((problem) => [problem.kind, problem.path])).toEqual([
			['unknown', 'smartify_os.android'],
			['unknown', 'smartify_os.linux.pipewire'],
			['unknown', 'smartify_os.linux.run.systemd'],
		]);
	});

	test('a list that is not a list is a mistake', () => {
		const { problems } = parseLists({ linux: { build: { apt: 'libusb-1.0-0-dev' } } });
		expect(problems).toEqual([
			{
				kind: 'invalid',
				path: 'smartify_os.linux.build.apt',
				message: 'smartify_os.linux.build.apt has to be a list of package names.',
			},
		]);
	});
});

describe('checkUdevPath', () => {
	test('takes a numbered rule file inside the package', () => {
		expect(checkUdevPath('system/udev/70-android-auto.rules')).toBeUndefined();
		expect(checkUdevPath('99-x.rules')).toBeUndefined();
	});

	test('refuses anything else', () => {
		expect(checkUdevPath('system/../../70-x.rules')).toContain('outside');
		expect(checkUdevPath('C:\\rules\\70-x.rules')).toBeDefined();
		expect(checkUdevPath('system/udev/7-x.rules')).toBeDefined();
		expect(checkUdevPath('system/udev/70-x.rule')).toBeDefined();
	});
});

describe('checkUdevRule', () => {
	test('lets rules set permissions', () => {
		const rule = [
			'# Android phones, for Android Auto over USB.',
			'SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0660", GROUP="plugdev", TAG+="uaccess"',
			'ENV{ID_MM_DEVICE_IGNORE}="1", SYMLINK+="android"',
		].join('\n');
		expect(checkUdevRule(rule)).toBeUndefined();
	});

	test('refuses anything that runs a program as root', () => {
		expect(checkUdevRule('SUBSYSTEM=="usb", RUN+="/bin/sh -c x"')).toContain('RUN');
		expect(checkUdevRule('RUN{program}+="/bin/x"')).toContain('RUN');
		expect(checkUdevRule('PROGRAM=="/bin/x", MODE="0666"')).toContain('PROGRAM');
		expect(checkUdevRule('IMPORT{program}="/bin/x"')).toContain('IMPORT{program}');
		expect(checkUdevRule('ok\nKERNEL=="x",RUN="/bin/x"')).toContain('Line 2');
	});

	test('does not mistake a comment or a value for a key', () => {
		expect(checkUdevRule('# RUN+="/bin/x" would be refused')).toBeUndefined();
		expect(checkUdevRule('ENV{RUN}="1"')).toBeUndefined();
		expect(checkUdevRule('IMPORT{builtin}="usb_id"')).toBeUndefined();
	});
});

describe('installedRuleName', () => {
	test('puts the package name after the number', () => {
		expect(installedRuleName('smartify_os_android_auto', 'system/udev/70-android-auto.rules')).toBe(
			'70-smartify_os_android_auto-android-auto.rules',
		);
	});
});
