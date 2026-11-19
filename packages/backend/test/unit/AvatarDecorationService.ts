/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { describe, beforeAll, beforeEach, test, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import * as Redis from 'ioredis';

import { MockResolver } from '../misc/mock-resolver.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DI } from '@/di-symbols.js';
import { LoggerService } from '@/core/LoggerService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import type { AvatarDecorationsRepository, UsersRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import { genAidx } from '@/misc/id/aidx.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';

function uniqueHost(): string {
	return `${secureRndstr(8).toLowerCase()}.test`;
}

describe('AvatarDecorationService', () => {
	let usersRepository: UsersRepository;
	let avatarDecorationsRepository: AvatarDecorationsRepository;
	let avatarDecorationService: AvatarDecorationService;
	let apRendererService: ApRendererService;
	let redisClient: Redis.Redis;
	let resolver: MockResolver;

	beforeAll(async () => {
		const app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
		}).compile();

		await app.init();
		app.enableShutdownHooks();

		usersRepository = app.get<UsersRepository>(DI.usersRepository);
		avatarDecorationsRepository = app.get<AvatarDecorationsRepository>(DI.avatarDecorationsRepository);
		avatarDecorationService = app.get<AvatarDecorationService>(AvatarDecorationService);
		apRendererService = app.get<ApRendererService>(ApRendererService);
		redisClient = app.get<Redis.Redis>(DI.redis);
		resolver = new MockResolver(await app.resolve<LoggerService>(LoggerService));
	});

	beforeEach(() => {
		resolver.clear();
	});

	async function createRemoteUser(host: string, decorationsUri: string | null = null): Promise<MiUser> {
		const un = secureRndstr(8).toLowerCase();
		const inserted = await usersRepository.insert({
			id: genAidx(Date.now()),
			username: un,
			usernameLower: un,
			host,
			uri: `https://${host}/users/${un}`,
			decorationsUri,
		});
		return await usersRepository.findOneByOrFail(inserted.identifiers[0]);
	}

	function decorationItem(host: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
		const un = secureRndstr(8).toLowerCase();
		return {
			type: 'Decoration',
			required_properties: [],
			image: {
				type: 'Image',
				url: `https://${host}/files/${un}.png`,
				name: 'deco name',
				summary: 'deco summary',
			},
			...overrides,
		};
	}

	describe('remoteDecorationsFromAp', () => {
		test('OrderedCollectionのinline項目を保存単位系(angleは回転比、offset/scaleは2倍基準)へ逆変換して取り込む', async () => {
			const host = uniqueHost();
			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;
			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				totalItems: 1,
				orderedItems: [
					decorationItem(host, {
						angle: Math.PI / 2,
						flipH: true,
						offsetX: 0.5,
						offsetY: -0.4,
						scale: 2,
						opacity: 0.5,
					}),
				],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('ok');

			const updated = await usersRepository.findOneByOrFail({ id: user.id });
			expect(updated.avatarDecorations).toHaveLength(1);
			const worn = updated.avatarDecorations[0];
			expect(worn.angle).toBeCloseTo(0.25);
			expect(worn.flipH).toBe(true);
			expect(worn.offsetX).toBeCloseTo(0.25);
			expect(worn.offsetY).toBeCloseTo(-0.2);
			expect(worn.scale).toBeCloseTo(1);
			expect(worn.opacity).toBeCloseTo(0.5);

			const decoration = await avatarDecorationsRepository.findOneByOrFail({ id: worn.id });
			expect(decoration.host).toBe(host);
			expect(decoration.name).toBe('deco name');
			expect(decoration.description).toBe('deco summary');
			expect(decoration.url).toBe(decoration.rawUrl);
		});

		test('範囲外の数値はi/updateの保存可能域へクランプし、angleは1周周期で正規化する', async () => {
			const host = uniqueHost();
			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;
			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				orderedItems: [
					decorationItem(host, {
						// angle = 3PI rad(1.5回転) -> 回転比1.5 -> 1周正規化で-0.5
						angle: Math.PI * 3,
						offsetX: -100,
						offsetY: 1000,
						scale: 10,
						opacity: 0,
					}),
				],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('ok');

			const updated = await usersRepository.findOneByOrFail({ id: user.id });
			expect(updated.avatarDecorations).toHaveLength(1);
			const worn = updated.avatarDecorations[0];
			expect(worn.angle).toBeCloseTo(-0.5);
			expect(worn.offsetX).toBeCloseTo(-0.25);
			expect(worn.offsetY).toBeCloseTo(0.25);
			expect(worn.scale).toBeCloseTo(1.5);
			expect(worn.opacity).toBeCloseTo(0.1);
		});

		test('不正な値を含む項目は例外にせずスキップし、後続の有効な項目は取り込まれる', async () => {
			const host = uniqueHost();
			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;
			const flipVItem = decorationItem(host, { required_properties: ['flipV'] });
			const nonArrayRequired = decorationItem(host, { required_properties: 'image' });
			const longUrlItem = decorationItem(host, {
				image: { type: 'Image', url: `https://${host}/files/${'a'.repeat(1100)}.png` },
			});
			const numericIdItem = decorationItem(host, { id: 12345 });
			const noteItem = { type: 'Note', name: 'not a decoration' };

			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				orderedItems: [flipVItem, nonArrayRequired, longUrlItem, numericIdItem, noteItem],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('ok');

			const updated = await usersRepository.findOneByOrFail({ id: user.id });
			expect(updated.avatarDecorations).toHaveLength(2);

			const decorations = await avatarDecorationsRepository.findBy({ host });
			expect(decorations).toHaveLength(2);
			expect(decorations.every(d => d.remoteId == null)).toBe(true);
		});

		test('firstページ参照形でもpartOf一致時に取り込み、不一致時はスキップする', async () => {
			const host = uniqueHost();
			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;

			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				totalItems: 1,
				first: `${decorationsUri}?page=true`,
			});
			resolver.register(`${decorationsUri}?page=true`, {
				id: `${decorationsUri}?page=true`,
				type: 'OrderedCollectionPage',
				partOf: decorationsUri,
				orderedItems: [decorationItem(host)],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('ok');
			const updated = await usersRepository.findOneByOrFail({ id: user.id });
			expect(updated.avatarDecorations).toHaveLength(1);

			// partOf不一致
			const user2 = await createRemoteUser(host);
			const decorationsUri2 = `${user2.uri}/collections/decorations`;
			resolver.register(decorationsUri2, {
				id: decorationsUri2,
				type: 'OrderedCollection',
				first: `${decorationsUri2}?page=true`,
			});
			resolver.register(`${decorationsUri2}?page=true`, {
				id: `${decorationsUri2}?page=true`,
				type: 'OrderedCollectionPage',
				partOf: 'https://evil.example/collections/other',
				orderedItems: [decorationItem(host)],
			});
			const result2 = await avatarDecorationService.remoteDecorationsFromAp({ ...user2, decorationsUri: decorationsUri2 }, resolver);
			expect(result2).toBe('skip: page partOf mismatch');
		});

		test('collection.idがユーザーoriginと異なる場合はスキップする', async () => {
			const host = uniqueHost();
			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;
			resolver.register(decorationsUri, {
				id: 'https://evil.example/collections/decorations',
				type: 'OrderedCollection',
				orderedItems: [decorationItem(host)],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('skip: collection origin mismatch');
		});

		test('collection.idが在るのに解決できない(数値id等)場合は例外にせずスキップする', async () => {
			const host = uniqueHost();
			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;
			resolver.register(decorationsUri, {
				id: 123,
				type: 'OrderedCollection',
				orderedItems: [decorationItem(host)],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('skip: invalid collection id');

			// 項目は処理されず定義行も作られない
			const decorations = await avatarDecorationsRepository.findBy({ host });
			expect(decorations).toHaveLength(0);
		});

		test('collection.idが相対URL(new URLが失敗)の場合はスキップする', async () => {
			const host = uniqueHost();
			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;
			resolver.register(decorationsUri, {
				id: '/collections/decorations',
				type: 'OrderedCollection',
				orderedItems: [decorationItem(host)],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('skip: invalid collection id');
		});

		test('page.partOfが在るのに解決できない場合はスキップする(コレクション所属を検証できない)', async () => {
			const host = uniqueHost();
			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;
			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				first: `${decorationsUri}?page=true`,
			});
			resolver.register(`${decorationsUri}?page=true`, {
				id: `${decorationsUri}?page=true`,
				type: 'OrderedCollectionPage',
				partOf: 123,
				orderedItems: [decorationItem(host)],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('skip: page partOf mismatch');
		});

		test('空のOrderedCollection配信で既存の装備は解除される(remoteの表示状態は配信側が正)', async () => {
			const host = uniqueHost();
			const decoration = await avatarDecorationsRepository.insertOne({
				id: genAidx(Date.now()),
				url: `https://${host}/files/preexisting.png`,
				rawUrl: `https://${host}/files/preexisting.png`,
				name: 'preexisting',
				description: '',
				host,
				remoteId: null,
			});
			const user = await createRemoteUser(host);
			await usersRepository.update(user.id, { avatarDecorations: [{ id: decoration.id }] });

			const decorationsUri = `${user.uri}/collections/decorations`;
			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				totalItems: 0,
				orderedItems: [],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('ok');
			const updated = await usersRepository.findOneByOrFail({ id: user.id });
			expect(updated.avatarDecorations).toEqual([]);
		});

		test('差分の無い既存定義行はUPDATEせず(updatedAt不変)、差分のある行のみUPDATEする', async () => {
			const host = uniqueHost();
			const imageUrl = `https://${host}/files/shared.png`;
			const itemId = `https://${host}/deco/abc`; // 32字以下 -> remoteIdとして保存される
			const fixedUpdatedAt = new Date('2026-01-01T00:00:00Z');
			const decoration = await avatarDecorationsRepository.insertOne({
				id: genAidx(Date.now()),
				url: imageUrl,
				rawUrl: imageUrl,
				name: 'shared',
				description: 'shared desc',
				updatedAt: fixedUpdatedAt,
				host,
				remoteId: itemId,
			});

			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;
			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				orderedItems: [
					{
						id: itemId,
						type: 'Decoration',
						required_properties: [],
						image: { type: 'Image', url: imageUrl, name: 'shared', summary: 'shared desc' },
					},
				],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('ok');

			const afterNoChange = await avatarDecorationsRepository.findOneByOrFail({ id: decoration.id });
			expect(afterNoChange.updatedAt?.getTime()).toBe(fixedUpdatedAt.getTime());

			// 定義側の名前が変わればUPDATEがかかる
			resolver.clear();
			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				orderedItems: [
					{
						id: itemId,
						type: 'Decoration',
						required_properties: [],
						image: { type: 'Image', url: imageUrl, name: 'shared-renamed', summary: 'shared desc' },
					},
				],
			});
			const user2 = await createRemoteUser(host, decorationsUri);
			await avatarDecorationService.remoteDecorationsFromAp(user2, resolver);
			const afterChanged = await avatarDecorationsRepository.findOneByOrFail({ id: decoration.id });
			expect(afterChanged.name).toBe('shared-renamed');
			expect(afterChanged.updatedAt?.getTime()).toBeGreaterThan(fixedUpdatedAt.getTime());
		});
	});

	describe('renderDecorations', () => {
		test('保存単位系をAP配信単位系(radian・アイコン基準)へ変換し、受信側で逆変換すると往復一致する', async () => {
			const decoration = await avatarDecorationsRepository.insertOne({
				id: genAidx(Date.now()),
				url: 'https://self.example/files/local.png',
				rawUrl: 'https://self.example/files/local.png',
				name: 'local deco',
				description: 'local desc',
				host: null,
				remoteId: null,
			});
			avatarDecorationService.cache.delete();

			const un = secureRndstr(8).toLowerCase();
			const inserted = await usersRepository.insert({
				id: genAidx(Date.now()),
				username: un,
				usernameLower: un,
				host: null,
				avatarDecorations: [{
					id: decoration.id,
					angle: 0.25,
					flipH: true,
					offsetX: 0.25,
					offsetY: -0.25,
					scale: 1.2,
					opacity: 0.5,
				}],
			});
			const localUser = await usersRepository.findOneByOrFail(inserted.identifiers[0]);

			const rendered = await apRendererService.renderDecorations(localUser);
			expect(rendered).toHaveLength(1);
			const item = rendered[0];
			expect(item.type).toBe('Decoration');
			expect((item.image as { url: string }).url).toBe('https://self.example/files/local.png');
			expect(item.angle).toBeCloseTo(0.25 * Math.PI * 2);
			expect(item.flipH).toBe(true);
			expect(item.offsetX).toBeCloseTo(0.5);
			expect(item.offsetY).toBeCloseTo(-0.5);
			expect(item.scale).toBeCloseTo(2.4);
			expect(item.opacity).toBeCloseTo(0.5);

			// 配信形をそのまま取り込むと保存単位系へ逆変換される(往復一致)
			const host = uniqueHost();
			const remoteUser = await createRemoteUser(host);
			const decorationsUri = `${remoteUser.uri}/collections/decorations`;
			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				orderedItems: [item],
			});
			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...remoteUser, decorationsUri }, resolver);
			expect(result).toBe('ok');

			const updated = await usersRepository.findOneByOrFail({ id: remoteUser.id });
			expect(updated.avatarDecorations).toHaveLength(1);
			const worn = updated.avatarDecorations[0];
			expect(worn.angle).toBeCloseTo(0.25);
			expect(worn.flipH).toBe(true);
			expect(worn.offsetX).toBeCloseTo(0.25);
			expect(worn.offsetY).toBeCloseTo(-0.25);
			expect(worn.scale).toBeCloseTo(1.2);
			expect(worn.opacity).toBeCloseTo(0.5);
		});
	});

	describe('cleanUnusedRemoteDecorations', () => {
		const cleanupKey = 'avatarDecorationCleanup:hosts';
		const oldTs = Date.now() - 1000 * 60 * 60 * 24 * 8;

		async function insertDecorationRow(opts: { createdAt: number, host: string | null }): Promise<{ id: string }> {
			const un = secureRndstr(8).toLowerCase();
			return await avatarDecorationsRepository.insertOne({
				id: genAidx(opts.createdAt),
				url: `https://${opts.host ?? 'local.example'}/files/${un}.png`,
				rawUrl: `https://${opts.host ?? 'local.example'}/files/${un}.png`,
				name: 'gc deco',
				description: '',
				host: opts.host,
				remoteId: null,
			});
		}

		test('マーク済みホストのうち7日超でどのユーザーからも参照されていないremote行のみ削除し、使用中・作成直後・local行は残す', async () => {
			await redisClient.del(cleanupKey);
			const host = uniqueHost();

			const wornRow = await insertDecorationRow({ createdAt: oldTs, host });
			const orphanRow = await insertDecorationRow({ createdAt: oldTs, host });
			const recentOrphanRow = await insertDecorationRow({ createdAt: Date.now(), host });
			const localRow = await insertDecorationRow({ createdAt: oldTs, host: null });

			// 誰か1人でも参照している共有定義行は削除対象外
			const user = await createRemoteUser(host);
			await usersRepository.update({ id: user.id }, {
				avatarDecorations: [{ id: wornRow.id }],
			});

			await redisClient.sadd(cleanupKey, host);
			const deletedCount = await avatarDecorationService.cleanUnusedRemoteDecorations();
			expect(deletedCount).toBeGreaterThanOrEqual(1);

			expect(await avatarDecorationsRepository.exists({ where: { id: orphanRow.id } })).toBe(false);
			expect(await avatarDecorationsRepository.exists({ where: { id: wornRow.id } })).toBe(true);
			expect(await avatarDecorationsRepository.exists({ where: { id: recentOrphanRow.id } })).toBe(true);
			expect(await avatarDecorationsRepository.exists({ where: { id: localRow.id } })).toBe(true);
		});

		test('取り込み成功でマークされたホストはコレクション項目除去後の孤児行を後から削除できる(定義行自身は更新されないケース)', async () => {
			await redisClient.del(cleanupKey);
			const host = uniqueHost();
			const staleRow = await insertDecorationRow({ createdAt: oldTs, host });

			const user = await createRemoteUser(host);
			await usersRepository.update({ id: user.id }, {
				avatarDecorations: [{ id: staleRow.id }],
			});

			// 取り込み成功を模擬してホストをマークし、参照だけを外す(定義行は updatedAt を含む更新を受けない)
			await redisClient.sadd(cleanupKey, host);
			await usersRepository.update({ id: user.id }, { avatarDecorations: [] });

			const deletedCount = await avatarDecorationService.cleanUnusedRemoteDecorations();
			expect(deletedCount).toBeGreaterThanOrEqual(1);
			expect(await avatarDecorationsRepository.exists({ where: { id: staleRow.id } })).toBe(false);
			// 未参照行が残っていないホストは再マークされない
			expect(await redisClient.smembers(cleanupKey)).not.toContain(host);
		});

		test('変更の無い(マークのない)ホストは7日超の孤児行でも削除しない', async () => {
			await redisClient.del(cleanupKey);
			const host = uniqueHost();
			const orphanRow = await insertDecorationRow({ createdAt: oldTs, host });

			const deletedCount = await avatarDecorationService.cleanUnusedRemoteDecorations();
			expect(deletedCount).toBe(0);
			expect(await avatarDecorationsRepository.exists({ where: { id: orphanRow.id } })).toBe(true);
		});

		test('保持期間内の未参照行が残るホストは次回以降のために再マークされる', async () => {
			await redisClient.del(cleanupKey);
			const host = uniqueHost();
			const recentOrphanRow = await insertDecorationRow({ createdAt: Date.now(), host });

			await redisClient.sadd(cleanupKey, host);
			const deletedCount = await avatarDecorationService.cleanUnusedRemoteDecorations();
			expect(deletedCount).toBe(0);
			expect(await avatarDecorationsRepository.exists({ where: { id: recentOrphanRow.id } })).toBe(true);
			expect(await redisClient.smembers(cleanupKey)).toContain(host);
			await redisClient.del(cleanupKey);
		});

		test('idを持たない要素を含むavatarDecorationsがあっても孤児削除が空集合にならない', async () => {
			await redisClient.del(cleanupKey);
			const host = uniqueHost();
			const orphanRow = await insertDecorationRow({ createdAt: oldTs, host });

			// idキーの無い要素は ->> 'id' がNULLになり、NULL除外ガードが無ければNOT IN全体がunknownで空集合になり孤児行が消えない。
			// 参考情報としてのNULLと、失敗経路でidが''になった空文字エントリを混ぜておく
			const user = await createRemoteUser(host);
			await usersRepository.update({ id: user.id }, {
				avatarDecorations: [{} as { id: string }, { id: '' }],
			});

			await redisClient.sadd(cleanupKey, host);
			const deletedCount = await avatarDecorationService.cleanUnusedRemoteDecorations();
			expect(await avatarDecorationsRepository.exists({ where: { id: orphanRow.id } })).toBe(false);
			expect(deletedCount).toBeGreaterThanOrEqual(1);
		});
	});
});
