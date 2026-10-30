/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { MiUserKeypair } from '@/models/_.js';
import { api, initTestDb, post, relativeFetch, signup } from '../utils.js';
import type * as misskey from 'misskey-js';

const config = loadConfig();

async function fetchUserKeypair(db: DataSource, userId: string): Promise<MiUserKeypair> {
	const keypair = await db.getRepository(MiUserKeypair).findOneBy({ userId });
	assert.ok(keypair, 'keypair not found');
	return keypair;
}

async function signedApGet(
	path: string,
	keypair: MiUserKeypair,
	userId: string,
	hostHeader?: string,
) {
	const date = new Date().toUTCString();
	const host = hostHeader ?? config.host;
	const signingString = [
		`(request-target): get ${path}`,
		`date: ${date}`,
		`host: ${host}`,
	].join('\n');
	const signature = crypto.createSign('RSA-SHA256').update(signingString).sign(keypair.privateKey, 'base64');
	const signatureHeader = `keyId="${config.url}/users/${userId}/publickey",algorithm="rsa-sha256",headers="(request-target) date host",signature="${signature}"`;

	return await relativeFetch(path, {
		headers: {
			Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
			Date: date,
			Signature: signatureHeader,
			Host: host,
		},
		redirect: 'manual',
	});
}

describe('ActivityPub note endpoint', () => {
	let db: DataSource;
	let author: misskey.entities.SignupResponse;
	let follower: misskey.entities.SignupResponse;
	let followerKeypair: MiUserKeypair;

	beforeAll(async () => {
		db = await initTestDb(true);
		// author must be the first user so it becomes the root/admin user.
		author = await signup();
		follower = await signup();
		const metaRes = await api('admin/update-meta', { federation: 'all' }, author);
		assert.strictEqual(metaRes.status, 204);
		followerKeypair = await fetchUserKeypair(db, follower.id);
		await api('following/create', { userId: author.id }, follower);
	}, 1000 * 60 * 2);

	afterAll(async () => {
		await db.destroy();
	});

	test('public note has public Cache-Control', async () => {
		const note = await post(author, { text: 'public', visibility: 'public' });
		const res = await relativeFetch(`/notes/${note.id}`, {
			headers: { Accept: 'application/activity+json' },
			redirect: 'manual',
		});
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=180');
	});

	test('home note has public Cache-Control', async () => {
		const note = await post(author, { text: 'home', visibility: 'home' });
		const res = await relativeFetch(`/notes/${note.id}`, {
			headers: { Accept: 'application/activity+json' },
			redirect: 'manual',
		});
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=180');
	});

	test('followers-only note without auth returns 403', async () => {
		const note = await post(author, { text: 'followers', visibility: 'followers' });
		const res = await relativeFetch(`/notes/${note.id}`, {
			headers: { Accept: 'application/activity+json' },
			redirect: 'manual',
		});
		assert.strictEqual(res.status, 403);
	});

	test('specified note without auth returns 403', async () => {
		const note = await post(author, { text: 'specified', visibility: 'specified', visibleUserIds: [follower.id] });
		const res = await relativeFetch(`/notes/${note.id}`, {
			headers: { Accept: 'application/activity+json' },
			redirect: 'manual',
		});
		assert.strictEqual(res.status, 403);
	});

	test('followers-only note with local-user signed get is rejected', async () => {
		const note = await post(author, { text: 'followers signed', visibility: 'followers' });
		const res = await signedApGet(`/notes/${note.id}`, followerKeypair, follower.id);
		assert.strictEqual(res.status, 403);
	});

	test('followers-only note with mismatched Host header returns 403', async () => {
		const note = await post(author, { text: 'followers host', visibility: 'followers' });
		const res = await signedApGet(`/notes/${note.id}`, followerKeypair, follower.id, 'evil.test');
		assert.strictEqual(res.status, 403);
	});

	test('specified note with local-user signed get by visible user is rejected', async () => {
		const note = await post(author, { text: 'specified', visibility: 'specified', visibleUserIds: [follower.id] });
		const res = await signedApGet(`/notes/${note.id}`, followerKeypair, follower.id);
		assert.strictEqual(res.status, 403);
	});

	test('specified note with signed get by non-visible user returns 403', async () => {
		const note = await post(author, { text: 'specified hidden', visibility: 'specified', visibleUserIds: [author.id] });
		const res = await signedApGet(`/notes/${note.id}`, followerKeypair, follower.id);
		assert.strictEqual(res.status, 403);
	});
});
