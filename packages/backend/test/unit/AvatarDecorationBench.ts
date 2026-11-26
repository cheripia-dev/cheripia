/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// アバターデコレーションAPub受信(ap_decorationsブランチ)の規模ベンチマーク。
// 通常CIでは実行しない: 環境変数 DECORATION_BENCH=true のときだけ走る。
// 実行例: DECORATION_BENCH=true npx vitest run --config vitest.config.unit.ts test/unit/AvatarDecorationBench.ts
//
// スケール(コミットメッセージのベンチ再現): ユーザー10万、マーク済みホスト1000、
// 1ホストあたり定義行1500(うち400行は参照済み・1100行は孤児)= 定義行計150万、孤児計110万。

process.env.NODE_ENV = 'test';

import { describe, beforeAll, afterAll, test, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import * as Redis from 'ioredis';

import { MockResolver } from '../misc/mock-resolver.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DI } from '@/di-symbols.js';
import { LoggerService } from '@/core/LoggerService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { genAidx } from '@/misc/id/aidx.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { IsNull } from 'typeorm';
import type { AvatarDecorationsRepository, UsersRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import type { DataSource } from 'typeorm';

const HOSTS = 1000;
const ROWS_PER_HOST = 1500;
const REFERENCED_PER_HOST = 400;
const USERS = 100000;
const USERS_PER_HOST = USERS / HOSTS; // 100
const DECOS_PER_USER = REFERENCED_PER_HOST / USERS_PER_HOST; // 4
const TOTAL_ROWS = HOSTS * ROWS_PER_HOST;
const ORPHANS = HOSTS * (ROWS_PER_HOST - REFERENCED_PER_HOST);

const CLEANUP_HOSTS_REDIS_KEY = 'avatarDecorationCleanup:hosts';
const BENCH_HOST_SUFFIX = '.bench.test';
const HELPER_TABLE = 'gc_avatar_decoration_referenced_ids';

// 変更前の実装(be09e0de70^)の参照判定インライン副クエリ(NOT IN版)
const OLD_NOT_REFERENCED_SQL = `decoration."id" NOT IN (
	SELECT elem ->> 'id' FROM "user" "u", jsonb_array_elements("u"."avatarDecorations") AS elem
	WHERE (elem ->> 'id') IS NOT NULL
)`;

// 新方式の参照判定(サービス内定数と同じ形)
const NOT_REFERENCED_HELPER_SQL = `NOT EXISTS (SELECT 1 FROM "${HELPER_TABLE}" r WHERE r.id = decoration."id")`;

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
describe.runIf(process.env.DECORATION_BENCH === 'true')('AvatarDecorationBench: 100k users / 1000 hosts', () => {
	let db: DataSource;
	let usersRepository: UsersRepository;
	let avatarDecorationsRepository: AvatarDecorationsRepository;
	let avatarDecorationService: AvatarDecorationService;
	let apRendererService: ApRendererService;
	let globalEventService: GlobalEventService;
	let redisClient: Redis.Redis;
	let resolver: MockResolver;

	const benchHost = (i: number): string => `h${i}${BENCH_HOST_SUFFIX}`;
	const preOld = (): string => genAidx(Date.now() - 1000 * 60 * 60 * 24 * 10).slice(0, 8);

	const ms = (t0: number): string => `${((performance.now() - t0) / 1000).toFixed(2)}s`;

	async function seed(): Promise<void> {
		const runner = db.createQueryRunner();
		try {
			// 大量seedはStatementSerializerのstatement_timeoutを超えるためこの接続だけ無効化する
			await runner.query('SET statement_timeout = 0');
			await runner.query('SET maintenance_work_mem = \'512MB\'');
			await runner.query(`DELETE FROM avatar_decoration WHERE host LIKE '%${BENCH_HOST_SUFFIX}'`);
			await runner.query(`DELETE FROM "user" WHERE host LIKE '%${BENCH_HOST_SUFFIX}'`);
			// 本番マイグレーション(整理1795147371786 + UNIQUE作成1795698643579)と同一の式インデックス。
			// ベンチはsynchronizeのテストDBに手作りするのでUNIQUE外で作る(大量seedが衝突するため)
			await runner.query(`CREATE INDEX IF NOT EXISTS "IDX_avatar_decoration_host_raw_url_md5" ON "avatar_decoration" ("host", md5("rawUrl"))`);
			await runner.query(`
				CREATE OR REPLACE FUNCTION bench_b36n(n bigint) RETURNS text AS $$
				DECLARE v bigint := n; s text := ''; d bigint; digits text := '0123456789abcdefghijklmnopqrstuvwxyz';
				BEGIN
					IF v <= 0 THEN RETURN lpad('0', 8, '0'); END IF;
					WHILE v > 0 LOOP d := v % 36; s := substr(digits, (d + 1)::int, 1) || s; v := v / 36; END LOOP;
					RETURN lpad(s, 8, '0');
				END $$ LANGUAGE plpgsql`);
			const pre = preOld();
			const t0 = performance.now();
			await runner.query(`
				INSERT INTO avatar_decoration (id, "updatedAt", url, name, description, "remoteId", host, "rawUrl")
				SELECT '${pre}' || bench_b36n(n), now() - interval '10 days',
					'https://h' || (n / ${ROWS_PER_HOST}) || '${BENCH_HOST_SUFFIX}/deco/' || (n % ${ROWS_PER_HOST}) || '.png',
					'deco' || (n % ${ROWS_PER_HOST}), 'bench decoration', 'd' || n,
					'h' || (n / ${ROWS_PER_HOST}) || '${BENCH_HOST_SUFFIX}',
					'https://h' || (n / ${ROWS_PER_HOST}) || '${BENCH_HOST_SUFFIX}/deco/' || (n % ${ROWS_PER_HOST}) || '.png'
				FROM generate_series(0, ${TOTAL_ROWS - 1}) AS n`);
			const preNew = genAidx(Date.now()).slice(0, 8);
			await runner.query(`
				INSERT INTO "user" (id, "updatedAt", username, "usernameLower", host, "avatarDecorations")
				SELECT '${preNew}' || bench_b36n(n), now(), 'benchuser' || n, 'benchuser' || n,
					'h' || (n / ${USERS_PER_HOST}) || '${BENCH_HOST_SUFFIX}',
					(
						SELECT jsonb_agg(jsonb_build_object(
							'id', '${pre}' || bench_b36n((n / ${USERS_PER_HOST}) * ${ROWS_PER_HOST} + k),
							'angle', 0, 'flipH', false, 'offsetX', 0, 'offsetY', 0, 'scale', 1, 'opacity', 1))
						FROM generate_series((n % ${USERS_PER_HOST}) * ${DECOS_PER_USER}, (n % ${USERS_PER_HOST}) * ${DECOS_PER_USER} + ${DECOS_PER_USER - 1}) AS k
					)
				FROM generate_series(0, ${USERS - 1}) AS n`);
			await runner.query('ANALYZE avatar_decoration');
			await runner.query('ANALYZE "user"');
			console.log(`[seed] ${USERS} users, ${TOTAL_ROWS} decorations (${ORPHANS} orphans): ${ms(t0)}`);
		} finally {
			await runner.query('DROP FUNCTION IF EXISTS bench_b36n(bigint)');
			await runner.release();
		}
	}

	beforeAll(async () => {
		const app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
		}).compile();
		await app.init();
		app.enableShutdownHooks();

		db = app.get<DataSource>(DI.db);
		usersRepository = app.get<UsersRepository>(DI.usersRepository);
		avatarDecorationsRepository = app.get<AvatarDecorationsRepository>(DI.avatarDecorationsRepository);
		avatarDecorationService = app.get<AvatarDecorationService>(AvatarDecorationService);
		apRendererService = app.get<ApRendererService>(ApRendererService);
		globalEventService = app.get<GlobalEventService>(GlobalEventService);
		redisClient = app.get<Redis.Redis>(DI.redis);
		resolver = new MockResolver(await app.resolve<LoggerService>(LoggerService));

		await seed();
	}, 600000);

	afterAll(async () => {
		await redisClient.del(CLEANUP_HOSTS_REDIS_KEY);
	}, 600000);

	test('EXPLAIN: (host, md5(rawUrl))式インデックスの重複排除検索がIndex Scanになる', async () => {
		const rows = await db.query(`
			EXPLAIN (ANALYZE, BUFFERS)
			SELECT * FROM "avatar_decoration" decoration
			WHERE decoration.host = 'h0${BENCH_HOST_SUFFIX}'
			  AND md5(decoration."rawUrl") = md5('https://h0${BENCH_HOST_SUFFIX}/deco/7.png')`);
		const plan = rows.map((r: Record<string, string>) => Object.values(r)[0]).join('\n');
		console.log('[explain dedup]\n' + plan);
		expect(plan).toMatch(/Index Scan.*IDX_avatar_decoration_host_raw_url_md5|Index Only Scan/);
	}, 120000);

	test('計測: 参照id集合ヘルパーテーブルのmaterialize(100kユーザー全スキャン+jsonb展開、チャンク分割版)', async () => {
		const runner = db.createQueryRunner();
		try {
			await runner.query('SET statement_timeout = 0');
			await runner.query(`DROP TABLE IF EXISTS "${HELPER_TABLE}"`);
			await runner.query(`CREATE UNLOGGED TABLE "${HELPER_TABLE}" (id text PRIMARY KEY)`);
			// サービス実装と同じチャンク分割ループ(20kユーザー/チャンク)
			const CHUNK = 20000;
			const t0 = performance.now();
			const chunkTimes: number[] = [];
			let lastUserId = '';
			for (;;) {
				const c0 = performance.now();
				await runner.query(`
					INSERT INTO "${HELPER_TABLE}" (id)
					SELECT DISTINCT elem ->> 'id' FROM (
						SELECT "u"."avatarDecorations" FROM "user" "u"
						WHERE "u"."id" > $1 ORDER BY "u"."id" ASC LIMIT $2
					) chunk, jsonb_array_elements(chunk."avatarDecorations") AS elem
					WHERE (elem ->> 'id') IS NOT NULL
					ON CONFLICT DO NOTHING`, [lastUserId, CHUNK]);
				const next = await runner.query(`
					SELECT max("chunk"."id") AS "id" FROM (
						SELECT "u"."id" FROM "user" "u"
						WHERE "u"."id" > $1 ORDER BY "u"."id" ASC LIMIT $2
					) chunk`, [lastUserId, CHUNK]);
				chunkTimes.push(performance.now() - c0);
				if (next[0] == null || next[0].id == null) break;
				lastUserId = next[0].id;
			}
			const total = performance.now() - t0;
			const maxChunk = Math.max(...chunkTimes);
			console.log(`[helper materialize] ${USERS} users, chunks=${chunkTimes.length}(max ${maxChunk.toFixed(0)}ms), total=${(total / 1000).toFixed(2)}s`);
			console.log(`[helper materialize] statement_timeout(10s) margin: max chunk ${maxChunk.toFixed(0)}ms / 10000ms`);
			const [{ n }] = await runner.query(`SELECT count(*)::int AS n FROM "${HELPER_TABLE}"`);
			console.log(`[helper materialize] referenced ids: ${n}`);
			expect(n).toBe(REFERENCED_PER_HOST * HOSTS);
			expect(maxChunk).toBeLessThan(10000);

			// 新方式の孤児検索(ヘルパーテーブル反結合)がインデックス利用で定数時間相当になることを確認
			const cutoff = genAidx(Date.now() - 1000 * 60 * 60 * 24 * 7);
			const planRows = await runner.query(`
				EXPLAIN (ANALYZE, BUFFERS)
				SELECT decoration."id" FROM "avatar_decoration" "decoration"
				WHERE decoration."host" = 'h0${BENCH_HOST_SUFFIX}' AND decoration."id" < '${cutoff}'
				  AND ${NOT_REFERENCED_HELPER_SQL}
				ORDER BY decoration."id" ASC LIMIT 500`);
			console.log('[explain new orphan select]\n' + planRows.map((r: Record<string, string>) => Object.values(r)[0]).join('\n'));
		} finally {
			await runner.query(`DROP TABLE IF EXISTS "${HELPER_TABLE}"`);
			await runner.release();
		}
	}, 600000);

	test('計測: 変更前のインライン副クエリ方式(NOT IN全スキャン)を3ホストで実測し5000クエリへ外挿', async () => {
		// 本番と同じ旧SQL(変更前 be09e0de70^ の NOT IN版)を生SQLで再現。
		// プールのstatement_timeout(10s)で切られると実速度を測れないため専用コネクションで測る
		const runner = db.createQueryRunner();
		try {
			await runner.query('SET statement_timeout = 0');
			const cutoff = genAidx(Date.now() - 1000 * 60 * 60 * 24 * 7);
			const times: number[] = [];
			for (let i = 0; i < 3; i++) {
				const t0 = performance.now();
				const rows = await runner.query(`
					SELECT decoration."id" FROM "avatar_decoration" "decoration"
					WHERE decoration."host" = $1 AND decoration."id" < $2
					  AND ${OLD_NOT_REFERENCED_SQL}
					ORDER BY decoration."id" ASC LIMIT 500`,
				[benchHost(i), cutoff]);
				const dt = performance.now() - t0;
				times.push(dt);
				console.log(`[old inline] host=${benchHost(i)} rows=${rows.length} ${dt.toFixed(0)}ms`);
				expect(rows.length).toBe(500);
			}
			const avg = times.reduce((a, b) => a + b, 0) / times.length;
			// 新方式と同じクエリ数: 1ホスト(3バッチ+空振り1+残存確認1)=5 × 1000ホスト = 5000クエリ
			const queries = HOSTS * 5;
			console.log(`[old inline subquery] avg ${avg.toFixed(0)}ms/query × ${queries} queries -> 推定 ${(avg * queries / 1000 / 60).toFixed(1)}min`);
		} finally {
			await runner.release();
		}
	}, 900000);

	test('計測: cleanUnusedRemoteDecorations() 実サービス1実行(マーク済み1000ホスト/孤児110万行)', async () => {
		// publishInternalEventは1.1M件発火するため、DELETE/SELECTとの内訳把握用にper-件コストを先に測る
		const P = 10000;
		const tP = performance.now();
		for (let i = 0; i < P; i++) {
			globalEventService.publishInternalEvent('avatarDecorationDeleted', null as never);
		}
		const perPublish = (performance.now() - tP) / P;
		console.log(`[publish] publishInternalEvent fire-and-forget: 平均 ${perPublish.toFixed(3)}ms/call -> 1.1M件で推定 ${(perPublish * ORPHANS / 1000).toFixed(0)}s`);

		const hosts = Array.from({ length: HOSTS }, (_, i) => benchHost(i));
		await redisClient.del(CLEANUP_HOSTS_REDIS_KEY);
		await redisClient.sadd(CLEANUP_HOSTS_REDIS_KEY, ...hosts);

		const t0 = performance.now();
		const deleted = await avatarDecorationService.cleanUnusedRemoteDecorations();
		const wall = performance.now() - t0;
		console.log(`[clean job] deleted=${deleted}, wall=${(wall / 1000).toFixed(2)}s`);
		expect(deleted).toBe(ORPHANS);

		// 残存: 参照中の400行/host × 1000ホストだけ
		const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM avatar_decoration WHERE host LIKE '%${BENCH_HOST_SUFFIX}'`);
		expect(n).toBe(REFERENCED_PER_HOST * HOSTS);

		// 保持期間内の行が無いので再マークされない
		const remaining = await redisClient.scard(CLEANUP_HOSTS_REDIS_KEY);
		expect(remaining).toBe(0);
	}, 1800000);

	test('計測: remoteDecorationsFromAp 取り込み(150万行/1500行・host環境での8項目、差分なし経路と作成経路)', async () => {
		const host = benchHost(0); // 定義行1500件のホスト(インデックス適用済み)
		const uriBase = `https://${host}/users/bench-import`;
		const un = `benchimport${secureRndstr(6).toLowerCase()}`;
		await usersRepository.insert({
			id: genAidx(Date.now()),
			username: un,
			usernameLower: un,
			host,
			uri: `${uriBase}`,
			decorationsUri: `${uriBase}/collections/decorations`,
		});
		const user: MiUser = await usersRepository.findOneByOrFail({ usernameLower: un, host });

		// 差分なし経路: 既存行(j=0..5)と完全一致するinline項目 + 新規2行(初回のみ作成、以降は差分なし)
		const items = Array.from({ length: 6 }, (_, j) => ({
			type: 'Decoration',
			required_properties: [],
			image: {
				type: 'Image',
				url: `https://${host}/deco/${j}.png`,
				name: `deco${j}`,
				summary: 'bench decoration',
			},
			id: `d${j}`,
		}));
		const newUrl = (k: number): string => `https://${host}/files/benchnew${k}.png`;
		resolver.register(`${user.decorationsUri}`, {
			id: `${user.decorationsUri}`,
			type: 'OrderedCollection',
			totalItems: 8,
			orderedItems: [
				...items,
				{ type: 'Decoration', required_properties: [], image: { type: 'Image', url: newUrl(0), name: 'new0', summary: '' }, id: 'new0' },
				{ type: 'Decoration', required_properties: [], image: { type: 'Image', url: newUrl(1), name: 'new1', summary: '' }, id: 'new1' },
			],
		});

		// 初回: 8項目分のmd5検索 + 2行作成 + ユーザー更新
		const tCreate0 = performance.now();
		expect(await avatarDecorationService.remoteDecorationsFromAp(user, resolver)).toBe('ok');
		console.log(`[ingest] 初回(8項目): ${(performance.now() - tCreate0).toFixed(1)}ms`);

		// 2回目以降: 全行既存・差分なし = 定期再取り込みの定常状態
		const t1 = performance.now();
		const N = 100;
		for (let i = 0; i < N; i++) {
			expect(await avatarDecorationService.remoteDecorationsFromAp(user, resolver)).toBe('ok');
		}
		const steady = (performance.now() - t1) / N;
		console.log(`[ingest] 定常(差分なし8項目): 平均 ${steady.toFixed(1)}ms/call -> ${Math.round(1000 / steady)} users/sec 単一プロセス`);
	}, 300000);

	test('計測: renderDecorations 配信側シリアライズ(ローカルユーザー/4参照、10k呼出し)', async () => {
		// 配信側はローカルユーザーのみ。getAll('local')キャッシュに載る規模で測る
		const localDecos = await Promise.all(Array.from({ length: 4 }, async (_, j) =>
			avatarDecorationsRepository.insertOne({
				id: genAidx(Date.now()),
				url: `https://local.bench.test/deco/${j}.png`,
				rawUrl: null,
				name: `localdeco${j}`,
				description: 'local bench',
				roleIdsThatCanBeUsedThisDecoration: [],
				category: null,
				remoteId: null,
				host: null,
				updatedAt: new Date(),
			})));
		const un = `benchlocal${secureRndstr(6).toLowerCase()}`;
		await usersRepository.insert({
			id: genAidx(Date.now()),
			username: un,
			usernameLower: un,
			host: null,
			uri: null,
			avatarDecorations: localDecos.map(d => ({ id: d.id, angle: 0.1, flipH: false, offsetX: 0, offsetY: 0, scale: 1, opacity: 1 })),
		});
		const user = await usersRepository.findOneByOrFail({ usernameLower: un, host: IsNull() });

		// 初回(キャッシュ生成)と2回目以降(キャッシュヒット)の両方を測る
		const tFirst = performance.now();
		await apRendererService.renderDecorations(user);
		const first = performance.now() - tFirst;
		const n = 10000;
		const t0 = performance.now();
		for (let i = 0; i < n; i++) {
			const rendered = await apRendererService.renderDecorations(user);
			if (i === 0) expect(rendered).toHaveLength(4);
		}
		const per = (performance.now() - t0) / n;
		console.log(`[render] renderDecorations 初回(キャッシュ生成): ${first.toFixed(1)}ms, 定常(30分キャッシュ): 平均 ${per.toFixed(3)}ms/call`);
	}, 300000);
});
