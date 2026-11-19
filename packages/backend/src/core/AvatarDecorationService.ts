/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull, Not } from 'typeorm';
import type { AvatarDecorationsRepository, InstancesRepository, UsersRepository, MiAvatarDecoration, MiUser } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { MemorySingleCache } from '@/misc/cache.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { appendQuery, query } from '@/misc/prelude/url.js';
import { getApId, isDecoration } from '@/core/activitypub/type.js';
import { toArray } from '@/misc/prelude/array.js';
import { truncate } from '@/misc/truncate.js';
import type { Resolver } from '@/core/activitypub/ApResolverService.js';
import type { Config } from '@/config.js';

// TODO:
// 1. checkDuplicateする => done
// 2. リモートのデコレーションをproxy通してないメディアURLで保存できるようにする => プロキシのURLだと403になるので必須
// 3. AvatarDecorationsEntityServiceを作ってpackする
// 4. リモートユーザーのデコレーションを適宜fetchできる関数とAPIを作る => remoteDecorationsFromAp として実装
// 5. remoteUserUpdateの処理をAPIfetchの部分とアップデートの部分に分ける => APub版(remoteDecorationsFromAp)と旧API版(remoteUserUpdate)の分岐で対応
// 6. するか迷う: MiAvatarDecorationのカラムにdescriptionの他にライセンス欄を追加する
// 7. するか迷う: APubでデコレーションを配信する? => PersonのOrderedCollection(_yojoart_decorations)として実装(プル型)
// 8. avatar-decorationのjson-schemaを作る => packするためには必要

// リモート配信値の数値をi/updateのparamDefと同じ保存範囲(angle ±0.5回転、offsetX/Y ±0.25、scale 0.5-1.5、opacity 0.1-1)に収めるための補助関数。
// NaN/Infinity等の非有限値は既定値へフォールバックする
const toFiniteNumber = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v)) ? v : def;
const clampNumber = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);

// リモートデコレーション定義の孤児行クリーンアップ(定期cleanジョブから呼ばれる)の設定。
// リモート由来の行が無制限に増えること自体は、リモートユーザーが無制限に添付や投稿を作成できるのと同じで仕様互換なので上限を設けない。
// 削除対象は「どのユーザーからも参照されなくなった行」のみとし、保持期間内の行は取り込み処理と並行して間もなく参照され始める可能性があるため触らない。
// 未参照行はフェッチ成功(再取り込み)のあったホストでしか発生しないため、フェッチ成功時にホストをRedisセットへマークし、
// ジョブはマークされたホストのみ処理する。変更の無いホストはジョブの対象外。
const CLEANUP_HOSTS_REDIS_KEY = 'avatarDecorationCleanup:hosts';
const CLEANUP_HOSTS_POP_SIZE = 100;
// 1回の実行で処理するホスト数の上限(超過分はセットに残り次回以降に処理)
const CLEANUP_MAX_HOSTS_PER_RUN = 1000;
const REMOTE_DECORATION_CLEANUP_RETENTION_MS = 1000 * 60 * 60 * 24 * 7; // 7日
const REMOTE_DECORATION_CLEANUP_BATCH_SIZE = 500;
// ホスト1件あたりの削除バッチ数上限(到達時は未処理としてホストを再マークする)
const REMOTE_DECORATION_CLEANUP_MAX_BATCHES_PER_HOST = 20;

// 定義行idがどのユーザーのavatarDecorations(jsonb)からも参照されていないかの判定条件。
// idキーの無い要素は ->> 'id' がNULLになり NOT IN 全体がunknownで空集合(=何も削除されない)になるためNULLを除外する
const NOT_REFERENCED_SQL = `decoration."id" NOT IN (
	SELECT elem ->> 'id' FROM "user" "u", jsonb_array_elements("u"."avatarDecorations") AS elem
	WHERE "u"."avatarDecorations" <> '[]'::jsonb AND (elem ->> 'id') IS NOT NULL
)`;

