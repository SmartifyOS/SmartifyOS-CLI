import { describe, expect, test } from 'bun:test';
import {
	entryKeyLine,
	entryLines,
	entryNames,
	removeEntry,
	setEntry,
	yamlScalar,
} from './blocks.ts';

const pubspec = `name: my_car
publish_to: 'none'

dependencies:
  flutter:
    sdk: flutter
  # Android Auto, as an extension. See main.dart.
  smartify_os_android_auto:
    git:
      url: https://github.com/Mauznemo/smartify_os_android_auto.git
      ref: main

# How SmartifyOS itself is found.
dependency_overrides:
  smartify_os_core:
    path: ../smartify_os_core
  # Keep in step with smartify_os_core/pubspec.yaml.
  flutter_angle:
    git:
      url: https://github.com/Mauznemo/flutter_angle.git
      ref: main

dev_dependencies:
  flutter_lints: ^6.0.0

flutter:
  uses-material-design: true
`;

describe('entryNames', () => {
	test('lists the entries of a section in order', () => {
		expect(entryNames(pubspec, 'dependencies')).toEqual(['flutter', 'smartify_os_android_auto']);
		expect(entryNames(pubspec, 'dependency_overrides')).toEqual([
			'smartify_os_core',
			'flutter_angle',
		]);
	});

	test('a missing section has nothing in it', () => {
		expect(entryNames(pubspec, 'nothing_here')).toEqual([]);
	});
});

describe('entryLines', () => {
	test('gives the entry back at the left edge, without its comments', () => {
		expect(entryLines(pubspec, 'dependency_overrides', 'flutter_angle')).toEqual([
			'flutter_angle:',
			'  git:',
			'    url: https://github.com/Mauznemo/flutter_angle.git',
			'    ref: main',
		]);
	});

	test('reads a one line entry', () => {
		expect(entryKeyLine(pubspec, 'dev_dependencies', 'flutter_lints')).toBe(
			'flutter_lints: ^6.0.0',
		);
	});
});

describe('setEntry', () => {
	test('replaces an entry and keeps the comment above it', () => {
		const result = setEntry(pubspec, 'dependencies', 'smartify_os_android_auto', [
			'smartify_os_android_auto: any',
		]);
		expect(result).toContain(
			'  # Android Auto, as an extension. See main.dart.\n  smartify_os_android_auto: any\n\n# How',
		);
		expect(result).not.toContain('ref: main\n\n# How');
	});

	test('changes nothing else in the file', () => {
		const result = setEntry(pubspec, 'dependency_overrides', 'smartify_os_core', [
			'smartify_os_core:',
			'  git:',
			'    url: https://example.com/core.git',
			'    ref: v0.3.0',
		]);
		const before = pubspec.split('\n');
		const after = result.split('\n');
		expect(after.length).toBe(before.length + 2);
		expect(after.slice(0, 14)).toEqual(before.slice(0, 14));
		expect(after.slice(18)).toEqual(before.slice(16));
	});

	test('adds a new entry at the end of the section', () => {
		const result = setEntry(pubspec, 'dependencies', 'smartify_os_dashcam', [
			'smartify_os_dashcam: any',
		]);
		expect(result).toContain('      ref: main\n  smartify_os_dashcam: any\n\n# How');
	});

	test('adds a missing section after the one it is asked to follow', () => {
		const text = 'name: x\n\ndependencies:\n  flutter:\n    sdk: flutter\n\nflutter:\n  a: b\n';
		const result = setEntry(text, 'dependency_overrides', 'core', ['core: any'], ['dependencies']);
		expect(result).toBe(
			'name: x\n\ndependencies:\n  flutter:\n    sdk: flutter\n\ndependency_overrides:\n  core: any\n\nflutter:\n  a: b\n',
		);
	});

	test('adds a missing section at the end when there is nothing to follow', () => {
		expect(setEntry('name: x\n', 'dependencies', 'a', ['a: any'])).toBe(
			'name: x\n\ndependencies:\n  a: any\n',
		);
	});

	test('follows the indentation the file already uses', () => {
		const text = 'dependencies:\n    flutter:\n        sdk: flutter\n';
		expect(setEntry(text, 'dependencies', 'a', ['a:', '  path: ../a'])).toBe(
			'dependencies:\n    flutter:\n        sdk: flutter\n    a:\n      path: ../a\n',
		);
	});

	test('opens a section written as an empty map', () => {
		expect(setEntry('dependency_overrides: {}\n', 'dependency_overrides', 'a', ['a: any'])).toBe(
			'dependency_overrides:\n  a: any\n',
		);
	});

	test('keeps Windows line endings', () => {
		const text = 'dependencies:\r\n  flutter:\r\n    sdk: flutter\r\n';
		expect(setEntry(text, 'dependencies', 'a', ['a: any'])).toBe(
			'dependencies:\r\n  flutter:\r\n    sdk: flutter\r\n  a: any\r\n',
		);
	});

	test('a comment at the left edge stays with the section below it', () => {
		const text = 'dependencies:\n  a: any\n# About b\nb:\n  c: d\n';
		expect(setEntry(text, 'dependencies', 'x', ['x: any'])).toBe(
			'dependencies:\n  a: any\n  x: any\n# About b\nb:\n  c: d\n',
		);
	});
});

describe('removeEntry', () => {
	test('takes the entry out with its comments', () => {
		const result = removeEntry(pubspec, 'dependency_overrides', 'flutter_angle');
		expect(result).not.toContain('flutter_angle');
		expect(result).not.toContain('Keep in step');
		expect(result).toContain('    path: ../smartify_os_core\n\ndev_dependencies:');
	});

	test('takes an emptied section out too', () => {
		const text = 'name: x\n\ndependency_overrides:\n  a: any\n\nflutter:\n  b: c\n';
		expect(removeEntry(text, 'dependency_overrides', 'a')).toBe('name: x\n\nflutter:\n  b: c\n');
	});

	test('leaves the file alone when there is nothing to take out', () => {
		expect(removeEntry(pubspec, 'dependencies', 'nope')).toBe(pubspec);
		expect(removeEntry(pubspec, 'nope', 'flutter')).toBe(pubspec);
	});
});

describe('yamlScalar', () => {
	test('leaves plain values plain', () => {
		expect(yamlScalar('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
		expect(yamlScalar('v0.3.0')).toBe('v0.3.0');
		expect(yamlScalar('../smartify_os_core')).toBe('../smartify_os_core');
	});

	test('quotes what YAML would read differently', () => {
		expect(yamlScalar('>=0.2.0')).toBe('">=0.2.0"');
		expect(yamlScalar('yes')).toBe('"yes"');
		expect(yamlScalar('a: b')).toBe('"a: b"');
		expect(yamlScalar('')).toBe('""');
	});
});
