import { describe, expect, test } from 'bun:test';
import { fieldFor, parseValue, readConfig, setConfig } from './config.ts';

const main = `import 'package:flutter/material.dart';
import 'package:smartify_os_core/bluetooth.dart';
import 'package:smartify_os_core/car.dart';
import 'package:smartify_os_core/core.dart';
import 'package:smartify_os_core/layouts.dart';

Future<void> main() async {
  await SmartifyOs().init(
    bluetooth: const BluetoothConfig(name: 'My car'),
    layouts: const LayoutsConfig(
      driverSide: DriverSide.left,
    ),
    car: const CarConfig(
      model3D: CarModel3DConfig(
        path: 'assets/car.glb',
        scale: 0.7,
        rotation: Offset3D(0, 180, 0),
        parts: CarModel3DPartsConfig(
          rollingWheels: [
            WheelConfig(objectName: 'FrontLeft', invertSpin: true),
            WheelConfig(objectName: 'FrontRight'),
            myWheel,
          ],
        ),
      ),
    ),
    reverseCamera: ReverseCameraConfig(
      // Which camera, if there is more than one.
      // device: '/dev/video2',
      guides: ReverseCameraGuidesConfig(
        // device: 'not this one',
        carWidth: 1.68,
      ),
    ),
    can: miataCan,
    gps: GpsConfig(backend: MyGps.new),
    extensions: [],
  );
}
`;

const set = (key: string, value: unknown) => ({ op: 'set' as const, key, value: value as never });

describe('readConfig', () => {
	test('reads what is written, as what it is', () => {
		const config = readConfig(main);
		expect(config.values['bluetooth.name']).toBe('My car');
		expect(config.values['car.model3D.scale']).toBe(0.7);
		expect(config.values['car.model3D.rotation']).toEqual({ x: 0, y: 180, z: 0 });
		expect(config.values['reverseCamera.guides.carWidth']).toBe(1.68);
		expect(config.values['car.model3D']).toBe(true);
		expect(config.lines['car.model3D']).toBe(14);
	});

	test('reads each element of a list, and one written as code as code', () => {
		const wheels = readConfig(main).values['car.model3D.parts.rollingWheels'];
		expect(wheels).toEqual([
			{ line: 20, values: { objectName: 'FrontLeft', invertSpin: true }, code: {} },
			{ line: 21, values: { objectName: 'FrontRight' }, code: {} },
			{ line: 22, values: {}, code: {}, asCode: 'myWheel' },
		]);
	});

	test('reports a config handed over as code once, never what is inside it', () => {
		const config = readConfig(main);
		expect(config.code.can).toEqual({ code: 'miataCan', line: 35 });
		expect(config.code['gps.backend']?.code).toBe('MyGps.new');
		expect(Object.keys(config.code).filter((key) => key.startsWith('can'))).toEqual(['can']);
		expect(config.values.gps).toBe(true);
	});

	test('leaves out what is not written, so it is the default', () => {
		const config = readConfig(main);
		expect(config.values['bluetooth.autoConnect']).toBeUndefined();
		expect(config.values.infoDisplay).toBeUndefined();
	});
});

