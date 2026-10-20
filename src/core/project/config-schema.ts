/**
 * Every setting of `SmartifyOs().init` the `config` command reads and writes (see
 * `config.ts`), as a tree of the configs core has, each with its default. A copy of core's
 * configs, so a new setting in core is a new field here, and the editor's setup pages pick it
 * up by its key.
 */

/** What a setting is, which says how it is written in Dart and given on the command line. */
export type FieldType =
	| 'bool'
	| 'number'
	| 'integer'
	| 'string'
	| 'enum'
	| 'duration'
	| 'color'
	| 'offset3d'
	| 'size'
	| 'ids'
	| 'list'
	| 'section'
	| 'code';

/** One setting the command knows. */
export interface Field {
	/** The whole key, or for a field of a list's elements its name in the element. */
	key: string;
	type: FieldType;
	/** One line saying what it is, for `config --list`. */
	describe: string;
	/** What SmartifyOS takes when it is not written, null when that is nothing. */
	default: ConfigValue;
	/** Null can be written, and means something else than leaving it out (`none`). */
	nullable?: boolean;
	/** Has to be given when its config or element is made. */
	required?: boolean;
	/** enum: the names it can be. */
	values?: string[];
	/** enum, and ids or strings a constant can stand for: the class the names are in. */
	prefix?: string;
	/** ids and strings: the ids the constants of `prefix` stand for, by the constant's name. */
	constants?: Record<string, string>;
	/** ids: written as a set, `{...}`, rather than a list. */
	set?: boolean;
	/** section and list: the class it is, or each element is. */
	className?: string;
	/** section and list: what is inside, by name. */
	fields?: Field[];
	/** The default as it is written, when it is code rather than a plain value. */
	defaultCode?: string;
}

/** Internal: a field with what it takes to write it. */
export interface SchemaField extends Field {
	fields?: SchemaField[];
	/** Libraries any one of which has to be imported for what is written. */
	imports?: string[];
	/** Said above a config when it is added to `SmartifyOs().init`. */
	comment?: string[];
}

/** A value as the command reads and takes it. */
export type ConfigValue =
	| boolean
	| number
	| string
	| null
	| { x: number; y: number; z: number }
	| { width: number; height: number }
	| string[]
	| ConfigElement[];

/** One element of a list of configs, like one wheel. */
export interface ConfigElement {
	/** Where it starts in `lib/main.dart`, from 1. */
	line: number;
	/** What is written and can be read, by the field's name. */
	values: Record<string, ConfigValue>;
	/** What is written as code, by the field's name. */
	code: Record<string, string>;
	/** The whole element, when it is written as code rather than as a call of its class. */
	asCode?: string;
}

const core = (library: string) => `package:smartify_os_core/${library}.dart`;
const flutter = [
	'package:flutter/material.dart',
	'package:flutter/widgets.dart',
	'package:flutter/painting.dart',
];

/** Internal: names that are also their ids. */
const same = (...names: string[]) => Object.fromEntries(names.map((name) => [name, name]));

