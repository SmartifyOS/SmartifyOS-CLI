import { describe, expect, test } from 'bun:test';
import {
	type CollectionDetail,
	classInfo,
	describeSetting,
	extensionFields,
	packageOf,
	readExtensionSettings,
	type SettingDetail,
	setExtensionSettings,
} from './settings.ts';

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

  /// USB vendor ids to take for a camera.
  final Set<int> vendorIds;

  final String? savedSound;

  /// Where clips go.
  final DashcamStorage storage;

  /// What a clip is saved as.
  final ClipFormat format;

  /// The format for each camera, by its name.
  final Map<String, ClipFormat> formats;

  /// More places clips go.
  final List<DashcamStorage> backups;

  /// What to do with a clip, in code.
  final void Function(String)? onSaved;

  /// Lists of lists stay code.
  final List<List<String>> groups;

  DashcamExtension({
    this.minutes = 10,
    this.enabled = true,
    this.quality = DashcamQuality.high,
    this.cameras = const [],
    this.vendorIds = const {},
    this.savedSound = DashcamSounds.saved,
    this.storage = const DashcamStorage.internal(),
    ClipFormat? format,
    this.formats = const {},
    this.backups = const [],
    this.onSaved,
    this.groups = const [],
  }) : format = format ?? ClipFormats.mp4;

  @override
  String get id => 'dashcam';
}
`;

const models = `@freezed
sealed class DashcamStorage with _$DashcamStorage {
  /// On the car's own disk.
  const factory DashcamStorage.internal({
    /// How many gigabytes it may take.
    @Default(8) int gigabytes,
  }) = DashcamInternalStorage;

  /// On a USB stick.
  const factory DashcamStorage.stick({
    /// The stick's name.
    required String label,
    @Default(DashcamQuality.low) DashcamQuality quality,
  }) = DashcamStickStorage;
}

class ClipFormat {
  final String extension;
  const ClipFormat._(this.extension);
}

