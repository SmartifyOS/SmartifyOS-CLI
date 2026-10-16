import { describe, expect, test } from 'bun:test';
import { androidSdkRoots, firstVersion } from './doctor.ts';
import { gitInstallHint, newestStable } from './flutter.ts';

describe('newestStable', () => {
	const releases = {
		current_release: { beta: 'b1', stable: 's2' },
		releases: [
			{ hash: 'b1', channel: 'beta', version: '3.50.0-0.1.pre' },
			{ hash: 's2', channel: 'stable', version: '3.47.5' },
			{ hash: 's1', channel: 'stable', version: '3.47.4' },
		],
	};

	test('names the release the current stable commit belongs to', () => {
		expect(newestStable(releases)).toBe('3.47.5');
	});

	test('is undefined for anything that is not a releases file', () => {
		expect(newestStable(null)).toBeUndefined();
		expect(newestStable({})).toBeUndefined();
		expect(newestStable({ current_release: { stable: 'gone' }, releases: [] })).toBeUndefined();
	});
});

describe('gitInstallHint', () => {
	test('says how to get git on each desktop', () => {
		expect(gitInstallHint('darwin')).toContain('xcode-select --install');
		expect(gitInstallHint('win32')).toContain('git-scm.com');
		expect(gitInstallHint('linux')).toContain('apt install git');
	});
});

describe('firstVersion', () => {
	test('finds the version in what a program prints', () => {
		expect(firstVersion('git version 2.50.1 (Apple Git-155)')).toBe('2.50.1');
		expect(firstVersion('Version 37.0.1-15733141')).toBe('37.0.1');
		expect(firstVersion('1.17')).toBe('1.17');
		expect(firstVersion('none')).toBeUndefined();
	});
});

describe('androidSdkRoots', () => {
	test('looks where the owner said first, then where Android Studio puts it', () => {
		expect(androidSdkRoots({ ANDROID_HOME: '/sdk' }, 'darwin', '/Users/me')).toEqual([
			'/sdk',
			'/Users/me/Library/Android/sdk',
		]);
		expect(androidSdkRoots({ ANDROID_HOME: '' }, 'linux', '/home/me')).toEqual([
			'/home/me/Android/Sdk',
		]);
	});
});
