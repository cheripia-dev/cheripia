/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { describe, beforeAll, beforeEach, test, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import * as Redis from 'ioredis';
import type { DataSource } from 'typeorm';

import { MockResolver } from '../misc/mock-resolver.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DI } from '@/di-symbols.js';
import { LoggerService } from '@/core/LoggerService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import type { AvatarDecorationsRepository, InstancesRepository, UsersRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import { genAidx } from '@/misc/id/aidx.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';

function uniqueHost(): string {
	return `${secureRndstr(8).toLowerCase()}.test`;
}

describe('AvatarDecorationService', () => {
	let usersRepository: UsersRepository;
	let avatarDecorationsRepository: AvatarDecorationsRepository;
	let instancesRepository: InstancesRepository;
	let avatarDecorationService: AvatarDecorationService;
	let apRendererService: ApRendererService;
	let httpRequestService: HttpRequestService;
	let redisClient: Redis.Redis;
	let resolver: MockResolver;
	let db: DataSource;

	beforeAll(async () => {
		const app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
		}).compile();

		await app.init();
		app.enableShutdownHooks();

		usersRepository = app.get<UsersRepository>(DI.usersRepository);
		avatarDecorationsRepository = app.get<AvatarDecorationsRepository>(DI.avatarDecorationsRepository);
		instancesRepository = app.get<InstancesRepository>(DI.instancesRepository);
		avatarDecorationService = app.get<AvatarDecorationService>(AvatarDecorationService);
		apRendererService = app.get<ApRendererService>(ApRendererService);
		httpRequestService = app.get<HttpRequestService>(HttpRequestService);
		redisClient = app.get<Redis.Redis>(DI.redis);
		resolver = new MockResolver(await app.resolve<LoggerService>(LoggerService));
		db = app.get<DataSource>(DI.db);
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

		test('文字列URI項目の解決失敗が1件でもある場合は更新全体をスキップし既存装備を保持する(部分結果で上書きしない)', async () => {
			const host = uniqueHost();
			const decoration = await avatarDecorationsRepository.insertOne({
				id: genAidx(Date.now()),
				url: `https://${host}/files/equipped.png`,
				rawUrl: `https://${host}/files/equipped.png`,
				name: 'equipped',
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
				orderedItems: [
					decorationItem(host), // 有効なinline項目
					`https://${host}/deco/unresolvable`, // mock未登録 -> 解決失敗
				],
			});

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('skip: partial resolve failed');

			// 装備は保持され、解決成功分だけの部分結果で上書きされない
			const updated = await usersRepository.findOneByOrFail({ id: user.id });
			expect(updated.avatarDecorations).toEqual([{ id: decoration.id }]);

			// 1st passがDB書き込みより前なので、有効なinline項目も定義行として作られない(孤児行が発生しない)
			const decorations = await avatarDecorationsRepository.findBy({ host });
			expect(decorations).toHaveLength(1);
			expect(decorations[0].id).toBe(decoration.id);
		});

		test('文字列URI項目がすべて解決できる場合は従来どおりokで取り込まれる', async () => {
			const host = uniqueHost();
			const user = await createRemoteUser(host);
			const decorationsUri = `${user.uri}/collections/decorations`;
			const referencedUrl = `https://${host}/deco/referenced`;
			resolver.register(decorationsUri, {
				id: decorationsUri,
				type: 'OrderedCollection',
				orderedItems: [
					decorationItem(host),
					referencedUrl,
				],
			});
			resolver.register(referencedUrl, decorationItem(host));

			const result = await avatarDecorationService.remoteDecorationsFromAp({ ...user, decorationsUri }, resolver);
			expect(result).toBe('ok');

			const updated = await usersRepository.findOneByOrFail({ id: user.id });
			expect(updated.avatarDecorations).toHaveLength(2);
		});
	});

	describe('remoteDecorationsFromApの定義行重複排除', () => {
		// テストDBのスキーマはsynchronizeで構築されるため、ハンドメイドの式インデックスは存在しない。
		// このテスト内でのみ、テスト用hostに限定したUNIQUE式インデックスを作成して
		// 本番のON CONFLICT DO NOTHINGと同じ挙動を再現し、後片付けで削除する
		// (hostはsecureRndstr由来の英数と'.test'のみで構成されるのでリテラル埋め込みは安全)
		test('同一hostで同じ画像URLを並行取り込みすると定義行が1行に収束する', async () => {
			const host = uniqueHost();
			const indexName = `test_uq_ad_host_raw_md5_${secureRndstr(6).toLowerCase()}`;
			await avatarDecorationsRepository.query(`CREATE UNIQUE INDEX "${indexName}" ON "avatar_decoration" ("host", md5("rawUrl")) WHERE "host" = '${host}'`);

			try {
				const imageUrl = `https://${host}/files/shared.png`;
				const userA = await createRemoteUser(host);
				const userB = await createRemoteUser(host);
				const uriA = `${userA.uri}/collections/decorations`;
				const uriB = `${userB.uri}/collections/decorations`;
				for (const uri of [uriA, uriB]) {
					resolver.register(uri, {
						id: uri,
						type: 'OrderedCollection',
						orderedItems: [decorationItem(host, {
							image: { type: 'Image', url: imageUrl, name: 'shared deco', summary: 'shared desc' },
						})],
					});
				}

				// 同一hostの2ユーザーが同じ画像URLを同時に取り込む。定義行は(host, rawUrl)で共有されるため
				// 後発は自前の行を作らず先発の行を参照し、1行に収束する
				// (先発のコミット前にSELECTが走る場面=ON CONFLICT DO NOTHINGが必要な場面は下のSQL検証で確認する)
				const results = await Promise.all([
					avatarDecorationService.remoteDecorationsFromAp({ ...userA, decorationsUri: uriA }, resolver),
					avatarDecorationService.remoteDecorationsFromAp({ ...userB, decorationsUri: uriB }, resolver),
				]);
				expect(results).toEqual(['ok', 'ok']);

				const rows = await avatarDecorationsRepository.findBy({ host });
				expect(rows).toHaveLength(1);

				for (const userId of [userA.id, userB.id]) {
					const updated = await usersRepository.findOneByOrFail({ id: userId });
					expect(updated.avatarDecorations).toHaveLength(1);
					expect(updated.avatarDecorations[0].id).toBe(rows[0].id);
				}
			} finally {
				await avatarDecorationsRepository.query(`DROP INDEX IF EXISTS "${indexName}"`);
			}
		});

		// (host, rawUrl)の重複作成を防ぐ仕組みそのものを検証する。
		// check-then-insertの競合窓は「後発のSELECTが先発の行を見ないが、後発のINSERTは先発の行と実衝突する」
		// という同時実行でしか起きないので、アプリと同じREAD COMMITTEDのトランザクションで
		// SELECT(既存なし) -> 別接続の挿入コミット -> INSERT の順を確定させて再現する
		test('後発のSELECTが見えない先行行への挿入は、ON CONFLICTなしだとunique_violationになりON CONFLICT DO NOTHINGなら0行で無視される', async () => {
			const host = uniqueHost();
			const indexName = `test_uq_ad_host_raw_md5_${secureRndstr(6).toLowerCase()}`;
			const rawUrl = `https://${host}/files/dup.png`;
			await avatarDecorationsRepository.query(`CREATE UNIQUE INDEX "${indexName}" ON "avatar_decoration" ("host", md5("rawUrl")) WHERE "host" = '${host}'`);

			const findSql = `SELECT "id" FROM "avatar_decoration" WHERE "host" = $1 AND md5("rawUrl") = md5($2)`;
			const insertSql = `INSERT INTO "avatar_decoration" ("id", "url", "name", "description", "host", "rawUrl") VALUES ($1, $2, $3, $4, $5, $6)`;

			const runner = db.createQueryRunner();
			await runner.connect();
			try {
				await runner.startTransaction();
				// 先発の行が無い時点で定義行検索(check-then-insertのSELECT)が走る
				expect(await runner.query(findSql, [host, rawUrl])).toHaveLength(0);

				// その後に別接続(他のワーカー相当)が同じ(host, rawUrl)の行をコミットする
				await avatarDecorationsRepository.insertOne({
					id: genAidx(Date.now()),
					url: rawUrl,
					rawUrl,
					name: 'gc deco',
					description: '',
					host,
					remoteId: null,
				});

				// 1つの文の失敗でトランザクション全体がabortedになると後続の文が打てないため、
				// 失敗させる検証はSAVEPOINTで囲む
				await runner.query('SAVEPOINT check_plain_insert');
				let plainInsertErrorCode: string | undefined;
				try {
					// ON CONFLICTなし(check-then-insertのINSERT)はunique_violationで、アクター更新が例外終了する
					await runner.query(insertSql, [genAidx(Date.now()), rawUrl, rawUrl, 'gc deco', host, rawUrl]);
				} catch (e) {
					plainInsertErrorCode = (e as { driverError?: { code?: string } }).driverError?.code;
				}
				await runner.query('ROLLBACK TO SAVEPOINT check_plain_insert');
				expect(plainInsertErrorCode).toBe('23505');

				// ヘルパー(createRemoteDecorationIfAbsent)と同じ挿入形は例外を投げず、行も増えない
				const ignored = await runner.query(`${insertSql} ON CONFLICT DO NOTHING RETURNING "id"`, [genAidx(Date.now()), rawUrl, rawUrl, 'gc deco', host, rawUrl]);
				expect(ignored).toHaveLength(0);

				// READ COMMITTEDのステートメントスナップショットなので、ヘルパーの再検索は先発の行を取得できる
				expect(await runner.query(findSql, [host, rawUrl])).toHaveLength(1);

				await runner.rollbackTransaction();
			} finally {
				// 検証側で例外になるとプール接続がabortedトランザクションのまま返却され、
				// 後続テストが全滅するため必ずロールバックしてから解放する
				await runner.rollbackTransaction().catch(() => {});
				await runner.release();
				await avatarDecorationsRepository.query(`DROP INDEX IF EXISTS "${indexName}"`);
				await avatarDecorationsRepository.delete({ host });
			}
		});
	});

	describe('remoteUserUpdate(旧API方式)の定義行更新', () => {
		// テストDBのスキーマはsynchronizeで構築されるため(host, md5(rawUrl))のUNIQUE式インデックスが無く、
		// 既存行のrawUrl更新がunique_violationになる窓を再現できない。上の重複排除テストと同じく
		// テスト用hostに限定したUNIQUE式インデックスを一時的に作って本番の制約を再現し、後片付けで削除する
		test('remoteId違いで同じ画像URLの行が既に存在する定義更新は、unique_violationで同期を止めず既存行へ集約される', async () => {
			const host = uniqueHost();
			const indexName = `test_uq_ad_host_raw_md5_${secureRndstr(6).toLowerCase()}`;
			await avatarDecorationsRepository.query(`CREATE UNIQUE INDEX "${indexName}" ON "avatar_decoration" ("host", md5("rawUrl")) WHERE "host" = '${host}'`);

			try {
				// 旧API方式が走る条件: インスタンスが対応ソフトとして登録済みで、ユーザーのdecorationsUriが無い
				await instancesRepository.insertOne({
					id: genAidx(Date.now()),
					firstRetrievedAt: new Date(),
					host,
					softwareName: 'misskey',
				});
				const user = await createRemoteUser(host);

				const url1 = `https://${host}/files/u1.png`;
				const url2 = `https://${host}/files/u2.png`;
				const insertRow = async (remoteId: string, rawUrl: string): Promise<{ id: string }> =>
					avatarDecorationsRepository.insertOne({
						id: genAidx(Date.now()),
						url: rawUrl,
						rawUrl,
						name: `deco ${remoteId}`,
						description: '',
						host,
						remoteId,
					});
				// 同一hostの既存行B(remoteId=b, rawUrl=url2)と同じURLで、行A(remoteId=a, rawUrl=url1)を上書きする場面を再現する
				const rowA = await insertRow('a', url1);
				const rowB = await insertRow('b', url2);

				// /api/users/show は「AのURLがu2へ変更された」応答、/api/get-avatar-decorations は定義一覧を返す
				const sendSpy = vi.spyOn(httpRequestService, 'send').mockImplementation(async (url: string) => {
					const body = url.includes('/api/users/show')
						? { avatarDecorations: [{ id: 'a', url: url2, angle: 0, flipH: false, offsetX: 0, offsetY: 0, scale: 1, opacity: 1 }] }
						: [{ id: 'a', name: 'deco a', description: 'desc a' }];
					return { json: async () => body } as never;
				});

				try {
					const result = await avatarDecorationService.remoteUserUpdate(user);
					expect(result).toBe('ok');

					// ユーザーは衝突相手の既存行Bを参照し、行BのremoteIdは上書きされない
					const updatedUser = await usersRepository.findOneByOrFail({ id: user.id });
					expect(updatedUser.avatarDecorations.map(x => x.id)).toEqual([rowB.id]);

					// 行Aは元のrawUrlのまま残る(UNIQUE違反でUPDATEが中断され、既存行Bへ集約された結果)
					const afterA = await avatarDecorationsRepository.findOneByOrFail({ id: rowA.id });
					expect(afterA.rawUrl).toBe(url1);
					const afterB = await avatarDecorationsRepository.findOneByOrFail({ id: rowB.id });
					expect(afterB.remoteId).toBe('b');
				} finally {
					sendSpy.mockRestore();
				}
			} finally {
				await avatarDecorationsRepository.query(`DROP INDEX IF EXISTS "${indexName}"`);
				await avatarDecorationsRepository.delete({ host });
				await instancesRepository.delete({ host });
			}
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

		test('マーク済みホストが0件の実行は、参照id集合のmaterialize(ユーザーテーブル全走査)を行わずに0を返す', async () => {
			await redisClient.del(cleanupKey);
			// 削除対象になりそうな7日超の孤児行を作っても、ホストにマークが無ければmaterialize自体が走らない
			const host = uniqueHost();
			await insertDecorationRow({ createdAt: oldTs, host });

			// 正常終了する実行は後片付けでヘルパーテーブルをDROPするため、materializeの有無は
			// createQueryRunnerが呼ばれるかどうかで確認する(early returnではrunnerを作らない)
			const runnerSpy = vi.spyOn(db, 'createQueryRunner');
			try {
				const deletedCount = await avatarDecorationService.cleanUnusedRemoteDecorations();
				expect(deletedCount).toBe(0);
				expect(runnerSpy).not.toHaveBeenCalled();
			} finally {
				runnerSpy.mockRestore();
			}
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

		test('参照id展開がチャンク境界をまたいでも正しい: 先頭/中間/末尾チャンクの参照行は残り共有行も残り孤児行は消える', async () => {
			await redisClient.del(cleanupKey);
			const host = uniqueHost();

			// チャンクを必ずまたぐ分页を強制する(7ユーザー×チャンク3=3チャンク)
			const originalChunkSize = avatarDecorationService.cleanupReferencedChunkUsers;
			avatarDecorationService.cleanupReferencedChunkUsers = 3;
			try {
				const users: MiUser[] = [];
				for (let i = 0; i < 7; i++) users.push(await createRemoteUser(host));

				// ユーザーidは生成順に単調増加なので users[0]=1チャンク目、users[3]=2チャンク目、users[6]=3チャンク目
				const firstChunkRow = await insertDecorationRow({ createdAt: oldTs, host });
				const midChunkRow = await insertDecorationRow({ createdAt: oldTs, host });
				const lastChunkRow = await insertDecorationRow({ createdAt: oldTs, host });
				const orphanRow = await insertDecorationRow({ createdAt: oldTs, host });

				await usersRepository.update({ id: users[0].id }, { avatarDecorations: [{ id: firstChunkRow.id }] });
				// 1チャンク目と3チャンク目にまたがって共有される行(ON CONFLICT DO NOTHINGで重複排除される)
				await usersRepository.update({ id: users[6].id }, { avatarDecorations: [{ id: firstChunkRow.id }, { id: lastChunkRow.id }] });
				await usersRepository.update({ id: users[3].id }, { avatarDecorations: [{ id: midChunkRow.id }] });

				await redisClient.sadd(cleanupKey, host);
				const deletedCount = await avatarDecorationService.cleanUnusedRemoteDecorations();

				expect(await avatarDecorationsRepository.exists({ where: { id: orphanRow.id } })).toBe(false);
				for (const row of [firstChunkRow, midChunkRow, lastChunkRow]) {
					expect(await avatarDecorationsRepository.exists({ where: { id: row.id } })).toBe(true);
				}
				expect(deletedCount).toBeGreaterThanOrEqual(1);
			} finally {
				avatarDecorationService.cleanupReferencedChunkUsers = originalChunkSize;
			}
		});
	});
});