const layoutIds = same('classic', 'split', 'sidebar', 'tiles', 'focus', 'portrait');
const themeIds = same('glass', 'slate', 'carbon', 'frost', 'midnight', 'horizon', 'retro');
const appListIds = {
	settings: 'settings',
	homeWidgets: 'home_widgets',
	reverseCamera: 'reverse_camera',
};
const homeWidgetIds = {
	bluetoothPlayer: 'bluetooth_player',
	quickSettings: 'quick_settings',
	clock: 'clock',
	infoDisplay: 'info_display',
	car: 'car',
	reverseCamera: 'reverse_camera',
};
const tileIds = { doNotDisturb: 'do_not_disturb', bluetooth: 'bluetooth' };
const statusIconIds = {
	home: 'home',
	clock: 'clock',
	notifications: 'notifications',
	ongoingNotifications: 'ongoing_notifications',
	doNotDisturb: 'do_not_disturb',
	bluetooth: 'bluetooth',
};
const settingsPageIds = {
	root: 'root',
	connectivity: 'connectivity',
	bluetooth: 'bluetooth',
	bluetoothDevice: 'bluetooth.device',
	wifi: 'wifi',
	mobileData: 'mobile_data',
	sound: 'sound',
	display: 'display',
	appearance: 'appearance',
	vehicle: 'vehicle',
	canDevices: 'vehicle.can_devices',
	canDevice: 'vehicle.can_devices.device',
	dateTime: 'date_time',
	dateTimeZone: 'date_time.time_zone',
	dateTimeZoneRegion: 'date_time.time_zone.region',
	language: 'language',
	system: 'system',
	developer: 'developer',
	canMonitor: 'developer.can_monitor',
	about: 'about',
};
const infoDisplayIds = { speed: 'speed' };
const soundIds = same(
	'notificationInfo',
	'notificationWarning',
	'notificationError',
	'bluetoothConnected',
	'bluetoothDisconnected',
);

// The builders the schema below is written with.

function section(
	key: string,
	className: string,
	imports: string[],
	describe: string,
	fields: SchemaField[],
	more: Partial<SchemaField> = {},
): SchemaField {
	return { key, type: 'section', className, imports, describe, default: null, fields, ...more };
}

function bool(key: string, fallback: boolean | null, describe: string): SchemaField {
	return { key, type: 'bool', default: fallback, describe };
}

function number(key: string, fallback: number | null, describe: string): SchemaField {
	return { key, type: 'number', default: fallback, describe };
}

function integer(key: string, fallback: number, describe: string): SchemaField {
	return { key, type: 'integer', default: fallback, describe };
}

function text(
	key: string,
	fallback: string | null,
	describe: string,
	more: Partial<SchemaField> = {},
) {
	return { key, type: 'string', default: fallback, describe, ...more } satisfies SchemaField;
}

function choice(
	key: string,
	prefix: string,
	values: string[],
	fallback: string,
	describe: string,
	imports: string[],
): SchemaField {
	return { key, type: 'enum', prefix, values, default: fallback, describe, imports };
}

function duration(key: string, milliseconds: number, describe: string): SchemaField {
	return { key, type: 'duration', default: milliseconds, describe };
}

function ids(
	key: string,
	describe: string,
	constants?: { prefix: string; ids: Record<string, string>; imports: string[] },
	set = true,
): SchemaField {
	return {
		key,
		type: 'ids',
		default: [],
		describe,
		set,
		...(constants
			? { prefix: constants.prefix, constants: constants.ids, imports: constants.imports }
			: {}),
	};
}

function sound(key: string, fallback: string, describe: string): SchemaField {
	return text(key, fallback, describe, {
		nullable: true,
		prefix: 'SoundAssets',
		constants: soundIds,
		imports: [core('sound'), core('notifications'), core('bluetooth')],
	});
}

function code(key: string, describe: string): SchemaField {
	return { key, type: 'code', default: null, describe };
}

const axes = (key: string, fallback: string, describe: string) =>
	choice(key, 'RotationAxis', ['x', 'y', 'z'], fallback, describe, [core('car')]);