abstract final class ClipFormats {
  static const mp4 = ClipFormat._('mp4');
  static final mkv = _make('mkv');
  static ClipFormat _make(String extension) => ClipFormat._(extension);
}
`;

const entry = {
	packageName: 'smartify_os_dashcam',
	library: 'dashcam.dart',
	className: 'DashcamExtension',
	isConst: false,
};

const pack = packageOf([extension, models], 'package:smartify_os_dashcam/dashcam.dart');

const main = `Future<void> main() async {
  await SmartifyOs().init(
    extensions: [
      DashcamExtension(minutes: 5, onSaved: keepClip, vendorIds: {0x18d1}),
      const OtherExtension(),
    ],
  );
}
`;

describe('extension settings', () => {
	const fields = extensionFields(pack, 'DashcamExtension');

	test('reads every argument with its type, default and doc comment', () => {
		expect(fields.map((field) => [field.key, field.type, field.default])).toEqual([
			['minutes', 'integer', 10],
			['enabled', 'bool', true],
			['quality', 'enum', 'high'],
			['cameras', 'ids', []],
			['vendorIds', 'ids', []],
			['savedSound', 'string', 'packages/smartify_os_dashcam/saved.wav'],
			['storage', 'object', null],
			['format', 'object', null],
			['formats', 'map', null],
			['backups', 'array', null],
			['onSaved', 'code', null],
			['groups', 'code', null],
		]);
		expect(fields[8]?.item).toMatchObject({ type: 'object', className: 'ClipFormat' });
		expect(fields[9]?.item).toMatchObject({ type: 'object', className: 'DashcamStorage' });
		expect(fields[0]?.describe).toBe('How many minutes it keeps.\n\nThe oldest goes first.');
		expect(fields[1]?.describe).toBe('Whether it records with the minutes above.');
		expect(fields[2]?.values).toEqual(['low', 'high']);
		expect(fields[4]?.itemType).toBe('integer');
		expect(fields[6]?.defaultCode).toBe('DashcamStorage.internal()');
		expect(fields[7]?.defaultCode).toBe('ClipFormats.mp4');
	});

	test('reads a freezed class by its factories, and the constants of a type', () => {
		const storage = classInfo(pack, 'DashcamStorage');
		expect(storage?.makings.map((making) => making.name)).toEqual(['internal', 'stick']);
		expect(
			storage?.makings[1]?.fields.map((field) => [
				field.key,
				field.required ?? false,
				field.default,
			]),
		).toEqual([
			['label', true, null],
			['quality', false, 'low'],
		]);
		expect(storage?.makings[0]?.fields[0]?.describe).toBe('How many gigabytes it may take.');
		expect(classInfo(pack, 'ClipFormat')?.constants).toEqual([
			{ name: 'ClipFormats.mp4', isConst: true },
			{ name: 'ClipFormats.mkv', isConst: false },
		]);
	});

	test('reads what the app gives it, and code as code', () => {
		const settings = readExtensionSettings(main, entry, pack);
		expect(settings.switchedOn).toBe(true);
		expect(settings.line).toBe(4);
		expect(settings.values).toEqual({ minutes: 5, vendorIds: ['0x18d1'] });
		expect(settings.code.onSaved?.code).toBe('keepClip');
	});

	test('writes into its element only', () => {
		const { source } = setExtensionSettings(main, entry, pack, [
			{ op: 'set', key: 'quality', value: 'low' },
			{ op: 'unset', key: 'minutes' },
			{ op: 'add', key: 'cameras', id: 'Front' },
			{ op: 'add', key: 'cameras', id: 'Back' },
			{ op: 'remove', key: 'cameras', id: 'Front' },
			{ op: 'add', key: 'vendorIds', id: '6353' },
		]);
		expect(source).toContain(
			"DashcamExtension(onSaved: keepClip, vendorIds: {0x18d1, 6353}, quality: DashcamQuality.low, cameras: const ['Back']),",
		);
		expect(source).toContain('const OtherExtension(),');
	});

	test('makes an object with one of its constructors, and changes what is inside it', () => {
		let { source } = setExtensionSettings(main, entry, pack, [
			{ op: 'set', key: 'storage', value: { $making: 'stick', label: 'DASHCAM' } },
			{ op: 'set', key: 'format', value: 'ClipFormats.mkv' },
		]);
		expect(source).toContain(
			"storage: const DashcamStorage.stick(label: 'DASHCAM'), format: ClipFormats.mkv",
		);
		source = setExtensionSettings(source, entry, pack, [
			{ op: 'set', key: 'storage.quality', value: 'high' },
		]).source;
		expect(source).toContain(
			"storage: const DashcamStorage.stick(label: 'DASHCAM', quality: DashcamQuality.high)",
		);

		const detail = describeSetting(source, entry, pack, 'storage') as SettingDetail;
		expect(detail.makings.map((making) => making.name)).toEqual(['internal', 'stick']);
		expect(detail.written).toEqual({
			kind: 'made',
			making: 'stick',
			values: { label: 'DASHCAM', quality: 'high' },
			code: {},
		});
		expect((describeSetting(source, entry, pack, 'format') as SettingDetail).written).toEqual({
			kind: 'constant',
			name: 'ClipFormats.mkv',
		});
	});

	test('adds, changes and takes out the items of a map and a list', () => {
		let { source } = setExtensionSettings(main, entry, pack, [
			{ op: 'set', key: 'formats[front]', value: 'ClipFormats.mkv' },
			{ op: 'set', key: 'formats[back]', value: 'ClipFormats.mp4' },
			{ op: 'set', key: 'backups[0]', value: { $making: 'stick', label: 'ONE' } },
			{ op: 'set', key: 'backups[1]', value: { $making: 'internal' } },
		]);
		expect(source).toContain(
			"formats: {'front': ClipFormats.mkv, 'back': ClipFormats.mp4}, backups: [const DashcamStorage.stick(label: 'ONE'), const DashcamStorage.internal()]",
		);

		source = setExtensionSettings(source, entry, pack, [
			{ op: 'set', key: 'backups[0].quality', value: 'high' },
			{ op: 'set', key: 'formats[front]', value: 'ClipFormats.mp4' },
			{ op: 'unset', key: 'formats[back]' },
			{ op: 'unset', key: 'backups[1]' },
		]).source;
		expect(source).toContain(
			"formats: {'front': ClipFormats.mp4}, backups: [const DashcamStorage.stick(label: 'ONE', quality: DashcamQuality.high)]",
		);

		const formats = describeSetting(source, entry, pack, 'formats') as CollectionDetail;
		expect(formats.entries).toEqual([{ key: 'front', line: 6, code: 'ClipFormats.mp4' }]);
		const backup = describeSetting(source, entry, pack, 'backups[0]') as SettingDetail;
		expect(backup.written).toMatchObject({ kind: 'made', making: 'stick' });
		expect(() =>
			setExtensionSettings(source, entry, pack, [
				{ op: 'set', key: 'backups[5]', value: { $making: 'internal' } },
			]),
		).toThrow('backups[5] is not there');
	});

	test('says what an object is missing, and what is not set up yet', () => {
		expect(() =>
			setExtensionSettings(main, entry, pack, [
				{ op: 'set', key: 'storage', value: { $making: 'stick' } },
			]),
		).toThrow('storage needs label');
		expect(() =>
			setExtensionSettings(main, entry, pack, [{ op: 'set', key: 'storage.gigabytes', value: 4 }]),
		).toThrow('storage is not set up yet');
	});

	test('says when it is not switched on', () => {
		const off = main.replace(
			'DashcamExtension(minutes: 5, onSaved: keepClip, vendorIds: {0x18d1}),\n',
			'',
		);
		expect(readExtensionSettings(off, entry, pack).switchedOn).toBe(false);
		expect(() => setExtensionSettings(off, entry, pack, [{ op: 'unset', key: 'minutes' }])).toThrow(
			'not switched on',
		);
	});
});
