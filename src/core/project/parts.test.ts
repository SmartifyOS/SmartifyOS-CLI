import { describe, expect, test } from 'bun:test';
import { partNames, partSource, readPart, register, unregister } from './parts.ts';

const main = `import 'package:smartify_os_core/core.dart';

Future<void> main() async {
  await SmartifyOs().init(
    appList: const AppListConfig(entries: []),
    extensions: [],
  );
}
`;

describe('partNames', () => {
	test('spells a name every way it is needed', () => {
		expect(partNames("  Driver's   seat ")).toEqual({
			name: "Driver's seat",
			snake: 'drivers_seat',
			pascal: 'DriversSeat',
			camel: 'driversSeat',
		});
	});

	test('refuses a name that cannot be a file and a class', () => {
		expect(() => partNames('2 fast')).toThrow('has to start with a letter');
		expect(() => partNames('$cash')).toThrow('cannot be the name');
	});
});

describe('register', () => {
	test('adds to a list that is there, and takes const off around it', () => {
		const edited = register(main, 'window', 'TripWindow.appListEntry');
		expect(edited).toContain('appList: AppListConfig(entries: [TripWindow.appListEntry]),');
	});

	test('adds the config when there is none', () => {
		const edited = register(main, 'tile', 'lightTile');
		expect(edited).toContain('quickSettings: QuickSettingsConfig(tiles: [lightTile]),');
		expect(edited?.indexOf('quickSettings')).toBeLessThan(edited?.indexOf('extensions') ?? 0);
	});

	test('leaves a list kept in a variable to the owner', () => {
		const source = main.replace(
			'const AppListConfig(entries: [])',
			'AppListConfig(entries: myApps)',
		);
		expect(register(source, 'window', 'TripWindow.appListEntry')).toBeUndefined();
	});

	test('takes one out again', () => {
		const edited = register(main, 'window', 'TripWindow.appListEntry') ?? '';
		const twice = register(edited, 'window', 'FuelWindow.appListEntry') ?? '';
		const back = unregister(twice, 'window', 'TripWindow.appListEntry');
		expect(back).toContain('entries: [FuelWindow.appListEntry]');
	});
});

describe('readPart', () => {
	test('reads back what it made, for every kind', () => {
		const names = partNames('Oil temperature');
		const registered = register(main, 'widget', 'oilTemperatureWidget') ?? '';
		for (const [kind, variant] of [
			['window', 'floating'],
			['tile', 'button'],
			['widget', 'pinned'],
		] as const) {
			const part = readPart(
				kind,
				'lib/x.dart',
				partSource(kind, variant, names, 'thermostat'),
				registered,
			);
			expect(part).toMatchObject({
				id: 'oil_temperature',
				name: 'Oil temperature',
				variant,
				icon: 'thermostat',
			});
			expect(part.line).toBeGreaterThan(1);
		}
		const widget = readPart(
			'widget',
			'lib/x.dart',
			partSource('widget', 'card', names, 'info'),
			registered,
		);
		expect(widget.registered).toBe(true);
		expect(widget.symbol).toBe('oilTemperatureWidget');
	});
});
