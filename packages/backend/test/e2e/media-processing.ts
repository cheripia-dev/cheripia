/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, test } from 'vitest';
import sharp from 'sharp';
import { signup, uploadFile, port, post } from '../utils.js';

// JXL fixtures from libjxl/testdata contributors, CC BY 4.0 (AS-IS):
// https://creativecommons.org/licenses/by/4.0/
// Original bytes are unchanged; only represented as base64 here.
// still: https://github.com/libjxl/testdata/blob/main/jxl/spline_on_first_frame.jxl
// Git blob: 6fa417a941ec167b4e3e08c4cb1d29e1d8f118ad
// animated: https://github.com/libjxl/testdata/blob/main/jxl/blending/cropped_traffic_light.jxl
// Git blob: 2d0241da1816e984da58fc228809737875d89418
// The fixture data is CC BY 4.0, separately from this test code's AGPL license.
const STILL_JXL = '/wpHQCTYYyAAAHQAAuAoKipGxmAQgF8AAEToz4Qk4ox2AughlkBwAADYY1gAAHAAAuAgKipGxkgAfgEAEKFfEhIJRFhA4YklEBxgCA==';
const ANIMATED_JXL = '/wp4AmIIArAmCJAAAAAPaTBLAACAAADMB0soMd2M9cFnMDuvEBAQOAICAkqygEgkQpnxZ/J3cfNd5FmmVeGO6IjYGGOMJGXhFsYYr7LhsL6A8AAAlAkAxo7sDCNY4ychjsBv9r6Ggj75aTdLv3jcDamgEA53I7CZzPYAesB4clKVBpp3XCQMxyk4gv74gcHHDsiEikXH5VSfhsUpAWyVVosYP2EDamKmng0vCZHULfDKGS/QFqSqDiCsM05EoUfY01UwwJRcpAxABC9/GI6B0Jv/ad5CeXAkZ+nInMHrzzbGysrJre/uj+fzMXrjX3cUOklccb7SgSCyauQ4t+hCQaLqFBSdHyq0LQrbo+AJlZlndSIqpL6F7uj7H0rkDWdgtw06WNL9FTd8No2QYgwm8hEP8MGOwYfzuxzq1hIPMP5PftgYUj8QuXYkq3ekrjqyzdWEFxQA3Yd1hlzsQyqZiH4tjLJAfHZQOPjMeK20/WQizwMpqD32CncQWHTlH/PETmRUVqsXPG0MTcmQ1eSo1jFBDCAaw9NHgZXEFWkbW6Q4BELD3mFwPDD3iNlyemYZKbbM/7SazisWNf0WV+H/7XzKs33j3x0QTThtnKHRMCzWJBUTmIlCMDmphVIbD/9nkv7hUFRk0tgO6dZTElXpzoHtOKo0m4OUUqtqHVuAgWYRi+VJ6N8dfZdkRbEIkJAARQYaIpFkAgD4AEsShQIFiHBuG2OwvLuACACOOs8KdUcCMRuvPX6qSctq8H7Pm0I5A1+5rf1L2GSEYmsZ/VI+0xXHy7N4AKgDCJCQYEEGVCLRLAEAAAIAXAFLEoUCBQA1yYkxTv4FZACIaJcScNgSeADk4gHgyJPR4PUaRUV+zcAqfp3+4nw7q2YP8XZQDHIMRPEccb3+00/dgCcgGxnw/5FaQAnDk5JpbgWj0zkOPl0IkJAARQY3IpFkAQAsAUsShQIFiHCWFGOwmvkLyADg+8ULaRMQ/qJSRZbLmABbNcsHLjCpT5UH7v0EywWHChcfNLsKmJsIjQhHaWadgROz3LxL4/AGKuJNBQ==';

