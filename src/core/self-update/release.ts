import { basename } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { version } from '../../utils/version.ts';

/**
 * Everything the CLI needs to know about what has been released, and nothing about what to
 * do with it.
 *
 * The one design rule here: **do not use api.github.com.** An unauthenticated caller gets
 * sixty requests an hour per IP address, which is shared by everyone behind the same router
 * and by every machine in a workshop. github.com itself has no such limit, it answers
 * `/releases/latest` with a redirect naming the newest tag, and every asset URL can be
 * worked out from that tag. The API is only kept as the last of three fallbacks.
 */

export const repo = 'SmartifyOS/SmartifyOS-CLI';

/** Where the answers come from, so a test can answer for itself. */
export interface ReleaseSource {
	/** `SMARTIFY_OS_BASE_URL`, the mirror escape hatch both installers already document. */
	baseUrl?: string | undefined;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

const defaultTimeoutMs = 10_000;

/** Says who is calling, which is simple politeness and helps GitHub when something breaks. */
function userAgent(): string {
	return `smartify-os-cli/${version}`;
}

function call(source: ReleaseSource): typeof fetch {
	return source.fetchImpl ?? fetch;
}

function timeout(source: ReleaseSource): AbortSignal {
	return AbortSignal.timeout(source.timeoutMs ?? defaultTimeoutMs);
}

/**
 * Pulls the tag out of a release URL.
 *
 * Strict about the shape on purpose. Following whatever a redirect happens to point at is
 * how a rewriting proxy would get to choose which version gets installed.
 */
export function tagFromLocation(location: string | null | undefined): string | undefined {
	if (!location) return undefined;

	const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/([^/?#]+)\/?$/.exec(
		location.trim(),
	);
	if (!match?.[1]) return undefined;

	try {
		return decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
}

/** `v0.2.0` becomes `0.2.0`. Anything already without the `v` is left alone. */
export function versionFromTag(tag: string): string {
	return tag.replace(/^v/, '');
}

/** `0.2.0` becomes `v0.2.0`, which is how the release tags are named. */
export function tagFromVersion(input: string): string {
	const trimmed = input.trim();
	return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * Reads the `<sha256>  <filename>` lines that `sha256sum` writes and the release publishes.
 *
 * Keyed on the exact filename, never on a substring: `smartify-os-linux-x64.tar.gz` is a
 * prefix of `smartify-os-linux-x64-musl.tar.gz`, so anything looser would hand back the
 * wrong hash for one of the two.
 */
export function parseChecksums(text: string): Map<string, string> {
	const sums = new Map<string, string>();

	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line) continue;

		// The `*` marks a file read in binary mode, which some sha256sum builds write.
		const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
		if (match?.[1] && match[2]) sums.set(match[2].trim(), match[1].toLowerCase());
	}

	return sums;
}

/** Where one file of one release lives. */
export function assetUrl(tag: string, asset: string, baseUrl?: string | undefined): string {
	const base = baseUrl?.replace(/\/$/, '') ?? `https://github.com/${repo}/releases/download/${tag}`;
	return `${base}/${asset}`;
}

/**
 * Asks GitHub which release is the newest one.
 *
 * Three ways of asking, cheapest and least metered first. A HEAD on `/releases/latest` sends
 * back nothing but headers, and the `location` header is the whole answer.
 *
 * @throws {CliError} when none of the three work.
 */
export async function resolveLatestTag(source: ReleaseSource = {}): Promise<string> {
	const fetcher = call(source);
	const latest = `https://github.com/${repo}/releases/latest`;

	try {
		const response = await fetcher(latest, {
			method: 'HEAD',
			redirect: 'manual',
			signal: timeout(source),
			headers: { 'user-agent': userAgent() },
		});
		const tag = tagFromLocation(response.headers.get('location'));
		if (tag) return tag;
	} catch {
		// Try the next way of asking.
	}

	// Some proxies follow or swallow the redirect rather than passing it on. Following it
	// and reading where we ended up gets the same answer for the cost of one small page.
	try {
		const response = await fetcher(latest, { redirect: 'follow', signal: timeout(source) });
		await response.body?.cancel();
		const tag = tagFromLocation(response.url);
		if (tag) return tag;
	} catch {
		// One left.
	}

	// The API knows too, but it is the rate limited one, so it goes last.
	try {
		const response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
			signal: timeout(source),
			headers: { accept: 'application/vnd.github+json', 'user-agent': userAgent() },
		});
		const body = (await response.json()) as { tag_name?: unknown };
		if (typeof body.tag_name === 'string' && body.tag_name) return body.tag_name;
	} catch {
		// Nothing left to try.
	}

	throw new CliError('Could not find out which version is the newest.', {
		hint: `Check your internet connection, or see https://github.com/${repo}/releases yourself.`,
	});
}

/**
 * The same question, for the update notice rather than for the update command.
 *
 * Comes back undefined instead of throwing, because nobody asked for this check and a
 * machine with no internet must not be told off for it.
 */
export async function resolveLatestVersion(
	source: ReleaseSource = {},
): Promise<string | undefined> {
	try {
		return versionFromTag(await resolveLatestTag(source));
	} catch {
		return undefined;
	}
}

/** Fetches a small text file, for example `checksums.txt`. */
export async function fetchText(url: string, source: ReleaseSource = {}): Promise<string> {
	const response = await call(source)(url, {
		signal: timeout(source),
		headers: { 'user-agent': userAgent() },
	});

	if (!response.ok) {
		throw new CliError(`Could not download ${basename(url)} (${response.status}).`, {
			hint: `See https://github.com/${repo}/releases to check what is published.`,
		});
	}

	return await response.text();
}

/**
 * Downloads a release asset to a file, reporting how far along it is.
 *
 * Written to disk as it arrives rather than held in memory. The archives are around 25 MB,
 * and the machines this runs on are often the small computer that lives in the car.
 */
export async function downloadAsset(
	url: string,
	destination: string,
	onProgress?: (received: number, total: number) => void,
	source: ReleaseSource = {},
): Promise<void> {
	const response = await call(source)(url, { headers: { 'user-agent': userAgent() } });

	if (!response.ok || !response.body) {
		throw new CliError(`Could not download ${basename(destination)} (${response.status}).`, {
			hint: `See https://github.com/${repo}/releases to check what is published.`,
		});
	}

	const total = Number(response.headers.get('content-length') ?? 0);
	const sink = Bun.file(destination).writer();
	let received = 0;

	try {
		for await (const chunk of response.body) {
			sink.write(chunk);
			received += chunk.byteLength;
			onProgress?.(received, total);
		}
	} finally {
		await sink.end();
	}
}

/** The sha256 of a file, as lowercase hex, read a chunk at a time. */
export async function sha256OfFile(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest('hex');
}
