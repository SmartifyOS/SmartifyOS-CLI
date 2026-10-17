import { describe, expect, test } from 'bun:test';
import { vmServiceAddress } from './vm-service.ts';

describe('vmServiceAddress', () => {
	test('turns the address flutter run prints into its WebSocket', () => {
		expect(
			vmServiceAddress(
				'A Dart VM Service on macOS is available at: http://127.0.0.1:61234/Hk3m2Dq0aXY=/',
			),
		).toBe('ws://127.0.0.1:61234/Hk3m2Dq0aXY=/ws');
	});

	test('adds the slash when it is missing', () => {
		expect(
			vmServiceAddress('A Dart VM Service on Linux is available at: http://127.0.0.1:5000/abc='),
		).toBe('ws://127.0.0.1:5000/abc=/ws');
	});

	test('ignores every other line', () => {
		expect(vmServiceAddress('Flutter run key commands.')).toBeUndefined();
		expect(
			vmServiceAddress('The Flutter DevTools debugger is available at: http://x'),
		).toBeUndefined();
	});
});