describe('setConfig', () => {
	test('replaces a value where it is written', () => {
		const { source, manual } = setConfig(main, [set('car.model3D.scale', 0.85)]);
		expect(manual).toEqual([]);
		expect(source).toContain('scale: 0.85,');
		expect(source).not.toContain('scale: 0.7');
	});

	test('adds a value to its config, const only outside of a const one', () => {
		const { source } = setConfig(main, [
			set('bluetooth.reconnectMinDelay', 2000),
			set('reverseCamera.guides.color', '#FF00FF00'),
		]);
		expect(source).toContain(
			"BluetoothConfig(name: 'My car', reconnectMinDelay: Duration(seconds: 2))",
		);
		expect(source).toContain('color: const Color(0xFF00FF00)');
	});

	test('takes the example the owner left commented out directly inside, not a nested one', () => {
		const { source } = setConfig(main, [set('reverseCamera.device', '/dev/video4')]);
		expect(source).toContain("      device: '/dev/video4',\n");
		expect(source).toContain("// device: 'not this one',");
	});

	test('makes the configs on the way, with a comment and the import', () => {
		const { source } = setConfig(main, [set('infoDisplay.hiddenValues', ['speed'])]);
		expect(source).toContain(
			'    // What the info display can show, and what a tap on it goes through.\n    infoDisplay: const InfoDisplayConfig(hiddenValues: {InfoDisplayValues.speed}),\n\n    extensions: [],',
		);
		expect(source).toContain("import 'package:smartify_os_core/info_display.dart';");
	});

	test('makes nested configs inside one that is there', () => {
		const { source } = setConfig(main, [set('car.drawing2D.parts.steerableWheels', ['A', 'B'])]);
		expect(source).toContain(
			"drawing2D: CarDrawing2DConfig(parts: CarDrawing2DPartsConfig(steerableWheels: ['A', 'B']))",
		);
	});

	test('will not make a config without what it has to have', () => {
		expect(() => setConfig(main, [set('car.image.fit', 'contain')])).toThrow(
			'A new CarImageConfig needs path.',
		);
		expect(() =>
			setConfig(main, [set('car.model3D.parts.steeringWheel.maxRotation', 270)]),
		).toThrow('needs objectName');
		const { source } = setConfig(main, [
			set('car.model3D.parts.steeringWheel', { objectName: 'Wheel', maxRotation: 270 }),
		]);
		expect(source).toContain(
			"steeringWheel: SteeringWheelConfig(objectName: 'Wheel', maxRotation: 270)",
		);
	});

	test('hands back what would go inside code', () => {
		const { source, manual } = setConfig(main, [set('can.listenOnly', true)]);
		expect(source).toBe(main);
		expect(manual).toEqual(['can.listenOnly: true (can is written as code)']);
	});

	test('takes a value out again', () => {
		const { source } = setConfig(main, [{ op: 'unset', key: 'car.model3D.rotation' }]);
		expect(source).not.toContain('rotation');
		expect(setConfig(main, [{ op: 'unset', key: 'bluetooth.autoConnect' }]).source).toBe(main);
	});

	test('changes, adds, moves and removes the elements of a list', () => {
		let { source } = setConfig(main, [
			set('car.model3D.parts.rollingWheels[1].spinAxis', 'y'),
			{ op: 'add', key: 'car.model3D.parts.rollingWheels', value: { objectName: 'Back' } as never },
		]);
		expect(source).toContain("WheelConfig(objectName: 'FrontRight', spinAxis: RotationAxis.y),");
		expect(source).toContain(
			"            myWheel,\n            WheelConfig(objectName: 'Back'),\n",
		);

		source = setConfig(source, [
			{ op: 'move', key: 'car.model3D.parts.rollingWheels[3]', to: 0 },
		]).source;
		source = setConfig(source, [
			{ op: 'remove', key: 'car.model3D.parts.rollingWheels[1]' },
		]).source;
		const wheels = readConfig(source).values['car.model3D.parts.rollingWheels'] as {
			values: Record<string, unknown>;
		}[];
		expect(wheels.map((wheel) => wheel.values.objectName)).toEqual([
			'Back',
			'FrontRight',
			undefined,
		]);
	});

	test('adds and removes ids, and takes the list out once it is empty', () => {
		let { source } = setConfig(main, [
			{ op: 'add', key: 'layouts.hiddenLayouts', value: 'portrait' },
			{ op: 'add', key: 'layouts.hiddenLayouts', value: 'my_layout' },
			{ op: 'add', key: 'layouts.hiddenLayouts', value: 'portrait' },
		]);
		expect(source).toContain("hiddenLayouts: {Layouts.portrait, 'my_layout'}");
		source = setConfig(source, [
			{ op: 'remove', key: 'layouts.hiddenLayouts', id: 'my_layout' },
			{ op: 'remove', key: 'layouts.hiddenLayouts', id: 'portrait' },
		]).source;
		expect(source).toBe(main);
	});
});

describe('parseValue', () => {
	const parse = (key: string, value: string) => parseValue(fieldFor(key).field, key, value);

	test('takes values the way a person types them', () => {
		expect(parse('bluetooth.autoConnect', 'off')).toBe(false);
		expect(parse('bluetooth.reconnectMinDelay', '500ms')).toBe(500);
		expect(parse('bluetooth.reconnectMinDelay', '3')).toBe(3000);
		expect(parse('reverseCamera.guides.color', 'f5c542')).toBe('#FFF5C542');
		expect(parse('car.model3D.rotation', '0, 180, 0')).toEqual({ x: 0, y: 180, z: 0 });
		expect(parse('display.windowSize', '1280x720')).toEqual({ width: 1280, height: 720 });
		expect(parse('layouts.hiddenLayouts', 'portrait, focus')).toEqual(['portrait', 'focus']);
		expect(parse('reverseCamera.guides.stopLineColor', 'none')).toBeNull();
		expect(parse('infoDisplay.views[0].small', 'rpm')).toBe('rpm');
	});

	test('says what is wrong with a value, and with a key', () => {
		expect(() => parse('gps.accuracy', 'great')).toThrow('"great" cannot be gps.accuracy.');
		expect(() => parse('notifications.maxKept', '2.5')).toThrow();
		expect(() => fieldFor('car.modl3D.scale')).toThrow(
			'There is no setting called car.modl3D.scale.',
		);
	});
});
