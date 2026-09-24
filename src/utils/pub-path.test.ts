import { describe, expect, test } from 'bun:test';
import { pubPath } from './pub-path.ts';

describe('pubPath', () => {
	test('a folder nearby is written relative', () => {
		expect(pubPath('/cars/miata', '/cars/smartify_os_dashcam')).toBe('../smartify_os_dashcam');
		expect(pubPath('/cars/miata/example', '/cars/core')).toBe('../../core');
	});

	test('a folder far away is written as it is', () => {
		expect(pubPath('/home/me/cars/miata/x', '/Volumes/SSD/core')).toBe('/Volumes/SSD/core');
	});
});
