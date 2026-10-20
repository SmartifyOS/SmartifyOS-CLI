import { describe, expect, test } from 'bun:test';
import { extensionFields, readExtensionSettings, setExtensionSettings } from './settings.ts';

const extension = `import 'package:smartify_os_core/extensions.dart';

enum DashcamQuality { low, high }

abstract final class DashcamSounds {
  static const String saved = 'packages/smartify_os_dashcam/saved.wav';
}

class DashcamExtension extends SmartifyOsExtension {
  /// How many minutes it keeps.
  ///
  /// The oldest goes first.
  final int minutes;

  /// Whether it records with the [minutes] above.
  final bool enabled;

  final DashcamQuality quality;

  /// The cameras, by name.
  final List<String> cameras;

  final String? savedSound;

  /// What to do with a clip, in code.
  final void Function(String)? onSaved;

  const DashcamExtension({
    this.minutes = 10,
    this.enabled = true,
    this.quality = DashcamQuality.high,
    this.cameras = const [],
    this.savedSound = DashcamSounds.saved,
    this.onSaved,
  });

  @override
  String get id => 'dashcam';
}
`;

const entry = {
	packageName: 'smartify_os_dashcam',
	library: 'dashcam.dart',
	className: 'DashcamExtension',
	isConst: true,
};

const main = `Future<void> main() async {
  await SmartifyOs().init(
    extensions: [
      const DashcamExtension(minutes: 5, onSaved: keepClip),
      const OtherExtension(),
    ],
  );
}
`;

describe('extension settings', () => {
	const fields = extensionFields(extension, [], 'package:smartify_os_dashcam/dashcam.dart');

	test('reads every argument with its type, default and doc comment', () => {
		expect(fields.map((field) => [field.key, field.type, field.default])).toEqual([
			['minutes', 'integer', 10],
			['enabled', 'bool', true],
			['quality', 'enum', 'high'],
			['cameras', 'ids', []],
			['savedSound', 'string', 'packages/smartify_os_dashcam/saved.wav'],
			['onSaved', 'code', null],
		]);
		expect(fields[0]?.describe).toBe('How many minutes it keeps.\n\nThe oldest goes first.');
		expect(fields[1]?.describe).toBe('Whether it records with the minutes above.');
		expect(fields[2]?.values).toEqual(['low', 'high']);
	});

	test('reads what the app gives it, and code as code', () => {
		const settings = readExtensionSettings(main, entry, fields);
		expect(settings.switchedOn).toBe(true);
		expect(settings.line).toBe(4);
		expect(settings.values).toEqual({ minutes: 5 });
		expect(settings.code.onSaved?.code).toBe('keepClip');
	});

	test('writes into its element only', () => {
		const { source } = setExtensionSettings(main, entry, fields, [
			{ op: 'set', key: 'quality', value: 'low' },
			{ op: 'unset', key: 'minutes' },
			{ op: 'add', key: 'cameras', id: 'Front' },
			{ op: 'add', key: 'cameras', id: 'Back' },
			{ op: 'remove', key: 'cameras', id: 'Front' },
		]);
		expect(source).toContain(
			"const DashcamExtension(onSaved: keepClip, quality: DashcamQuality.low, cameras: ['Back']),",
		);
		expect(source).toContain('const OtherExtension(),');
	});

	test('says when it is not switched on', () => {
		const off = main.replace('const DashcamExtension(minutes: 5, onSaved: keepClip),\n', '');
		expect(readExtensionSettings(off, entry, fields).switchedOn).toBe(false);
		expect(() =>
			setExtensionSettings(off, entry, fields, [{ op: 'unset', key: 'minutes' }]),
		).toThrow('not switched on');
	});
});