/** Every setting, as a tree under `SmartifyOs().init`. */
const schema: SchemaField[] = [
	section('bluetooth', 'BluetoothConfig', [core('bluetooth')], 'Bluetooth, for phones', [
		bool('enabled', true, 'Use Bluetooth at all'),
		text('name', null, 'The name phones see when they look for the car'),
		bool('powerOn', true, 'Turn Bluetooth on at startup'),
		bool('discoverable', true, 'Stay findable by new phones'),
		bool('pairable', true, 'Accept new phones pairing'),
		bool('autoConnect', true, 'Reconnect to known phones as soon as they are in range'),
		duration('reconnectMinDelay', 3000, 'How long to wait before the first reconnect'),
		duration('reconnectMaxDelay', 60000, 'The longest wait between reconnects'),
		bool('autoAcceptServices', true, 'Let known phones use music and calls without asking'),
		choice(
			'pairingMode',
			'BluetoothPairingMode',
			['confirmCode', 'showCode', 'none'],
			'confirmCode',
			'How a new phone pairs',
			[core('bluetooth')],
		),
		duration('pairingTimeout', 45000, 'How long a pairing question stays open'),
		sound('connectedSound', 'bluetoothConnected', 'The sound when a phone connects'),
		sound('disconnectedSound', 'bluetoothDisconnected', 'The sound when a phone disconnects'),
		number('soundVolume', 1, 'How loud those two are, from 0 to 1'),
		text('adapter', null, 'Which Bluetooth adapter, like hci0, when there are several'),
		code('backend', 'Bluetooth of your own'),
	]),
	section('settings', 'SettingsConfig', [core('settings')], 'Settings', [
		ids('hiddenPages', 'Built-in settings pages to leave out', {
			prefix: 'SettingsPages',
			ids: settingsPageIds,
			imports: [core('settings')],
		}),
	]),
	section('appList', 'AppListConfig', [core('app_list')], 'The app list', [
		ids('hiddenEntries', 'Built-in apps to leave out', {
			prefix: 'AppListEntries',
			ids: appListIds,
			imports: [core('app_list')],
		}),
	]),
	section('homeWidgets', 'HomeWidgetsConfig', [core('home_widgets')], 'The home screen', [
		ids('hiddenWidgets', 'Built-in home screen widgets to leave out', {
			prefix: 'HomeWidgets',
			ids: homeWidgetIds,
			imports: [core('home_widgets'), core('layouts')],
		}),
	]),
	section('layouts', 'LayoutsConfig', [core('layouts')], 'The layouts', [
		ids('hiddenLayouts', 'Built-in layouts the driver is not offered', {
			prefix: 'Layouts',
			ids: layoutIds,
			imports: [core('layouts')],
		}),
	]),
	section('themes', 'ThemesConfig', [core('theme')], 'The themes', [
		ids('hiddenThemes', 'Built-in themes the driver is not offered', {
			prefix: 'Themes',
			ids: themeIds,
			imports: [core('theme')],
		}),
	]),
	section('bar', 'BarConfig', [core('bar'), core('layouts')], 'The bar', [
		ids(
			'dockApps',
			'The apps the dock starts with',
			{ prefix: 'AppListEntries', ids: appListIds, imports: [core('app_list')] },
			false,
		),
		bool('reachableWithoutTouch', true, 'The knob goes on into the bar after the home widgets'),
	]),
	section(
		'car',
		'CarConfig',
		[core('car')],
		'The car on the screen',
		[
			bool('speedFromGps', true, 'Roll the wheels at the speed the GPS says'),
			section('model3D', 'CarModel3DConfig', [core('car')], 'The car as a 3D model', [
				{
					key: 'offset',
					type: 'offset3d',
					default: { x: 0, y: 0, z: 0 },
					describe: 'Moves the model, in model units',
					imports: [core('car')],
				},
				{
					key: 'rotation',
					type: 'offset3d',
					default: { x: 0, y: 0, z: 0 },
					describe: 'Turns the model, in degrees',
					imports: [core('car')],
				},
				number('scale', 1, 'Grows or shrinks the model'),
				number('lookAtHeight', 0.5, 'How high the camera aims, in model units'),
				section('parts', 'CarModel3DPartsConfig', [core('car')], 'What moves on its own', [
					{
						key: 'rollingWheels',
						type: 'list',
						className: 'WheelConfig',
						default: [],
						describe: 'Every wheel that rolls',
						imports: [core('car')],
						fields: [
							text('objectName', null, 'Its name in the model', { required: true }),
							axes('spinAxis', 'x', 'The axle it turns around'),
							bool('invertSpin', false, 'It rolls backwards'),
						],
					},
					{
						key: 'steerableWheels',
						type: 'list',
						className: 'SteerableWheelConfig',
						default: [],
						describe: 'The front wheels that steer',
						imports: [core('car')],
						fields: [
							text('holderObjectName', null, 'The name of what holds the wheel', {
								required: true,
							}),
							axes('steerAxis', 'y', 'What it turns around'),
						],
					},
					section(
						'steeringWheel',
						'SteeringWheelConfig',
						[core('car')],
						'The steering wheel inside the car',
						[
							text('objectName', null, 'Its name in the model', { required: true }),
							axes('rotationAxis', 'z', 'What it turns around'),
							number('maxRotation', 450, 'How far it turns, in degrees'),
						],
						{ nullable: true },
					),
					number('wheelCircumference', 1.9, 'How far one turn of a wheel goes, in metres'),
				]),
				section('render', 'CarModel3DRenderConfig', [core('car')], 'How it is drawn', [
					number('scale', 1.5, 'How many pixels it is drawn with, next to the screen'),
					number('exposure', 1.15, 'How bright it is'),
					number('environmentIntensity', 0.55, 'How strongly it reflects the studio'),
					integer('shadowMapSize', 2048, 'How finely the shadow is drawn, in pixels'),
					bool('vignette', true, 'Darken the corners a little'),
				]),
			]),
			section('drawing2D', 'CarDrawing2DConfig', [core('car')], 'The car as a drawing', [
				section('parts', 'CarDrawing2DPartsConfig', [core('car')], 'What moves on its own', [
					ids(
						'steerableWheels',
						'The front wheels, which turn with the steering',
						undefined,
						false,
					),
				]),
				number('lineWidth', null, 'How thick every line is on screen'),
				number('margin', 24, 'Room kept clear around it'),
			]),
			section('image', 'CarImageConfig', [core('car')], 'The car as a picture', [
				text('path', null, 'Set with appearance --picture', { required: true }),
				choice(
					'fit',
					'BoxFit',
					['cover', 'contain', 'fill', 'fitWidth', 'fitHeight', 'none', 'scaleDown'],
					'cover',
					'How it fills its space',
					flutter,
				),
				choice(
					'alignment',
					'Alignment',
					[
						'topLeft',
						'topCenter',
						'topRight',
						'centerLeft',
						'center',
						'centerRight',
						'bottomLeft',
						'bottomCenter',
						'bottomRight',
					],
					'center',
					'Which part stays in view',
					flutter,
				),
			]),
		],
		{
			nullable: true,
		},
	),
	section(
		'reverseCamera',
		'ReverseCameraConfig',
		[core('reverse_camera')],
		'The reverse camera',
		[
			text('device', null, 'Which camera, like /dev/video2, when there are several'),
			bool('mirror', false, 'Flip the picture left to right'),
			bool('openWhenReversing', true, 'Fill the screen with it in reverse'),
			section(
				'guides',
				'ReverseCameraGuidesConfig',
				[core('reverse_camera')],
				'The lines showing where the car will go',
				[
					number('carWidth', 1.75, 'How wide the car is, in metres'),
					number('wheelbase', 2.6, 'From the front wheels to the back ones'),
					number('rearOverhang', 0.9, 'From the back wheels to the back of the car'),
					number('cameraSideOffset', 0, 'How far the camera is off the middle, right is +'),
					number('cameraHeight', 0.9, 'How high the camera is'),
					number('cameraTilt', 30, 'How far it looks down, in degrees'),
					number('cameraYaw', 0, 'How far it looks to the side, in degrees'),
					number('cameraRoll', 0, 'How crooked it is, in degrees'),
					number('fieldOfView', 120, 'How wide it sees, in degrees'),
					number('length', 4, 'How far back the lines go'),
					{
						key: 'color',
						type: 'color',
						default: '#FFF5C542',
						describe: 'The two lines',
						imports: flutter,
					},
					{
						key: 'stopLineColor',
						type: 'color',
						default: '#FFE5483B',
						nullable: true,
						describe: 'The line across them',
						imports: flutter,
					},
					number('stopLineDistance', 0.3, 'How far behind the car that line is'),
				],
				{ nullable: true },
			),
			code('backend', 'A camera of your own'),
		],
		{ nullable: true },
	),
	section(
		'can',
		'CanConfig',
		[core('can')],
		'The CAN bus',
		[
			choice(
				'bitrate',
				'CanBitrate',
				['kbps10', 'kbps20', 'kbps50', 'kbps100', 'kbps125', 'kbps250', 'kbps500', 'kbps1000'],
				'kbps500',
				'How fast the bus runs',
				[core('can')],
			),
			bool('listenOnly', false, 'Only listen, never send'),
			duration('deviceTimeout', 3500, 'How long a device can be quiet before it counts as lost'),
			text('firmwareHeader', 'firmware/smartify_os_network.h', 'Where the firmware header goes', {
				nullable: true,
			}),
			code('adapters', 'The adapters'),
			code('devices', 'The devices'),
			code('messages', 'The messages'),
		],
		{ nullable: true },
	),
	section('infoDisplay', 'InfoDisplayConfig', [core('info_display')], 'The info display', [
		{
			key: 'values',
			type: 'list',
			className: 'InfoDisplayValue',
			default: [],
			describe: 'Your own values',
			imports: [core('info_display')],
			fields: [
				text('id', null, 'Its name in code', { required: true }),
				text('label', null, 'What the driver reads', { required: true }),
				text('unit', '', 'Written after the number'),
				integer('decimals', 0, 'How many digits after the point'),
				integer('order', 100, 'Where it sits in the list, smaller first'),
				code('value', 'Where the number comes from'),
			],
		},
		{
			key: 'views',
			type: 'list',
			className: 'InfoDisplayView',
			default: [],
			describe: 'What a tap goes through, in order',
			imports: [core('info_display')],
			fields: [
				text('big', null, 'The value shown big', {
					required: true,
					prefix: 'InfoDisplayValues',
					constants: infoDisplayIds,
					imports: [core('info_display')],
				}),
				text('small', null, 'The value shown small under it', {
					prefix: 'InfoDisplayValues',
					constants: infoDisplayIds,
					imports: [core('info_display')],
				}),
			],
		},
		ids('hiddenValues', 'Built-in values to leave out', {
			prefix: 'InfoDisplayValues',
			ids: infoDisplayIds,
			imports: [core('info_display')],
		}),
	]),
	section('statusBar', 'StatusBarConfig', [core('status_bar')], 'The status bar', [
		ids('hiddenIcons', 'Built-in status bar icons to leave out', {
			prefix: 'StatusIcons',
			ids: statusIconIds,
			imports: [core('status_bar')],
		}),
	]),
	section('notifications', 'NotificationsConfig', [core('notifications')], 'Notifications', [
		integer('maxKept', 50, 'How many the shade keeps'),
		duration('defaultShowFor', 5000, 'How long one sits on screen'),
		bool('soundsEnabled', true, 'Play notification sounds'),
		number('soundVolume', 1, 'How loud, from 0 to 1'),
		bool('doNotDisturb', false, 'Start with do not disturb on'),
		sound('infoSound', 'notificationInfo', 'The sound of an info'),
		sound('warningSound', 'notificationWarning', 'The sound of a warning'),
		sound('errorSound', 'notificationError', 'The sound of an error'),
	]),
	section('quickSettings', 'QuickSettingsConfig', [core('quick_settings')], 'Quick settings', [
		ids('hiddenTiles', 'Built-in tiles to leave out', {
			prefix: 'QuickSettingsTiles',
			ids: tileIds,
			imports: [core('quick_settings')],
		}),
	]),
	section('display', 'DisplayConfig', [core('core')], 'The screen', [
		{
			key: 'windowSize',
			type: 'size',
			default: { width: 1024, height: 600 },
			describe: 'How big the window is on a computer',
			imports: flutter,
		},
		bool('fullScreen', null, 'Take the whole screen, or leave it out for only on the car'),
		number('designWidth', 1080, 'The width everything is laid out at'),
		bool('ignoreSystemTextScale', true, "Ignore the computer's own text size"),
	]),
	section('dateTime', 'DateTimeConfig', [core('date_time')], 'Date and time', [
		bool('automatic', true, 'Let the system keep its own time'),
		text('timeZone', null, 'The time zone, like Europe/Berlin'),
		bool('use24HourClock', null, '13:45 rather than 1:45 PM, or leave it out for the system'),
		bool('setSystemClock', true, "Change the computer's own clock"),
		code('backend', 'A clock of your own'),
	]),
	section('gps', 'GpsConfig', [core('gps')], 'GPS', [
		bool('enabled', true, 'Use GPS at all'),
		choice(
			'accuracy',
			'GpsAccuracy',
			['low', 'medium', 'high', 'best'],
			'best',
			'How hard to try',
			[core('gps')],
		),
		integer('distanceFilter', 0, 'How far to move before a new position, in metres'),
		bool('requestPermission', true, 'Ask for the location permission'),
		bool('setClock', true, 'Set the clock from the satellites'),
		duration('fixTimeout', 0, 'How long a position stays good once nothing comes in'),
		code('backend', 'GPS of your own'),
	]),
	section('drives', 'DrivesConfig', [core('drives')], 'USB drives', [
		bool('enabled', true, 'Look for USB drives at all'),
		bool('mountAutomatically', true, 'Open a drive as soon as it is plugged in'),
		code('backend', 'Drives of your own'),
	]),
	section('volume', 'VolumeConfig', [core('volume')], 'The volume', [
		bool('enabled', true, 'Change the volume at all'),
		code('backend', 'A volume of your own'),
	]),
	section('updates', 'UpdatesConfig', [core('updates')], 'Updates from a USB drive', [
		bool('enabled', true, 'Offer an update from a USB drive'),
		code('backend', 'Updates of your own'),
	]),
];