describe('Media processing', () => {
	let user: Awaited<ReturnType<typeof signup>>;
	const svgBody = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="red"/><circle cx="400" cy="400" r="200" fill="blue"/></svg>';
	const fixtures: Record<string, Buffer> = {};
	const files: Record<string, NonNullable<Awaited<ReturnType<typeof uploadFile>>['body']>> = {};

	function localUrl(url: string) {
		const parsed = new URL(url);
		return `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
	}

	async function inspect(url: string) {
		const res = await fetch(localUrl(url), { headers: { 'user-agent': 'MediaProcessing-E2E' } });
		const data = Buffer.from(await res.arrayBuffer());
		let metadata;
		try {
			const m = await sharp(data, { animated: true }).metadata();
			metadata = { format: m.format, width: m.width, height: m.height, pages: m.pages, pageHeight: m.pageHeight, orientation: m.orientation };
		} catch {
			metadata = null;
		}
		const result = { status: res.status, type: res.headers.get('content-type'), size: data.length, metadata };
		return { ...result, data };
	}

	beforeAll(async () => {
		user = await signup({ username: 'mediaprocessing' });
		fixtures['plain.svg'] = Buffer.from(svgBody);
		fixtures['xml.svg'] = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${svgBody}`);
		fixtures['doctype.svg'] = Buffer.from(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${svgBody}`);
		fixtures['large.png'] = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#fc8080' } }).png().toBuffer();
		fixtures['large.jpg'] = await sharp(fixtures['large.png']).jpeg().toBuffer();
		fixtures['square.png'] = await sharp(fixtures['plain.svg']).png().toBuffer();
		fixtures['still.jxl'] = Buffer.from(STILL_JXL, 'base64');
		fixtures['animated.jxl'] = Buffer.from(ANIMATED_JXL, 'base64');
		fixtures['anime.gif'] = await readFile(new URL('../resources/anime.gif', import.meta.url));
		fixtures['anime.png'] = await readFile(new URL('../resources/anime.png', import.meta.url));
		fixtures['anime.webp'] = await sharp(fixtures['anime.gif'], { animated: true }).webp().toBuffer();
		fixtures['rotate.jpg'] = await readFile(new URL('../resources/rotate.jpg', import.meta.url));
	}, 120000);

	for (const name of ['plain.svg', 'xml.svg', 'doctype.svg', 'large.png', 'large.jpg', 'square.png', 'still.jxl', 'animated.jxl', 'anime.gif', 'anime.png', 'anime.webp', 'rotate.jpg']) {
		test(`upload and retrieve ${name}`, async () => {
			const res = await uploadFile(user, { blob: new Blob([new Uint8Array(fixtures[name])]), name });
			assert.equal(res.status, 200);
			assert.ok(res.body);
			assert.equal((await inspect(res.body.url)).status, 200);
			if (res.body.thumbnailUrl) assert.equal((await inspect(res.body.thumbnailUrl)).status, 200);
			const note = await post(user, { text: `fixture ${name}`, fileIds: [res.body.id] });
			assert.ok(note.files?.[0]);
			files[name] = note.files[0];
		});
	}

	for (const name of ['plain.svg', 'xml.svg', 'doctype.svg', 'still.jxl']) {
		test(`browser-safe public derivative required: ${name}`, async () => {
			const file = files[name];
			assert.ok(file, 'upload must succeed');
			const publicImage = await inspect(file.url);
			assert.ok(['image/webp', 'image/png'].includes(publicImage.type?.split(';')[0] ?? ''), `public content-type=${publicImage.type}`);
			assert.ok(publicImage.metadata);
			assert.ok(file.thumbnailUrl, 'thumbnail must exist');
			const thumbnail = await inspect(file.thumbnailUrl);
			assert.equal(thumbnail.type, 'image/webp');
		});
	}

	for (const [query, height] of [['emoji=1&static=1', 128], ['avatar=1&static=1', 320], ['static=1', 422], ['preview=1', 200]] as const) {
		test(`HTTP proxy dimensions: ${query}`, async () => {
			const url = `http://misskey.local/proxy/review?url=${encodeURIComponent(files['square.png'].url)}&${query}&origin=1`;
			const image = await inspect(url);
			assert.equal(image.status, 200);
			assert.equal(image.type, 'image/webp');
			assert.ok(image.metadata);
			assert.ok(image.metadata.height! <= height, JSON.stringify(image.metadata));
		});
	}

	for (const name of ['anime.gif', 'anime.webp', 'animated.jxl']) {
		test(`HTTP proxy preview is static: ${name}`, async () => {
			const url = `http://misskey.local/proxy/review?url=${encodeURIComponent(files[name].url)}&preview=1&origin=1`;
			const image = await inspect(url);
			assert.equal(image.status, 200);
			assert.equal(image.type, 'image/webp');
			assert.ok(image.metadata);
			assert.equal(image.metadata.pages ?? 1, 1, JSON.stringify(image.metadata));
			assert.ok(image.metadata.width! <= 200, JSON.stringify(image.metadata));
			assert.ok((image.metadata.pageHeight ?? image.metadata.height)! <= 200, JSON.stringify(image.metadata));
		});
	}

	for (const name of ['anime.gif', 'anime.webp', 'animated.jxl']) {
		test(`animated thumbnail retained: ${name}`, async () => {
			assert.ok(files[name].thumbnailUrl);
			const image = await inspect(files[name].thumbnailUrl!);
			assert.equal(image.type, 'image/webp');
			assert.ok(image.metadata && image.metadata.pages! > 1, JSON.stringify(image.metadata));
			assert.ok(image.metadata.width! <= 374);
			assert.ok(image.metadata.pageHeight! <= 317);
		});
	}

	test('animated JXL public derivative preserves all four frames', async () => {
		const image = await inspect(files['animated.jxl'].url);
		assert.equal(image.status, 200);
		assert.equal(image.type, 'image/webp');
		assert.equal(image.metadata?.pages, 4);
		assert.equal(image.metadata?.width, 50);
		assert.equal(image.metadata?.pageHeight, 80);
	});

	test('large PNG derivative is lossless and bounded', async () => {
		const image = await inspect(files['large.png'].url);
		assert.equal(image.status, 200);
		assert.equal(image.type, 'image/webp');
		assert.equal(image.metadata?.width, 2048);
		assert.equal(image.data.subarray(12, 16).toString(), 'VP8L');
	});

	test('HTTP proxy accepts XML SVG when MIME hint is supplied', async () => {
		const url = `http://misskey.local/proxy/review?url=${encodeURIComponent(files['xml.svg'].url)}&static=1&origin=1`;
		const image = await inspect(url);
		assert.equal(image.status, 200);
		assert.equal(image.type, 'image/webp');
		assert.equal(image.metadata?.height, 422);
	});

	test('JPEG EXIF orientation is resolved in thumbnail', async () => {
		const expected = await sharp(fixtures['rotate.jpg']).resize(498, 422, { fit: 'inside', withoutEnlargement: true }).rotate().toBuffer({ resolveWithObject: true });
		const image = await inspect(files['rotate.jpg'].thumbnailUrl!);
		assert.equal(image.metadata?.width, expected.info.width);
		assert.equal(image.metadata?.height, expected.info.height);
		assert.equal(image.metadata?.orientation, undefined);
	});
});
