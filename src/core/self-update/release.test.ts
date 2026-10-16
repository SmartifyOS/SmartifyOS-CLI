import { describe, expect, test } from 'bun:test';
import { CliError } from '../../utils/errors.ts';
import {
	assetUrl,
	parseChecksums,
	repo,
	resolveLatestTag,
	resolveLatestVersion,
	tagFromLocation,
	tagFromVersion,
	versionFromTag,
} from './release.ts';

/** The checksums.txt published with v0.1.1, exactly as it is served. */
const publishedChecksums = `30c064ad3f551a2a8066b662b251cb418ca71b2abd45b1315d4d721f3e957f1b  smartify-os-darwin-arm64.tar.gz
0ab965805ba394bc20e218a4401a533c9f8055b47bd43e7c08f5b06eec36b211  smartify-os-darwin-x64.tar.gz
5487675a21e1494cf10056c5e4173d43fe51d1024135a58bade96e0ba2c6f28a  smartify-os-linux-arm64-musl.tar.gz
88017fb83ab54448cce280421ce07aca47beb059335f5a6f514a6a63252c50c2  smartify-os-linux-arm64.tar.gz
6dbc88cb262bef01451ad47baa382d907a89fde9b03b2471cb2d20f3a6fa231b  smartify-os-linux-x64-musl.tar.gz
923a721a63116e39853c4cdcc5814a488785fab8f58d223ee5c79b7ba9eeb4cd  smartify-os-linux-x64.tar.gz
73c98c07093dda6348d824245f6d1051b52de6fc60b822423eafe20c170cfca9  smartify-os-windows-arm64.zip
77b7faf72cffe588b0910c8e124ccba71b84c33f32287a9d117214ceb9576512  smartify-os-windows-x64.zip
`;

/** Builds a fetch that answers each call in turn, so no test opens a socket. */
function fetchReturning(...answers: (Response | Error)[]): typeof fetch {
	let index = 0;
	return (async () => {
		const answer = answers[index++];
		if (!answer) throw new Error('The code asked more times than the test has answers.');
		if (answer instanceof Error) throw answer;
		return answer;
	}) as unknown as typeof fetch;
}

function redirectTo(location: string): Response {
	return new Response(null, { status: 302, headers: { location } });
}

describe('tagFromLocation', () => {
	test('reads the header GitHub actually sends', () => {
		expect(tagFromLocation(`https://github.com/${repo}/releases/tag/v0.1.1`)).toBe('v0.1.1');
	});

	test('copes with a trailing slash and with surrounding space', () => {
		expect(tagFromLocation(`  https://github.com/${repo}/releases/tag/v0.2.0/  `)).toBe('v0.2.0');
	});

	test('decodes a tag that had to be escaped', () => {
		expect(tagFromLocation(`https://github.com/${repo}/releases/tag/v1.0.0%2Bbuild`)).toBe(
			'v1.0.0+build',
		);
	});

	test('nothing at all is not a tag', () => {
		expect(tagFromLocation(null)).toBeUndefined();
		expect(tagFromLocation(undefined)).toBeUndefined();
		expect(tagFromLocation('')).toBeUndefined();
	});

	test('refuses a redirect somewhere else, so a proxy cannot pick the version', () => {
		expect(
			tagFromLocation('https://evil.example.com/SmartifyOS/SmartifyOS-CLI/releases/tag/v9'),
		).toBeUndefined();
		expect(tagFromLocation('http://github.com/a/b/releases/tag/v1')).toBeUndefined();
		expect(
			tagFromLocation(`https://github.com/${repo}/releases/download/v0.1.1/x.tar.gz`),
		).toBeUndefined();
		expect(tagFromLocation('/relative/releases/tag/v1')).toBeUndefined();
	});
});

describe('versionFromTag and tagFromVersion', () => {
	test('go back and forth', () => {
		expect(versionFromTag('v0.2.0')).toBe('0.2.0');
		expect(versionFromTag('0.2.0')).toBe('0.2.0');
		expect(tagFromVersion('0.2.0')).toBe('v0.2.0');
		expect(tagFromVersion('v0.2.0')).toBe('v0.2.0');
		expect(tagFromVersion('  0.2.0 ')).toBe('v0.2.0');
	});
});

