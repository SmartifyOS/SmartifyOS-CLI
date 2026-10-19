import { describe, expect, test } from 'bun:test';
import { partNames } from './parts.ts';
import {
	addRow,
	changePage,
	changeRow,
	moveRow,
	pageSource,
	readPage,
	readPageAt,
	removeRow,
} from './settings.ts';

const file = 'lib/settings/seats_page.dart';
const empty = pageSource(partNames('Seats'), 'vehicle', 'event_seat');
const read = (source: string) => readPage(file, source, 'pages: [seatsPage]');

/** A page with a row of every kind, made the way the CLI makes them. */
function withRows(): string {
	let source = empty;
	source = addRow(source, read(source), 'toggle', 'Heating').source;
	source = addRow(source, read(source), 'choice', 'Level', {
		options: ['Low', 'High'],
		default: 'high',
	}).source;
	source = addRow(source, read(source), 'action', 'Reset').source;
	source = addRow(source, read(source), 'info', 'Service', { value: 'soon' }).source;
	return source;
}

describe('readPage', () => {
	test('reads a new page', () => {
		expect(read(empty)).toMatchObject({
			id: 'seats',
			title: 'Seats',
			icon: 'event_seat',
			parent: 'vehicle',
			symbol: 'seatsPage',
			registered: true,
			rows: [],
		});
	});

	test('reads back every kind of row it made', () => {
		const [heating, level, reset, service] = read(withRows()).rows;
		expect(heating).toMatchObject({
			id: 'heating',
			kind: 'toggle',
			saved: { name: 'seatsHeating', key: 'seats.heating', default: false },
			code: null,
		});
		expect(level).toMatchObject({
			kind: 'choice',
			options: [
				{ value: 'low', label: 'Low' },
				{ value: 'high', label: 'High' },
			],
			saved: { name: 'seatsLevel', default: 'high' },
		});
		expect(reset).toMatchObject({
			kind: 'action',
			saved: null,
			code: { name: '_resetTapped', written: false },
		});
		expect(service).toMatchObject({ kind: 'info', value: 'soon' });
	});
});

describe('changeRow', () => {
	test('switches remembering and code on and off, with their declarations', () => {
		let source = withRows();
		source = changeRow(source, read(source), 0, { remember: false, code: true }).source;
		const heating = read(source).rows[0];
		expect(heating?.saved).toBeNull();
		expect(heating?.code?.name).toBe('_heatingChanged');
		expect(source).not.toContain('seatsHeating');

		source = changeRow(source, read(source), 0, { code: false }).source;
		expect(source).not.toContain('_heatingChanged');
	});

	test('keeps code the owner wrote, and a value read elsewhere', () => {
		let source = withRows();
		source = source.replace("debugPrint('reset was tapped');", 'resetTrip();');
		const done = removeRow(source, read(source), 2);
		expect(done.kept).toEqual(['_resetTapped']);
		expect(done.source).toContain('resetTrip();');

		const kept = changeRow(
			source,
			read(source),
			0,
			{ remember: false },
			(name) => name === 'seatsHeating',
		);
		expect(kept.kept).toEqual(['seatsHeating']);
		expect(kept.source).toContain('const seatsHeating');
	});

	test('a choice that loses its pick goes back to the first option', () => {
		let source = withRows();
		source = changeRow(source, read(source), 1, { options: ['Off', 'Low'] }).source;
		expect(read(source).rows[1]).toMatchObject({
			options: [
				{ value: 'off', label: 'Off' },
				{ value: 'low', label: 'Low' },
			],
			saved: { default: 'off' },
		});
	});

	test('changes what a row says', () => {
		let source = withRows();
		source = changeRow(source, read(source), 0, {
			title: "Driver's seat",
			subtitle: 'Warm',
		}).source;
		expect(read(source).rows[0]).toMatchObject({ title: "Driver's seat", subtitle: 'Warm' });
		source = changeRow(source, read(source), 0, { subtitle: '' }).source;
		expect(read(source).rows[0]?.subtitle).toBeNull();
	});
});

describe('moveRow and changePage', () => {
	test('moves a row and changes the page around it', () => {
		let source = moveRow(withRows(), 3, 'up');
		expect(read(source).rows.map((row) => row.id)).toEqual([
			'heating',
			'level',
			'service',
			'reset',
		]);
		source = changePage(source, read(source), { parent: 'my_page', title: 'Comfort' });
		expect(read(source)).toMatchObject({ parent: 'my_page', title: 'Comfort' });
		expect(() => changePage(source, read(source), { parent: 'seats' })).toThrow(
			'cannot go in itself',
		);
	});
});

describe('readPageAt', () => {
	test('reads each of several pages in a list, which the CLI does not change', () => {
		const source = `final carPages = <SettingsPage>[
  SettingsPage(
    id: 'seats',
    parent: SettingsPages.vehicle,
    title: 'Seat heating',
    icon: const Icon(Icons.event_seat),
    entries: [
      SettingsEntry.toggle(title: 'Driver seat', initialValue: false, onChanged: (on) {}),
    ],
  ),
  SettingsPage.custom(
    id: 'gauges',
    title: 'Gauges',
    body: (settings) => const Text('Gauges'),
  ),
];
`;
		const [seats, gauges] = [...source.matchAll(/SettingsPage(\.custom)?\(/g)].map((match) =>
			readPageAt('lib/settings_pages.dart', source, match.index ?? 0, 'pages: carPages'),
		);
		expect(seats).toMatchObject({
			id: 'seats',
			title: 'Seat heating',
			parent: 'vehicle',
			icon: 'event_seat',
			symbol: 'carPages',
			registered: true,
			editable: false,
		});
		expect(seats?.rows.map((row) => row.title)).toEqual(['Driver seat']);
		expect(gauges).toMatchObject({ id: 'gauges', title: 'Gauges', rows: [], line: 11 });
	});
});