@Injectable()
export class AvatarDecorationService implements OnApplicationShutdown {
	public cache: MemorySingleCache<MiAvatarDecoration[]>;
	public cacheRemote: MemorySingleCache<MiAvatarDecoration[]>;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.avatarDecorationsRepository)
		private avatarDecorationsRepository: AvatarDecorationsRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private idService: IdService,
		private moderationLogService: ModerationLogService,
		private globalEventService: GlobalEventService,
		private httpRequestService: HttpRequestService,
	) {
		this.cache = new MemorySingleCache<MiAvatarDecoration[]>(1000 * 60 * 30); // 30min
		this.cacheRemote = new MemorySingleCache<MiAvatarDecoration[]>(1000 * 60 * 30); // 30min

		this.redisForSub.on('message', this.onMessage);
	}

	@bindThis
	private async onMessage(_: string, data: string): Promise<void> {
		const obj = JSON.parse(data);

		if (obj.channel === 'internal') {
			const { type, body: _ } = obj.message as GlobalEvents['internal']['payload'];
			switch (type) {
				case 'avatarDecorationCreated':
				case 'avatarDecorationUpdated':
				case 'avatarDecorationDeleted': {
					this.cache.delete();
					// create()/update()はリモートデコレーション(host付き行)にも使われるため、他プロセスでもcacheRemoteを破棄する
					this.cacheRemote.delete();
					break;
				}
				default:
					break;
			}
		}
	}

	@bindThis
	public async create(options: Partial<MiAvatarDecoration>, moderator?: MiUser): Promise<MiAvatarDecoration> {
		const created = await this.avatarDecorationsRepository.insertOne({
			id: this.idService.gen(),
			...options,
		});

		this.globalEventService.publishInternalEvent('avatarDecorationCreated', created);

		if (moderator) {
			this.moderationLogService.log(moderator, 'createAvatarDecoration', {
				avatarDecorationId: created.id,
				avatarDecoration: created,
			});
		}

		return created;
	}

	@bindThis
	public async update(id: MiAvatarDecoration['id'], params: Partial<MiAvatarDecoration>, moderator?: MiUser): Promise<void> {
		const avatarDecoration = await this.avatarDecorationsRepository.findOneByOrFail({ id });

		const date = new Date();
		await this.avatarDecorationsRepository.update(avatarDecoration.id, {
			updatedAt: date,
			...params,
		});

		const updated = await this.avatarDecorationsRepository.findOneByOrFail({ id: avatarDecoration.id });
		this.globalEventService.publishInternalEvent('avatarDecorationUpdated', updated);

		if (moderator) {
			this.moderationLogService.log(moderator, 'updateAvatarDecoration', {
				avatarDecorationId: avatarDecoration.id,
				before: avatarDecoration,
				after: updated,
			});
		}
	}

	@bindThis
	private getProxiedUrl(url: string, mode?: 'static' | 'avatar'): string {
		return appendQuery(
			`${this.config.mediaProxy}/${mode ?? 'image'}.webp`,
			query({
				url,
				...(mode ? { [mode]: '1' } : {}),
			}),
		);
	}

	/**
	 * リモートのデコレーションは、APIで返す際に元のURL (rawUrl) にメディアプロキシのURLを付与する
	 * 以前のリモートのデコレーションは url にプロキシURLを保存しているため、url ではなく rawUrl を使う
	 * rawUrl の無い古いリモートのデコレーションは url がプロキシURLなので、二重にプロキシしないようそのまま返す (ユーザーの更新時に rawUrl が保存される)
	 */
	@bindThis
	public getPublicUrl(decoration: Pick<MiAvatarDecoration, 'url' | 'rawUrl' | 'host'>): string {
		if (decoration.host == null) return decoration.url;
		if (!decoration.rawUrl) return decoration.url;
		return this.getProxiedUrl(decoration.rawUrl, 'avatar');
	}

	@bindThis
	public async remoteUserUpdate(user: MiUser, resolver?: Resolver): Promise<string> {
		if (user.decorationsUri != null) {
			// ActorにOrderedCollectionを公開しているインスタンスはAPub版を優先する(旧API方式是fallback)
			if (resolver == null) return 'skip: prefer remoteDecorationsFromAp';
			return this.remoteDecorationsFromAp(user, resolver);
		}

		const userHost = user.host ?? '';
		const instance = await this.instancesRepository.findOneBy({ host: userHost });
		const userHostUrl = `https://${user.host}`;
		const showUserApiUrl = `${userHostUrl}/api/users/show`;

		//TODO kmyblue互換方式の機能対応表現を使うようにする
		if (!instance || !['cheripia', 'yojo-art', 'misskey', 'cherrypick', 'sharkey'].includes(<string>instance.softwareName)) return 'ok';

		const res = await this.httpRequestService.send(showUserApiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ 'username': user.username }),
		});

		const userData: any = await res.json();
		const userAvatarDecorations = userData.avatarDecorations ?? undefined;

		if (!userAvatarDecorations || userAvatarDecorations.length === 0) {
			const updates = {} as Partial<MiUser>;
			updates.avatarDecorations = [];

			if (!(await this.usersRepository.update({ id: user.id, isDeleted: false }, updates)).affected) {
				return 'skip';
			}

			await this.markHostForDecorationCleanup(userHost);

			return 'ok';
		}

		const instanceHost = instance!.host;
		const decorationApiUrl = `https://${instanceHost}/api/get-avatar-decorations`;
		const allRes = await this.httpRequestService.send(decorationApiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});

		const allDecorations: any = await allRes.json();
		const updates = {} as Partial<MiUser>;
		updates.avatarDecorations = [];

		for (const avatarDecoration of userAvatarDecorations) {
			let name;
			let description;
			const avatarDecorationId = avatarDecoration.id;

			for (const decoration of allDecorations) {
				// eslint-disable-next-line eqeqeq
				if (decoration.id == avatarDecorationId) {
					name = decoration.name;
					description = decoration.description;
					break;
				}
			}

			const existingDecoration = await this.avatarDecorationsRepository.findOneBy({
				host: userHost,
				remoteId: avatarDecorationId,
			});

			const decorationData = {
				name: name,
				description: description,
				url: avatarDecoration.url,
				remoteId: avatarDecorationId,
				host: userHost,
				rawUrl: avatarDecoration.url,
			};

			if (existingDecoration == null) {
				await this.create(decorationData);
				this.cacheRemote.delete();
			} else {
				await this.update(existingDecoration.id, decorationData);
				this.cacheRemote.delete();
			}

			const findDecoration = await this.avatarDecorationsRepository.findOneBy({
				host: userHost,
				remoteId: avatarDecorationId,
			});

			updates.avatarDecorations.push({
				id: findDecoration?.id ?? '',
				angle: avatarDecoration.angle ?? 0,
				flipH: avatarDecoration.flipH ?? false,
				offsetX: avatarDecoration.offsetX ?? 0,
				offsetY: avatarDecoration.offsetY ?? 0,
				scale: avatarDecoration.scale ?? 1,
				opacity: avatarDecoration.opacity ?? 1,
			});
		}
		if (!(await this.usersRepository.update({ id: user.id, isDeleted: false }, updates)).affected) {
			return 'skip';
		}
		await this.markHostForDecorationCleanup(userHost);
		return 'ok';
	}

	/**
	 * Actorに公開されたOrderedCollection(decorationsUri)からリモートアバターデコレーションを取り込む。
	 * 配信側はorderedItemsにitemをinlineで載せるが、firstページ参照形にも一応対応する。
	 * 配信値の単位系はIApDecorationのコメント通りアイコン基準(angleはradian)なので、
	 * 取り込み時にjsonb保存単位の系(angleは回転比1=1周、offset/scaleは既定描画サイズ=アイコン一辺の2倍基準)へ逆変換する。
	 * デコレーション定義の重複排除は(host, rawUrl=画像URL)キーで行う(旧API方式の(host, remoteId)キーとは別に管理される)。
	 */
	@bindThis
	public async remoteDecorationsFromAp(user: MiUser, resolver: Resolver): Promise<string> {
		if (user.host == null || user.uri == null) return 'skip';
		if (user.decorationsUri == null) return 'skip';

		const collection = await resolver.resolveOrderedCollection(user.decorationsUri);

		if (collection.id != null && new URL(getApId(collection.id)).origin !== new URL(user.uri).origin) {
			return 'skip: collection origin mismatch';
		}

		let items = collection.orderedItems;

		if (items == null && collection.first != null) {
			const page = await resolver.resolveOrderedCollectionPage(collection.first);
			if (page.partOf == null || getApId(page.partOf) !== getApId(user.decorationsUri)) {
				return 'skip: page partOf mismatch';
			}
			items = page.orderedItems ?? page.items;
		}

		const userHost = user.host;
		const updates = {} as Partial<MiUser>;
		updates.avatarDecorations = [];

		// 装着数の上限はi/updateのアバターデコレーション上限(16)に合わせる
		for (const rawItem of toArray(items ?? []).slice(0, 16)) {
			const item = typeof rawItem === 'string'
				? await resolver.resolve(rawItem).catch(() => null)
				: rawItem;
			if (item == null || !isDecoration(item)) continue;

			// flipVは保存先が無い為未対応。required_propertiesに未対応プロパティが宣言されたitemは取り込まない
			const supportedProperties = ['image', 'angle', 'flipH', 'offsetX', 'offsetY', 'scale', 'opacity'];
			// required_propertiesは外部入力なので配列でない場合(文字列等)は空扱いにする(.some()のTypeError防止)
			const requiredProperties = Array.isArray(item.required_properties) ? item.required_properties : [];
			if (requiredProperties.some(p => p === 'flipV' || !supportedProperties.includes(p))) continue;

			const image = item.image;
			const imageUrl = typeof image === 'string' ? image : image?.url;
			if (typeof imageUrl !== 'string') continue;

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(imageUrl);
			} catch {
				continue;
			}
			if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') continue;

			// urlカラムはvarchar(1024) NOT NULL。極長URLはcreate/updateのDBエラーを誘発するためitemごと除外する(truncateすると壊れたURLになる)
			if (imageUrl.length > 1024) continue;

			const name = (typeof image === 'object' && typeof image.name === 'string' ? image.name : undefined) ??
				(typeof item.name === 'string' ? item.name : undefined);
			const description = (typeof image === 'object' && typeof image.summary === 'string' ? image.summary : undefined) ??
				(typeof item.summary === 'string' ? item.summary : undefined);

			// getApIdはidが文字列idを持たない値(数値・配列等)の場合throwするため先にガードする
			let apId: string | null = null;
			if (item.id != null) {
				try {
					apId = getApId(item.id);
				} catch {
					apId = null;
				}
			}

			const decorationData = {
				name: truncate(name, 256) ?? '',
				description: truncate(description, 2048) ?? '',
				url: imageUrl,
				rawUrl: imageUrl,
				host: userHost,
				remoteId: apId != null && apId.length <= 32 ? apId : null,
			};

			const existingDecoration = await this.avatarDecorationsRepository.findOneBy({
				host: userHost,
				rawUrl: imageUrl,
			});

			let decorationId: string;
			let changed = existingDecoration == null;
			if (existingDecoration == null) {
				const created = await this.create(decorationData);
				decorationId = created.id;
			} else {
				// 定義行は(host, rawUrl)で同一hostの複数ユーザーに共有されるため、差分が無い行への
				// 無意味なUPDATE(updatedAt書き換え+全プロセス向けのcache invalidate event)をスキップする
				changed =
					decorationData.name !== existingDecoration.name ||
					decorationData.description !== existingDecoration.description ||
					decorationData.url !== existingDecoration.url ||
					decorationData.remoteId !== existingDecoration.remoteId;
				if (changed) await this.update(existingDecoration.id, decorationData);
				decorationId = existingDecoration.id;
			}
			if (changed) this.cacheRemote.delete();

			const rawAngle = toFiniteNumber(item.angle, 0) / (Math.PI * 2);
			updates.avatarDecorations.push({
				id: decorationId,
				// angle は1周周期で正規化してから保存(i/updateの保存可能域[-0.5, 0.5]に揃える)
				angle: rawAngle - Math.round(rawAngle),
				flipH: item.flipH === true,
				offsetX: clampNumber(toFiniteNumber(item.offsetX, 0) / 2, -0.25, 0.25),
				offsetY: clampNumber(toFiniteNumber(item.offsetY, 0) / 2, -0.25, 0.25),
				scale: clampNumber(toFiniteNumber(item.scale, 2) / 2, 0.5, 1.5),
				opacity: clampNumber(toFiniteNumber(item.opacity, 1), 0.1, 1),
			});
		}

		if (!(await this.usersRepository.update({ id: user.id, isDeleted: false }, updates)).affected) {
			return 'skip';
		}

		await this.markHostForDecorationCleanup(userHost);

		return 'ok';
	}

	/**
	 * 定期クリーンアップ(cleanUnusedRemoteDecorations)の処理対象ホストをマークする。
	 * リモートユーザーの取り込み成功時にのみ付与され、変更の無いホストは定期ジョブから外れる。
	 * 取り込みでユーザーの参照が書き換わった可能性があるため、定義行差分の有無にかかわらずマークする
	 * (コレクションから項目が消えた場合、旧定義行は更新されずupdatedAt等のシグナルも残らない)。
	 */
	@bindThis
	private async markHostForDecorationCleanup(host: string | null): Promise<void> {
		if (host == null) return;
		await this.redisClient.sadd(CLEANUP_HOSTS_REDIS_KEY, host);
	}

	@bindThis
	public async delete(id: MiAvatarDecoration['id'], moderator?: MiUser): Promise<void> {
		const avatarDecoration = await this.avatarDecorationsRepository.findOneByOrFail({ id });

		await this.avatarDecorationsRepository.delete({ id: avatarDecoration.id });
		this.globalEventService.publishInternalEvent('avatarDecorationDeleted', avatarDecoration);

		if (moderator) {
			this.moderationLogService.log(moderator, 'deleteAvatarDecoration', {
				avatarDecorationId: avatarDecoration.id,
				avatarDecoration: avatarDecoration,
			});
		}
	}

	/**
	 * 取り込み成功のあったリモートホストについて、どのユーザーからも参照されなくなった
	 * デコレーション定義行を削除する(定期cleanジョブ用)。
	 * remoteDecorationsFromAp / remoteUserUpdate では、配信コレクションから項目が消えたり
	 * URLが差し替えられたりした旧定義行を明示的に削除しないため、放置すると未使用行が残り続ける。
	 * 行が増えること自体はリモート由来の添付や投稿と同様に仕様互換なので上限は設けず、
	 * 参照が切れた孤児行のみを保持期間(7日)経過後に削除する。
	 * 対象はRedisセット(markHostForDecorationCleanup)でマークされたホストのみで、
	 * 変更の無いホストはジョブから外す。マークはリモートユーザーの取り込み成功時のみ付与される。
	 * 参照判定は全ユーザーのavatarDecorations(jsonb)のid集合に対する反対結合で行い、
	 * (host, rawUrl)キーで同一hostの複数ユーザーに共有された定義行は、参照しているユーザーが1人でもいれば削除されない。
	 * ローカル行(hostがnull)は管理画面で管理者が運用する対象なので、ホストマークが付かないため対象外。
	 * 保持期間内の未参照行が残ったホストは、次回以降のジョブで処理できるよう再マークする。
	 * @returns 削除した行数
	 */
	@bindThis
	public async cleanUnusedRemoteDecorations(): Promise<number> {
		const cutoff = this.idService.gen(Date.now() - REMOTE_DECORATION_CLEANUP_RETENTION_MS);

		// 処理対象ホストを先にすべて取り出してから処理する。
		// 処理中に再マークしたホストを同じ実行でspopし直すと、保持期間内の行があるホストで空回りするため
		// 再マークは全ホストの処理後にまとめて行う
		const hosts: string[] = [];
		for (let popped = 0; popped < CLEANUP_MAX_HOSTS_PER_RUN;) {
			const batch = await this.redisClient.spop(CLEANUP_HOSTS_REDIS_KEY, CLEANUP_HOSTS_POP_SIZE);
			if (batch.length === 0) break;
			hosts.push(...batch);
			popped += batch.length;
		}

		let totalDeleted = 0;
		const pendingHosts: string[] = [];

		for (const host of hosts) {
			for (let batch = 0; batch < REMOTE_DECORATION_CLEANUP_MAX_BATCHES_PER_HOST; batch++) {
				const orphans = await this.avatarDecorationsRepository.createQueryBuilder('decoration')
					.where('decoration.host = :host', { host })
					.andWhere('decoration.id < :cutoff', { cutoff })
					.andWhere(NOT_REFERENCED_SQL)
					.orderBy('decoration.id', 'ASC')
					.limit(REMOTE_DECORATION_CLEANUP_BATCH_SIZE)
					.getMany();

				if (orphans.length === 0) break;

				await this.avatarDecorationsRepository.delete({ id: In(orphans.map(x => x.id)) });

				// 各プロセスのcacheRemoteを無効化するためdeletedイベントを発行する(バッチ後も次回fetchまで古い行がキャッシュされ続けるのを防ぐ)
				for (const orphan of orphans) {
					this.globalEventService.publishInternalEvent('avatarDecorationDeleted', orphan);
				}

				totalDeleted += orphans.length;
			}

			// 保持期間内(取り込み処理と並行中の可能性あり)やバッチ上限で未削除の未参照行が残る場合は、
			// 次回以降のジョブで処理できるようホストを再マークする
			const pending = await this.avatarDecorationsRepository.createQueryBuilder('decoration')
				.where('decoration.host = :host', { host })
				.andWhere(NOT_REFERENCED_SQL)
				.limit(1)
				.getCount();
			if (pending > 0) pendingHosts.push(host);
		}

		if (pendingHosts.length > 0) await this.redisClient.sadd(CLEANUP_HOSTS_REDIS_KEY, ...pendingHosts);

		return totalDeleted;
	}

	@bindThis
	public async getAll(scope: 'local' | 'withRemote' | 'remoteOnly', flushCache = false): Promise<MiAvatarDecoration[]> {
		if (flushCache) {
			if (scope === 'local' || scope === 'withRemote') {
				this.cache.delete();
			}
			if (scope === 'withRemote' || scope === 'remoteOnly') {
				this.cacheRemote.delete();
			}
		}

		switch (scope) {
			case 'local':
				return this.cache.fetch(() => this.avatarDecorationsRepository.find({
					where: {
						host: IsNull(),
					},
				}));

			case 'withRemote':
				return [
					...await this.cache.fetch(() => this.avatarDecorationsRepository.find({ where: { host: IsNull() } })),
					...await this.cacheRemote.fetch(() => this.avatarDecorationsRepository.find({ where: { host: Not(IsNull()) } })),
				];

			case 'remoteOnly':
				return this.cacheRemote.fetch(() => this.avatarDecorationsRepository.find({
					where: { host: Not(IsNull()) },
				}));
		}
	}

	@bindThis
	private async fetchRemoteDecorations(id: string): Promise<string | null> {
		const decoration = await this.avatarDecorationsRepository.findOneBy({ id });
		if (decoration == null) return null;
		if (!decoration.host) return null;

		const instance = await this.instancesRepository.findOneBy({ host: decoration.host });
		if (!instance) return null;

		if (!['cheripia', 'yojo-art', 'misskey', 'cherrypick', 'sharkey'].includes(<string>instance.softwareName)) {
			return null;
		}

		const decorationApiUrl = `https://${instance.host}/api/get-avatar-decorations`;

		try {
			const res = await this.httpRequestService.send(decorationApiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});

			const allDecorations: any = await res.json();
			const remoteDecoration = allDecorations.find((d: any) => d.id === decoration.remoteId);

			if (remoteDecoration?.url) {
				return remoteDecoration.url;
			}
		} catch (e) {
			return null;
		}
		return null;
	}

	@bindThis
	public async getRawUrl(decoration: MiAvatarDecoration): Promise<string | null> {
		if (decoration.rawUrl) return decoration.rawUrl;

		const remoteUrl = await this.fetchRemoteDecorations(decoration.id);
		if (remoteUrl) {
			await this.update(decoration.id, { rawUrl: remoteUrl });
		}
		return remoteUrl;
	}

	@bindThis
	public checkDuplicate(url: string, name: string): Promise<boolean> {
		return this.avatarDecorationsRepository.exists({ where: { url, name, host: IsNull() } });
	}

	@bindThis
	public dispose(): void {
		this.redisForSub.off('message', this.onMessage);
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