describe('parseChecksums', () => {
	test('reads every line of the published file', () => {
		const sums = parseChecksums(publishedChecksums);
		expect(sums.size).toBe(8);
		expect(sums.get('smartify-os-darwin-arm64.tar.gz')).toBe(
			'30c064ad3f551a2a8066b662b251cb418ca71b2abd45b1315d4d721f3e957f1b',
		);
	});

	test('the musl name is not confused with the name it contains', () => {
		// smartify-os-linux-x64.tar.gz is a strict prefix of the musl one, which is exactly
		// the mistake a `includes` or `startsWith` match would make.
		const sums = parseChecksums(publishedChecksums);
		expect(sums.get('smartify-os-linux-x64.tar.gz')).toBe(
			'923a721a63116e39853c4cdcc5814a488785fab8f58d223ee5c79b7ba9eeb4cd',
		);
		expect(sums.get('smartify-os-linux-x64-musl.tar.gz')).toBe(
			'6dbc88cb262bef01451ad47baa382d907a89fde9b03b2471cb2d20f3a6fa231b',
		);
	});

	test('copes with Windows line endings, blank lines and the binary mode marker', () => {
		const sums = parseChecksums(
			`${'a'.repeat(64)} *smartify-os-windows-x64.zip\r\n\r\n${'b'.repeat(64)}  smartify-os-linux-x64.tar.gz\r\n`,
		);
		expect(sums.get('smartify-os-windows-x64.zip')).toBe('a'.repeat(64));
		expect(sums.get('smartify-os-linux-x64.tar.gz')).toBe('b'.repeat(64));
	});

	test('a truncated or nonsense file yields nothing rather than something wrong', () => {
		expect(parseChecksums('').size).toBe(0);
		expect(parseChecksums('<html>404</html>').size).toBe(0);
		expect(parseChecksums('abc  smartify-os-linux-x64.tar.gz').size).toBe(0);
	});
});

describe('assetUrl', () => {
	test('points at the release the tag names', () => {
		expect(assetUrl('v0.2.0', 'checksums.txt')).toBe(
			`https://github.com/${repo}/releases/download/v0.2.0/checksums.txt`,
		);
	});

	test('honours a mirror, with or without a trailing slash', () => {
		expect(assetUrl('v0.2.0', 'a.tar.gz', 'https://mirror.example.com/sos')).toBe(
			'https://mirror.example.com/sos/a.tar.gz',
		);
		expect(assetUrl('v0.2.0', 'a.tar.gz', 'https://mirror.example.com/sos/')).toBe(
			'https://mirror.example.com/sos/a.tar.gz',
		);
	});
});

describe('resolveLatestTag', () => {
	test('reads the redirect, and stops there', async () => {
		const fetchImpl = fetchReturning(redirectTo(`https://github.com/${repo}/releases/tag/v0.3.0`));
		expect(await resolveLatestTag({ fetchImpl })).toBe('v0.3.0');
	});

	test('follows the redirect itself when the header does not come through', async () => {
		const followed = new Response('a page', { status: 200 });
		Object.defineProperty(followed, 'url', {
			value: `https://github.com/${repo}/releases/tag/v0.4.0`,
		});
		const fetchImpl = fetchReturning(new Response(null, { status: 302 }), followed);
		expect(await resolveLatestTag({ fetchImpl })).toBe('v0.4.0');
	});

	test('falls back to the API only when neither of the other two work', async () => {
		const fetchImpl = fetchReturning(
			new Error('network down'),
			new Error('network down'),
			Response.json({ tag_name: 'v0.5.0' }),
		);
		expect(await resolveLatestTag({ fetchImpl })).toBe('v0.5.0');
	});

	test('says so plainly when nothing answers', async () => {
		const fetchImpl = fetchReturning(
			new Error('offline'),
			new Error('offline'),
			new Error('offline'),
		);
		await expect(resolveLatestTag({ fetchImpl })).rejects.toThrow(CliError);
	});

	test('a redirect somewhere unexpected does not become a version', async () => {
		const fetchImpl = fetchReturning(
			redirectTo('https://evil.example.com/releases/tag/v9.9.9'),
			new Error('offline'),
			new Error('offline'),
		);
		await expect(resolveLatestTag({ fetchImpl })).rejects.toThrow(CliError);
	});
});

describe('resolveLatestVersion', () => {
	test('drops the v, because that is what gets compared', async () => {
		const fetchImpl = fetchReturning(redirectTo(`https://github.com/${repo}/releases/tag/v0.3.0`));
		expect(await resolveLatestVersion({ fetchImpl })).toBe('0.3.0');
	});

	test('comes back empty handed rather than throwing, since nobody asked', async () => {
		const fetchImpl = fetchReturning(
			new Error('offline'),
			new Error('offline'),
			new Error('offline'),
		);
		expect(await resolveLatestVersion({ fetchImpl })).toBeUndefined();
	});
});