/** Said above a config when it is added to `SmartifyOs().init`, so the owner knows what it is. */
const comments: Record<string, string> = {
	bluetooth: 'Bluetooth, for the phones of whoever drives.',
	settings: 'What Settings has.',
	appList: 'The app list.',
	homeWidgets: 'The widgets on the home screen.',
	layouts: 'How the screen is arranged.',
	themes: 'The themes the driver can pick from.',
	bar: 'What sits in the bar.',
	car: 'The car, wherever a layout shows it.',
	reverseCamera: 'The reverse camera, any USB camera.',
	can: 'The CAN bus, and the devices on it.',
	infoDisplay: 'What the info display can show, and what a tap on it goes through.',
	statusBar: 'The icons in the status bar.',
	notifications: 'How notifications show and sound.',
	quickSettings: 'The quick settings.',
	display: 'The screen it runs on.',
	dateTime: 'The clock.',
	gps: 'Where the car is, and how fast it goes.',
	drives: 'USB drives plugged into the car.',
	volume: 'The volume.',
	updates: 'Updates from a USB drive.',
};
for (const field of schema) {
	const comment = comments[field.key];
	if (comment) field.comment = [comment];
}

/** Internal: every field by its whole key, sections included, list elements left out. */
export const byKey = new Map<string, SchemaField>();
(function index(fields: SchemaField[], prefix: string) {
	for (const field of fields) {
		const key = `${prefix}${field.key}`;
		byKey.set(key, { ...field, key });
		if (field.type === 'section' && field.fields) index(field.fields, `${key}.`);
	}
})(schema, '');
