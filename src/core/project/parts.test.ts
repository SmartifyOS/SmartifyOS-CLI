import { describe, expect, test } from 'bun:test';
import {
	parseOrder,
	partNames,
	partSource,
	readCall,
	readPart,
	register,
	unregister,
} from './parts.ts';

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

	test('counts a window handed over some other way than lib/main.dart', () => {
		const source = partSource('window', 'fullscreen', partNames('Trip computer'), 'route');
		const appList = `final entries = [
  AppListEntry(
    id: 'trip',
    onOpen: (context) => SmartifyOsNavigator.push(context, const TripComputerWindow()),
  ),
];`;
		expect(readPart('window', 'lib/x.dart', source, appList).registered).toBe(true);
		expect(readPart('window', 'lib/x.dart', source, main).registered).toBe(false);
		// A comment that names it is not using it.
		const comment = '// TripComputerWindow is not in the list yet.';
		expect(readPart('window', 'lib/x.dart', source, comment).registered).toBe(false);
	});
});

describe('readCall', () => {
	const list = `const counterId = 'counter';

/// The car's own widgets.
final carWidgets = <HomeWidget>[
  HomeWidget(
    id: counterId,
    title: 'Tap counter',
    icon: const Icon(Icons.exposure_plus_1),
    builder: (home) => const Text('0'),
  ),
  HomeWidget.pinned(
    id: 'engine',
    title: 'Engine',
    icon: const Icon(Icons.speed),
    builder: (home) => const Text('RPM'),
  ),
];
`;
	const at = (n: number) => [...list.matchAll(/HomeWidget(\.pinned)?\(/g)][n]?.index ?? -1;

	test('reads each of several in a list, and changes none of them', () => {
		const counter = readCall('widget', 'lib/home_widgets.dart', list, at(0), 'widgets: carWidgets');
		expect(counter).toMatchObject({
			id: 'counter',
			name: 'Tap counter',
			icon: 'exposure_plus_1',
			variant: 'card',
			symbol: 'carWidgets',
			registered: true,
			canChange: { name: false, icon: false, remove: false },
			line: 5,
		});
		const engine = readCall('widget', 'lib/home_widgets.dart', list, at(1), '');
		expect(engine).toMatchObject({ id: 'engine', name: 'Engine', variant: 'pinned', line: 11 });
		expect(engine.registered).toBe(false);
	});

	test('a part made by the CLI can be changed', () => {
		const source = partSource('tile', 'toggle', partNames('Interior light'), 'lightbulb');
		const tile = readPart('tile', 'lib/quick_settings/interior_light_tile.dart', source, '');
		expect(tile.canChange).toEqual({
			name: true,
			icon: true,
			order: true,
			appList: false,
			remove: true,
		});
		expect(tile.order).toBeNull();
		expect(tile.inAppList).toBeNull();
	});
});

describe('parseOrder', () => {
	test('takes a whole number, or nothing for the usual place', () => {
		expect(parseOrder('10')).toBe(10);
		expect(parseOrder(' -5 ')).toBe(-5);
		expect(parseOrder('')).toBeNull();
		expect(() => parseOrder('first')).toThrow();
		expect(() => parseOrder('1.5')).toThrow();
	});
});
