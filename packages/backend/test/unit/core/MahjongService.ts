/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import * as Mmj from 'misskey-mahjong';
import { MahjongService, type MahjongRoom } from '@/core/MahjongService.js';
import type { MiUser } from '@/models/User.js';

function createRoom(): MahjongRoom {
	return {
		id: 'test-room',
		createdAt: new Date(0).toISOString(),
		startedAt: new Date(0).toISOString(),
		endedAt: null,
		isStarted: true,
		isEnded: false,
		user1Id: 'user1',
		user2Id: 'user2',
		user3Id: 'user3',
		user4Id: 'user4',
		user1: null,
		user2: null,
		user3: null,
		user4: null,
		user1Ai: false,
		user2Ai: false,
		user3Ai: false,
		user4Ai: false,
		user1Ready: true,
		user2Ready: true,
		user3Ready: true,
		user4Ready: true,
		timeLimitForEachTurn: 30,
		matchLength: 'south',
		isInviteOnly: false,
		invitations: [],
	};
}

function createExhaustedState(): Mmj.MasterState {
	// 山を空にし、他家が m6 を鳴けない手牌にして、asking なしの流局を作る
	return Mmj.MasterGameEngine.createInitialState({
		tiles: [],
		handTiles: {
			e: [1, 21, 22, 23, 24, 57, 58, 59, 60, 93, 94, 95, 96, 37],
			s: [33, 34, 35, 36, 69, 70, 71, 72, 105, 106, 107, 108, 38],
			w: [29, 30, 31, 32, 65, 66, 67, 68, 101, 102, 103, 104, 42],
			n: [25, 26, 27, 28, 61, 62, 63, 64, 97, 98, 99, 100, 45],
		},
	});
}

type CallingAnswersForTest = {
	pon: Record<Mmj.House, boolean | null>;
	cii: null | false | 'x__' | '_x_' | '__x';
	kan: Record<Mmj.House, boolean | null>;
	ron: Record<Mmj.House, null | boolean>;
};

// 指定した家だけ value の回答レコードを作るテスト用ヘルパー
function answerRecord<T>(house: Mmj.House, value: T): Record<Mmj.House, T> {
	return { e: null, s: null, w: null, n: null, [house]: value } as Record<Mmj.House, T>;
}

function createCallingRoom(options: { riichi?: boolean } = {}): MahjongRoom {
	const room = createRoom();
	room.gameState = Mmj.MasterGameEngine.createInitialState({
		riichis: {
			e: false,
			s: options.riichi ?? false,
			w: false,
			n: false,
		},
		handTiles: {
			e: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14],
			// m5 を3枚、m4 と m6 を持たせ、ポン・チー・カンを同時に成立させる
			s: [18, 19, 20, 13, 21, 57, 58, 59, 61, 62, 63, 65, 66],
			w: [22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38],
			n: [39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51],
		},
		hoTiles: {
			e: [17],
			s: [],
			w: [],
			n: [],
		},
		askings: {
			ron: { callee: 'e', callers: ['s', 'w'] },
			pon: { callee: 'e', callers: ['s'] },
			cii: { callee: 'e', caller: 's' },
			kan: { callee: 'e', callers: ['s'] },
		},
		tiles: [52, 53, 54, 55, 56, 60, 64, 67, 68, 69, 70],
		kingTiles: [125, 126, 127, 128],
		activatedDorasCount: 1,
		turn: null,
		nextTurnAfterAsking: 's',
	});
	return room;
}

function createRedisMock(store = new Map<string, string>()) {
	const zsets = new Map<string, Map<string, number>>();
	const sets = new Map<string, Set<string>>();
	const commands = {
		del: vi.fn((key: string) => {
			const deleted = store.delete(key) || zsets.delete(key) || sets.delete(key);
			return Promise.resolve(deleted ? 1 : 0);
		}),
		get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
		set: vi.fn((key: string, value: string, ..._options: unknown[]) => {
			store.set(key, value);
			return Promise.resolve('OK');
		}),
		mget: vi.fn((keys: string[]) => Promise.resolve(keys.map(key => store.get(key) ?? null))),
		zadd: vi.fn((key: string, score: number, member: string) => {
			let zset = zsets.get(key);
			if (zset == null) {
				zset = new Map();
				zsets.set(key, zset);
			}
			const added = !zset.has(member);
			zset.set(member, score);
			return Promise.resolve(added ? 1 : 0);
		}),
		zrem: vi.fn((key: string, ...members: string[]) => {
			const zset = zsets.get(key);
			let removed = 0;
			for (const member of members) {
				if (zset?.delete(member)) removed++;
			}
			return Promise.resolve(removed);
		}),
		zrevrange: vi.fn((key: string, start: number, stop: number) => {
			const members = [...(zsets.get(key) ?? new Map<string, number>()).entries()]
				.sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
				.map(([member]) => member);
			return Promise.resolve(members.slice(start, stop + 1));
		}),
		expire: vi.fn(() => Promise.resolve(1)),
		sadd: vi.fn((key: string, ...members: string[]) => {
			let set = sets.get(key);
			if (set == null) {
				set = new Set();
				sets.set(key, set);
			}
			let added = 0;
			for (const member of members) {
				if (!set.has(member)) {
					set.add(member);
					added++;
				}
			}
			return Promise.resolve(added);
		}),
		sismember: vi.fn((key: string, member: string) => Promise.resolve(sets.get(key)?.has(member) ? 1 : 0)),
		srem: vi.fn((key: string, ...members: string[]) => {
			const set = sets.get(key);
			let removed = 0;
			for (const member of members) {
				if (set?.delete(member)) removed++;
			}
			return Promise.resolve(removed);
		}),
		keys: vi.fn(() => Promise.reject(new Error('KEYS must not be used'))),
	};
	type CommandName = 'del' | 'set' | 'zadd' | 'zrem' | 'expire';
	const multi = vi.fn(() => {
		const queue: Array<() => Promise<unknown>> = [];
		const chain = {} as Record<CommandName, (...args: unknown[]) => typeof chain> & { exec: () => Promise<Array<[Error | null, unknown]>> };
		for (const name of ['del', 'set', 'zadd', 'zrem', 'expire'] as const) {
			chain[name] = (...args: unknown[]) => {
				queue.push(() => (commands[name] as (...a: unknown[]) => Promise<unknown>)(...args));
				return chain;
			};
		}
		chain.exec = async () => {
			const results: Array<[Error | null, unknown]> = [];
			for (const run of queue) results.push([null, await run()]);
			return results;
		};
		return chain;
	});
	return { redisClient: { ...commands, multi }, store, zsets, sets };
}

function createCallingService(room: MahjongRoom) {
	const store = new Map<string, string>();
	store.set(`mahjong:room:${room.id}`, JSON.stringify(room));
	store.set(`mahjong:gameCallingAsking:${room.id}`, JSON.stringify({
		pon: { e: null, s: null, w: null, n: null },
		cii: null,
		kan: { e: null, s: null, w: null, n: null },
		ron: { e: null, s: null, w: null, n: null },
	} satisfies CallingAnswersForTest));

	const { redisClient } = createRedisMock(store);

	const service = new MahjongService(
		redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
		{} as unknown as ConstructorParameters<typeof MahjongService>[1],
		{} as unknown as ConstructorParameters<typeof MahjongService>[2],
		{} as unknown as ConstructorParameters<typeof MahjongService>[3],
		{} as unknown as ConstructorParameters<typeof MahjongService>[4],
		{} as unknown as ConstructorParameters<typeof MahjongService>[5],
	);

	return { service, store };
}

function readCallingAnswers(store: Map<string, string>): CallingAnswersForTest {
	const raw = store.get('mahjong:gameCallingAsking:test-room');
	expect(raw).toBeDefined();
	return JSON.parse(raw!) as CallingAnswersForTest;
}

const user2 = { id: 'user2' } as unknown as MiUser;

describe('MahjongService', () => {
	test('publishes the final discard before ryuukyoku', async () => {
		const room = createRoom();
		const mj = new Mmj.MasterGameEngine(createExhaustedState());

		const published: Array<{ type: string; payload: unknown }> = [];
		const globalEventService = {
			publishMahjongRoomStream: (_roomId: string, type: string, payload: unknown) => {
				published.push({ type, payload });
			},
		};
		const { redisClient } = createRedisMock();

		const service = new MahjongService(
			redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			{} as unknown as ConstructorParameters<typeof MahjongService>[1],
			globalEventService as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
			{} as unknown as ConstructorParameters<typeof MahjongService>[4],
			{} as unknown as ConstructorParameters<typeof MahjongService>[5],
		);

		try {
			// m6 を捨てると山が尽きて asking なしの流局になる
			// (捨て牌が全幺九牌だと流し満貫達成になり notenHouses から除外されるため中牌を使う)
			await (service as unknown as {
				dahaiLocked: (room: MahjongRoom, mj: Mmj.MasterGameEngine, house: Mmj.House, tile: Mmj.TileId, riichi?: boolean) => Promise<void>;
			}).dahaiLocked(room, mj, 'e', 21);

			expect(published.map(call => call.type)).toEqual(['dahai', 'ryuukyoku']);
			expect(published[0]!.payload).toEqual({ house: 'e', tile: 21, riichi: false });
			const ryuukyoku = published[1]!.payload as {
				tenpaiHouses: Mmj.House[];
				notenHouses: Mmj.House[];
				pointDeltas: Record<Mmj.House, number>;
			};
			expect([...ryuukyoku.tenpaiHouses, ...ryuukyoku.notenHouses].sort()).toEqual(['e', 'n', 's', 'w']);
			expect(ryuukyoku.tenpaiHouses.every(house => !ryuukyoku.notenHouses.includes(house))).toBe(true);
			expect(ryuukyoku.pointDeltas.e + ryuukyoku.pointDeltas.s + ryuukyoku.pointDeltas.w + ryuukyoku.pointDeltas.n).toBe(0);
			expect(room.gameState?.points).toEqual({
				e: 25000 + ryuukyoku.pointDeltas.e,
				s: 25000 + ryuukyoku.pointDeltas.s,
				w: 25000 + ryuukyoku.pointDeltas.w,
				n: 25000 + ryuukyoku.pointDeltas.n,
			});
			expect(room.gameState?.turn).toBeNull();
			// 最後の捨て牌がエンジン状態の河に残っている
			expect(room.gameState?.hoTiles.e.at(-1)).toBe(21);
		} finally {
			service.dispose();
		}
	});

	test('publishes ryuukyoku result when a calling interruption is declined', async () => {
		const room = createRoom();
		const state = createExhaustedState();
		// 最後の捨て牌を済ませた状態で、鳴きの回答待ちから流局する
		// (河が全幺九牌だと流し満貫達成になるため 44 = p3 の中牌で捨了済みにする)
		state.handTiles.e.pop();
		state.hoTiles.e.push(44);
		state.turn = null;
		state.nextTurnAfterAsking = 's';
		state.askings = {
			ron: null,
			pon: { callee: 'e', callers: ['s'] },
			cii: null,
			kan: null,
		};
		room.gameState = state;
		const mj = new Mmj.MasterGameEngine(state);

		const published: Array<{ type: string; payload: unknown }> = [];
		const globalEventService = {
			publishMahjongRoomStream: (_roomId: string, type: string, payload: unknown) => {
				published.push({ type, payload });
			},
		};
		const { redisClient } = createRedisMock();

		const service = new MahjongService(
			redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			{} as unknown as ConstructorParameters<typeof MahjongService>[1],
			globalEventService as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
			{} as unknown as ConstructorParameters<typeof MahjongService>[4],
			{} as unknown as ConstructorParameters<typeof MahjongService>[5],
		);

		try {
			const answers: CallingAnswersForTest = {
				pon: answerRecord('s', false),
				cii: false,
				kan: { e: null, s: null, w: null, n: null },
				ron: { e: false, s: false, w: false, n: false },
			};
			await (service as unknown as {
				answerLocked: (room: MahjongRoom, mj: Mmj.MasterGameEngine, callingAnswers: CallingAnswersForTest) => Promise<void>;
			}).answerLocked(room, mj, answers);

			expect(published.map(call => call.type)).toEqual(['ryuukyoku']);
			const ryuukyoku = published[0]!.payload as {
				tenpaiHouses: Mmj.House[];
				notenHouses: Mmj.House[];
				pointDeltas: Record<Mmj.House, number>;
			};
			expect([...ryuukyoku.tenpaiHouses, ...ryuukyoku.notenHouses].sort()).toEqual(['e', 'n', 's', 'w']);
			expect(ryuukyoku.pointDeltas.e + ryuukyoku.pointDeltas.s + ryuukyoku.pointDeltas.w + ryuukyoku.pointDeltas.n).toBe(0);
			expect(room.gameState?.points).toEqual({
				e: 25000 + ryuukyoku.pointDeltas.e,
				s: 25000 + ryuukyoku.pointDeltas.s,
				w: 25000 + ryuukyoku.pointDeltas.w,
				n: 25000 + ryuukyoku.pointDeltas.n,
			});
			expect(room.gameState?.turn).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('ron declines the same player\'s pon, cii and kan answers', async () => {
		const { service, store } = createCallingService(createCallingRoom());
		try {
			await service.commit_ronHora('test-room', user2);

			const answers = readCallingAnswers(store);
			expect(answers.ron).toEqual({ e: null, s: true, w: null, n: null });
			expect(answers.pon).toEqual(answerRecord('s', false));
			expect(answers.cii).toBe(false);
			expect(answers.kan).toEqual(answerRecord('s', false));
		} finally {
			service.dispose();
		}
	});

	test('pon declines the same player\'s ron, cii and kan answers', async () => {
		const { service, store } = createCallingService(createCallingRoom());
		try {
			await service.commit_pon('test-room', user2);

			const answers = readCallingAnswers(store);
			expect(answers.pon).toEqual(answerRecord('s', true));
			expect(answers.cii).toBe(false);
			expect(answers.kan).toEqual(answerRecord('s', false));
			expect(answers.ron).toEqual(answerRecord('s', false));
		} finally {
			service.dispose();
		}
	});

	test('cii declines the same player\'s ron, pon and kan answers', async () => {
		const { service, store } = createCallingService(createCallingRoom());
		try {
			await service.commit_cii('test-room', user2, '_x_');

			const answers = readCallingAnswers(store);
			expect(answers.cii).toBe('_x_');
			expect(answers.pon).toEqual(answerRecord('s', false));
			expect(answers.kan).toEqual(answerRecord('s', false));
			expect(answers.ron).toEqual(answerRecord('s', false));
		} finally {
			service.dispose();
		}
	});

	test('kan declines the same player\'s ron, pon and cii answers', async () => {
		const { service, store } = createCallingService(createCallingRoom());
		try {
			await service.commit_kan('test-room', user2);

			const answers = readCallingAnswers(store);
			expect(answers.kan).toEqual(answerRecord('s', true));
			expect(answers.pon).toEqual(answerRecord('s', false));
			expect(answers.cii).toBe(false);
			expect(answers.ron).toEqual(answerRecord('s', false));
		} finally {
			service.dispose();
		}
	});

	test('riichi player\'s illegal pon does not decline their ron answer', async () => {
		const { service, store } = createCallingService(createCallingRoom({ riichi: true }));
		try {
			await service.commit_pon('test-room', user2);

			const answers = readCallingAnswers(store);
			expect(answers.pon).toEqual(answerRecord('s', false));
			expect(answers.cii).toBeNull();
			expect(answers.kan).toEqual({ e: null, s: null, w: null, n: null });
			expect(answers.ron).toEqual({ e: null, s: null, w: null, n: null });
		} finally {
			service.dispose();
		}
	});

	test('invalid cii does not decline the same player\'s ron answer', async () => {
		const { service, store } = createCallingService(createCallingRoom());
		try {
			// s の手牌では m5 に対して m6, m7 が揃わないため x__ は成立しない
			await service.commit_cii('test-room', user2, 'x__');

			const answers = readCallingAnswers(store);
			expect(answers.cii).toBe(false);
			expect(answers.pon).toEqual({ e: null, s: null, w: null, n: null });
			expect(answers.kan).toEqual({ e: null, s: null, w: null, n: null });
			expect(answers.ron).toEqual({ e: null, s: null, w: null, n: null });
		} finally {
			service.dispose();
		}
	});
});

describe('MahjongService nextKyokuLocked abortive draw', () => {
	test('aborts on kyushu-kyuhai in the new deal', async () => {
		const room = createRoom();
		room.gameState = Mmj.MasterGameEngine.createInitialState();
		// 新局生成を九種九牌の配牌に差し替える
		const kyushuState = Mmj.MasterGameEngine.createInitialState({
			handTiles: {
				e: [1, 33, 37, 69, 73, 105, 109, 113, 117, 121, 125, 129, 133, 5],
				s: [],
				w: [],
				n: [],
			},
		});

		const published: Array<{ type: string; payload: unknown }> = [];
		const globalEventService = {
			publishMahjongRoomStream: (_roomId: string, type: string, payload: unknown) => {
				published.push({ type, payload });
			},
		};
		const { redisClient, store } = createRedisMock();

		const service = new MahjongService(
			redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			{} as unknown as ConstructorParameters<typeof MahjongService>[1],
			globalEventService as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
			{} as unknown as ConstructorParameters<typeof MahjongService>[4],
			{} as unknown as ConstructorParameters<typeof MahjongService>[5],
		);

		const createInitialState = vi.spyOn(Mmj.MasterGameEngine, 'createInitialState').mockReturnValue(kyushuState);
		try {
			const mj = new Mmj.MasterGameEngine(room.gameState!);
			await (service as unknown as {
				nextKyokuLocked: (room: MahjongRoom, mj: Mmj.MasterGameEngine, kyokuResult: { agariHouse: Mmj.House | null; tenpaiHouses: Mmj.House[] }, expected: { round: Mmj.MasterState['round']; kyoku: number; turnCount: number }) => Promise<void>;
			}).nextKyokuLocked(room, mj, { agariHouse: 's', tenpaiHouses: [] }, { round: 'e', kyoku: 1, turnCount: 0 });

			// nextKyoku を publish せず中斷フローに入る
			expect(published.map(call => call.type)).toEqual(['ryuukyoku']);
			const ryuukyoku = published[0]!.payload as { abortive?: string };
			expect(ryuukyoku.abortive).toBe('kyushukyuhai');
			expect(room.gameState?.honba).toBe(1);
			// 次局待機が始まり、局が停止しない
			expect(store.has('mahjong:gameNextKyokuConfirmation:test-room')).toBe(true);
		} finally {
			createInitialState.mockRestore();
			service.dispose();
		}
	});
});

describe('MahjongService nextKyokuLocked single match', () => {
	function createSingleMatchService(store = new Map<string, string>()) {
		const published: Array<{ type: string; payload: unknown }> = [];
		const globalEventService = {
			publishMahjongRoomStream: (_roomId: string, type: string, payload: unknown) => {
				published.push({ type, payload });
			},
		};
		const { redisClient } = createRedisMock(store);
		const service = new MahjongService(
			redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			{} as unknown as ConstructorParameters<typeof MahjongService>[1],
			globalEventService as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
			{} as unknown as ConstructorParameters<typeof MahjongService>[4],
			{} as unknown as ConstructorParameters<typeof MahjongService>[5],
		);
		return { service, published, store };
	}

	function createSingleMatchRoom(preset: Partial<Mmj.MasterState> = {}): MahjongRoom {
		const room = createRoom();
		room.matchLength = 'single';
		room.gameState = Mmj.MasterGameEngine.createInitialState({
			matchLength: 'single',
			round: 'e',
			kyoku: 1,
			...preset,
		});
		return room;
	}

	// 東1局が終わったとして次局進行を呼ぶ
	async function nextKyokuFromEast1(
		service: MahjongService,
		room: MahjongRoom,
		kyokuResult: { agariHouse: Mmj.House | null; tenpaiHouses: Mmj.House[]; abortive?: boolean },
	): Promise<void> {
		const mj = new Mmj.MasterGameEngine(room.gameState!);
		await (service as unknown as {
			nextKyokuLocked: (room: MahjongRoom, mj: Mmj.MasterGameEngine, kyokuResult: { agariHouse: Mmj.House | null; tenpaiHouses: Mmj.House[]; abortive?: boolean }, expected: { round: Mmj.MasterState['round']; kyoku: number; turnCount: number }) => Promise<void>;
		}).nextKyokuLocked(room, mj, kyokuResult, { round: 'e', kyoku: 1, turnCount: 0 });
	}

	test('ends the match on a non-dealer win at east 1', async () => {
		const { service, published } = createSingleMatchService();
		const room = createSingleMatchRoom();
		try {
			await nextKyokuFromEast1(service, room, { agariHouse: 's', tenpaiHouses: [] });

			expect(room.isEnded).toBe(true);
			const types = published.map(call => call.type);
			expect(types).toContain('ended');
			expect(types).not.toContain('nextKyoku');
		} finally {
			service.dispose();
		}
	});

	test('ends the match on a dealer win at east 1', async () => {
		// 1局戦は親連荘でも対局終了
		const { service, published } = createSingleMatchService();
		const room = createSingleMatchRoom();
		try {
			await nextKyokuFromEast1(service, room, { agariHouse: 'e', tenpaiHouses: [] });

			expect(room.isEnded).toBe(true);
			expect(published.map(call => call.type)).toContain('ended');
		} finally {
			service.dispose();
		}
	});

	test('replays east 1 when the finished hand was an abortive draw', async () => {
		// commit_abortiveDraw が本場を +1 済みの状態
		const { service, published } = createSingleMatchService();
		const room = createSingleMatchRoom({ honba: 1 });
		try {
			await nextKyokuFromEast1(service, room, { agariHouse: null, tenpaiHouses: ['e'], abortive: true });

			expect(room.isEnded).toBe(false);
			expect(room.gameState?.round).toBe('e');
			expect(room.gameState?.kyoku).toBe(1);
			expect(room.gameState?.matchLength).toBe('single');
			// 本場は二重加算しない
			expect(room.gameState?.honba).toBe(1);
			const types = published.map(call => call.type);
			expect(types).toContain('nextKyoku');
			expect(types).not.toContain('ended');
		} finally {
			service.dispose();
		}
	});

	test('advances to east 2 on a non-dealer win at east 1 in a south match', async () => {
		// 既存の東南戦は従来どおり東2局へ進む
		const { service, published } = createSingleMatchService();
		const room = createSingleMatchRoom();
		room.matchLength = 'south';
		room.gameState = Mmj.MasterGameEngine.createInitialState({ matchLength: 'south', round: 'e', kyoku: 1 });
		try {
			await nextKyokuFromEast1(service, room, { agariHouse: 's', tenpaiHouses: [] });

			expect(room.isEnded).toBe(false);
			expect(room.gameState?.kyoku).toBe(2);
			expect(published.map(call => call.type)).toContain('nextKyoku');
		} finally {
			service.dispose();
		}
	});

	// endKyoku が Redis へ書く待機レコード（次局進行待ち）を作る
	async function writeWaitingRecord(
		service: MahjongService,
		room: MahjongRoom,
		kyokuResult: { agariHouse: Mmj.House | null; tenpaiHouses: Mmj.House[]; abortive?: boolean },
	): Promise<void> {
		const mj = new Mmj.MasterGameEngine(room.gameState!);
		await (service as unknown as {
			endKyoku: (room: MahjongRoom, mj: Mmj.MasterGameEngine, kyokuResult: { agariHouse: Mmj.House | null; tenpaiHouses: Mmj.House[]; abortive?: boolean }) => Promise<void>;
		}).endKyoku(room, mj, kyokuResult);
	}

	type WaitingRecordView = {
		confirmation: Record<string, unknown>;
		kyokuResult: { agariHouse?: Mmj.House | null; tenpaiHouses?: Mmj.House[]; abortive?: boolean };
		expected: { round: Mmj.MasterState['round']; kyoku: number; turnCount: number };
	};

	function readWaitingRecord(store: Map<string, string>): WaitingRecordView {
		const raw = store.get('mahjong:gameNextKyokuConfirmation:test-room');
		expect(raw).toBeDefined();
		return JSON.parse(raw!) as WaitingRecordView;
	}

	// 4席が確認したとして次局進行を進める（進行は Redis から読み直したルームで行われる）
	async function confirmAllSeats(service: MahjongService, roomId: MahjongRoom['id']): Promise<MahjongRoom> {
		for (const id of ['user1', 'user2', 'user3', 'user4']) {
			await service.confirmNextKyoku(roomId, { id } as unknown as MiUser);
		}
		const raw = (await service.getRoom(roomId))!;
		return raw;
	}

	test('keeps the abortive flag through the redis waiting record', async () => {
		const { service, store } = createSingleMatchService();
		const room = createSingleMatchRoom({ honba: 1 });
		store.set(`mahjong:room:${room.id}`, JSON.stringify(room));
		try {
			await writeWaitingRecord(service, room, { agariHouse: null, tenpaiHouses: ['e'], abortive: true });

			expect(readWaitingRecord(store).kyokuResult.abortive).toBe(true);
		} finally {
			service.dispose();
		}
	});

	test('replays east 1 through the confirmNextKyoku fast path', async () => {
		// 全員確認の高速進行は待機レコードから kyokuResult を復元して進行する
		const { service, store, published } = createSingleMatchService();
		const room = createSingleMatchRoom({ honba: 1 });
		store.set(`mahjong:room:${room.id}`, JSON.stringify(room));
		try {
			await writeWaitingRecord(service, room, { agariHouse: null, tenpaiHouses: ['e'], abortive: true });
			const advanced = await confirmAllSeats(service, room.id);

			expect(advanced.isEnded).toBe(false);
			expect(advanced.gameState?.round).toBe('e');
			expect(advanced.gameState?.kyoku).toBe(1);
			expect(advanced.gameState?.matchLength).toBe('single');
			expect(advanced.gameState?.honba).toBe(1);
			expect(published.map(call => call.type)).toContain('nextKyoku');
		} finally {
			service.dispose();
		}
	});

	test('ends the match when a pre-deploy waiting record without the abortive flag is confirmed', async () => {
		// 旧形式（abortive 無し）は false として復元され、1局戦は対局終了する
		const { service, store, published } = createSingleMatchService();
		const room = createSingleMatchRoom();
		store.set(`mahjong:room:${room.id}`, JSON.stringify(room));
		try {
			await writeWaitingRecord(service, room, { agariHouse: 's', tenpaiHouses: [] });
			const stored = readWaitingRecord(store);
			delete (stored.kyokuResult as Record<string, unknown>).abortive;
			store.set('mahjong:gameNextKyokuConfirmation:test-room', JSON.stringify(stored));

			const advanced = await confirmAllSeats(service, room.id);

			expect(advanced.isEnded).toBe(true);
			expect(published.map(call => call.type)).toContain('ended');
		} finally {
			service.dispose();
		}
	});

	test('recovers with a neutral kyoku result when the waiting record has a broken abortive value', async () => {
		// 破損値の待機レコードは読み捨てられ、連荘判定なしの中立値で回復する。1局戦では対局終了になる。
		const { service, store, published } = createSingleMatchService();
		const room = createSingleMatchRoom();
		store.set(`mahjong:room:${room.id}`, JSON.stringify(room));
		try {
			await writeWaitingRecord(service, room, { agariHouse: null, tenpaiHouses: ['e'], abortive: true });
			const stored = readWaitingRecord(store);
			(stored.kyokuResult as Record<string, unknown>).abortive = 'yes';
			store.set('mahjong:gameNextKyokuConfirmation:test-room', JSON.stringify(stored));

			const advanced = await confirmAllSeats(service, room.id);

			expect(advanced.isEnded).toBe(true);
			expect(published.map(call => call.type)).toContain('ended');
		} finally {
			service.dispose();
		}
	});
});

describe('MahjongService getActiveRooms', () => {
	function createService() {
		const redis = createRedisMock();
		const service = new MahjongService(
			redis.redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			{} as unknown as ConstructorParameters<typeof MahjongService>[1],
			{} as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
			{} as unknown as ConstructorParameters<typeof MahjongService>[4],
			{} as unknown as ConstructorParameters<typeof MahjongService>[5],
		);
		const saveRoom = (room: MahjongRoom) => (service as unknown as { saveRoom: (room: MahjongRoom) => Promise<void> }).saveRoom(room);
		const deleteRoom = (roomId: string) => (service as unknown as { deleteRoom: (roomId: string) => Promise<void> }).deleteRoom(roomId);
		return { ...redis, service, saveRoom, deleteRoom };
	}

	function createRoomAt(id: string, createdAt: number, state: { isStarted: boolean; isEnded: boolean }): MahjongRoom {
		return {
			...createRoom(),
			id,
			createdAt: new Date(createdAt).toISOString(),
			...state,
		};
	}

	const active = { isStarted: true, isEnded: false };

	test('returns only started and not ended rooms, newest first, without KEYS', async () => {
		const { service, saveRoom, redisClient } = createService();
		try {
			await saveRoom(createRoomAt('waiting', 4000, { isStarted: false, isEnded: false }));
			await saveRoom(createRoomAt('old', 1000, active));
			await saveRoom(createRoomAt('new', 3000, active));
			await saveRoom(createRoomAt('ended', 2000, { isStarted: true, isEnded: true }));

			const rooms = await service.getActiveRooms();

			expect(rooms.map(room => room.id)).toEqual(['new', 'old']);
			expect(redisClient.keys).not.toHaveBeenCalled();
			expect(redisClient.get).not.toHaveBeenCalled();
			expect(redisClient.mget).toHaveBeenCalledTimes(1);
		} finally {
			service.dispose();
		}
	});

	test('removes a room from the index when it ends or is deleted', async () => {
		const { service, saveRoom, deleteRoom, zsets } = createService();
		try {
			const room = createRoomAt('room', 1000, active);
			await saveRoom(room);
			await saveRoom(createRoomAt('other', 2000, active));
			expect([...zsets.get('mahjong:activeRooms')!.keys()].sort()).toEqual(['other', 'room']);

			room.isEnded = true;
			await saveRoom(room);
			await deleteRoom('other');

			expect(zsets.get('mahjong:activeRooms')!.size).toBe(0);
			expect(await service.getActiveRooms()).toEqual([]);
		} finally {
			service.dispose();
		}
	});

	test('registers a room that was already in progress when it is saved next time', async () => {
		const { service, saveRoom, store } = createService();
		try {
			// インデックスの導入前から続いている対局 (本体のみ存在する)
			const room = createRoomAt('legacy', 1000, active);
			store.set('mahjong:room:legacy', JSON.stringify(room));
			expect(await service.getActiveRooms()).toEqual([]);

			await saveRoom(room);

			expect((await service.getActiveRooms()).map(room => room.id)).toEqual(['legacy']);
		} finally {
			service.dispose();
		}
	});

	test('cleans up stale ids whose room key has expired or is broken', async () => {
		const { service, saveRoom, store, zsets, redisClient } = createService();
		try {
			await saveRoom(createRoomAt('alive', 1000, active));
			await saveRoom(createRoomAt('expired', 2000, active));
			await saveRoom(createRoomAt('broken', 3000, active));
			store.delete('mahjong:room:expired');
			store.set('mahjong:room:broken', '{');

			const rooms = await service.getActiveRooms();

			expect(rooms.map(room => room.id)).toEqual(['alive']);
			expect(redisClient.zrem).toHaveBeenCalledWith('mahjong:activeRooms', 'broken', 'expired');
			expect([...zsets.get('mahjong:activeRooms')!.keys()]).toEqual(['alive']);
		} finally {
			service.dispose();
		}
	});

	test('returns at most 30 rooms by default', async () => {
		const { service, saveRoom, redisClient } = createService();
		try {
			for (let i = 0; i < 35; i++) {
				await saveRoom(createRoomAt(`room${String(i).padStart(2, '0')}`, i * 1000, active));
			}

			const rooms = await service.getActiveRooms();

			expect(rooms).toHaveLength(30);
			expect(rooms[0]!.id).toBe('room34');
			expect(rooms.at(-1)!.id).toBe('room05');
			expect(redisClient.mget).toHaveBeenCalledTimes(1);
			expect(redisClient.mget.mock.calls[0]![0]).toHaveLength(30);
		} finally {
			service.dispose();
		}
	});

	test('reads further entries when stale ids fill the first batch', async () => {
		const { service, saveRoom, store } = createService();
		try {
			await saveRoom(createRoomAt('a', 1000, active));
			await saveRoom(createRoomAt('b', 2000, active));
			await saveRoom(createRoomAt('stale1', 3000, active));
			await saveRoom(createRoomAt('stale2', 4000, active));
			store.delete('mahjong:room:stale1');
			store.delete('mahjong:room:stale2');

			const rooms = await service.getActiveRooms(2);

			expect(rooms.map(room => room.id)).toEqual(['b', 'a']);
		} finally {
			service.dispose();
		}
	});
});

describe('MahjongService kickUser', () => {
	function createLobbyRoom(): MahjongRoom {
		return {
			...createRoom(),
			startedAt: null,
			isStarted: false,
			isEnded: false,
			user1Ready: true,
			user2Ready: true,
			user3Ready: true,
			user4Ready: false,
		};
	}

	function createLobbyService(room: MahjongRoom) {
		const store = new Map<string, string>();
		store.set(`mahjong:room:${room.id}`, JSON.stringify(room));
		const { redisClient } = createRedisMock(store);

		const published: Array<{ type: string; payload: unknown }> = [];
		const globalEventService = {
			publishMahjongRoomStream: (_roomId: string, type: string, payload: unknown) => {
				published.push({ type, payload });
			},
		};
		const userEntityService = {
			pack: (user: MiUser) => Promise.resolve({ id: user.id, username: user.id }),
		};

		const service = new MahjongService(
			redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			userEntityService as unknown as ConstructorParameters<typeof MahjongService>[1],
			globalEventService as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
			{} as unknown as ConstructorParameters<typeof MahjongService>[4],
			{} as unknown as ConstructorParameters<typeof MahjongService>[5],
		);

		return { service, store, published };
	}

	const owner = { id: 'user1' } as unknown as MiUser;
	const user3 = { id: 'user3' } as unknown as MiUser;

	test('kicks a player out of the seat and publishes kicked, left and changeReadyStates', async () => {
		const { service, store, published } = createLobbyService(createLobbyRoom());
		try {
			const room = await service.kickUser('test-room', owner, 3);

			expect(room).not.toBeNull();
			expect(room!.user3Id).toBeNull();
			expect(room!.user4Id).toBe('user4');
			expect(room!.user3Ready).toBe(false);
			// 保存済みルームにも反映されている
			expect(JSON.parse(store.get('mahjong:room:test-room')!).user3Id).toBeNull();

			expect(published.map(call => call.type)).toEqual(['kicked', 'left', 'changeReadyStates']);
			expect(published[0]!.payload).toEqual({ index: 3, userId: 'user3' });
			expect(published[1]!.payload).toEqual({ index: 3 });
			expect(published[2]!.payload).toEqual({ user1: true, user2: true, user3: false, user4: false });
		} finally {
			service.dispose();
		}
	});

	test('rejects a kick requested by a non-owner', async () => {
		const { service, published } = createLobbyService(createLobbyRoom());
		try {
			await expect(service.kickUser('test-room', user2, 3)).rejects.toThrow('access denied');

			const room = await service.getRoom('test-room');
			expect(room!.user3Id).toBe('user3');
			expect(published).toEqual([]);
		} finally {
			service.dispose();
		}
	});

	test('does not kick once the game has started', async () => {
		const room = createLobbyRoom();
		room.isStarted = true;
		room.startedAt = new Date(0).toISOString();
		const { service, published } = createLobbyService(room);
		try {
			expect(await service.kickUser('test-room', owner, 3)).toBeNull();

			const latest = await service.getRoom('test-room');
			expect(latest!.user3Id).toBe('user3');
			expect(published).toEqual([]);
		} finally {
			service.dispose();
		}
	});

	test('does not kick an empty seat or a CPU seat', async () => {
		const lobby = createLobbyRoom();
		lobby.user4Id = null;
		lobby.user4 = null;
		lobby.user2Id = null;
		lobby.user2 = null;
		lobby.user2Ai = true;
		const { service, published } = createLobbyService(lobby);
		try {
			// 空席
			expect(await service.kickUser('test-room', owner, 4)).toBeNull();
			// CPUの席はremoveAiで削除する
			expect(await service.kickUser('test-room', owner, 2)).toBeNull();

			const latest = await service.getRoom('test-room');
			expect(latest!.user2Ai).toBe(true);
			expect(latest!.user3Id).toBe('user3');
			expect(published).toEqual([]);
		} finally {
			service.dispose();
		}
	});

	test('lets a kicked player join the room again', async () => {
		const { service } = createLobbyService(createLobbyRoom());
		try {
			expect(await service.kickUser('test-room', owner, 3)).not.toBeNull();

			const rejoined = await service.joinRoom('test-room', user3);
			expect(rejoined!.user3Id).toBe('user3');
		} finally {
			service.dispose();
		}
	});
});

describe('MahjongService invitations', () => {
	function createInvitationService(room: MahjongRoom, options: { blocking?: Set<string>; blocked?: Set<string> } = {}) {
		const store = new Map<string, string>();
		store.set(`mahjong:room:${room.id}`, JSON.stringify(room));
		const { redisClient } = createRedisMock(store);

		const published: Array<{ type: string; payload: unknown }> = [];
		const globalEventService = {
			publishMahjongRoomStream: (_roomId: string, type: string, payload: unknown) => {
				published.push({ type, payload });
			},
		};
		const userEntityService = {
			pack: (user: MiUser) => Promise.resolve({ id: user.id, username: user.id }),
			isLocalUser: () => true,
		};
		const created: Array<{ userId: string; type: string; data: Record<string, unknown>; notifierId?: string }> = [];
		const deleted: Array<{ userId: string; roomId: string }> = [];
		const notificationService = {
			createNotification: (userId: string, type: string, data: Record<string, unknown>, notifierId?: string) => {
				created.push({ userId, type, data, notifierId });
			},
			deleteMahjongInvitation: (userId: string, roomId: string) => {
				deleted.push({ userId, roomId });
				return Promise.resolve();
			},
		};
		const cacheService = {
			userBlockingCache: { fetch: () => Promise.resolve(options.blocking ?? new Set<string>()) },
			userBlockedCache: { fetch: () => Promise.resolve(options.blocked ?? new Set<string>()) },
		};

		const service = new MahjongService(
			redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			userEntityService as unknown as ConstructorParameters<typeof MahjongService>[1],
			globalEventService as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
			notificationService as unknown as ConstructorParameters<typeof MahjongService>[4],
			cacheService as unknown as ConstructorParameters<typeof MahjongService>[5],
		);

		return { service, store, published, created, deleted };
	}

	// 部屋主(user1)と参加者(user2)が決まっていて、3・4番席が空いている対局前のルーム
	function createOpenLobbyRoom(): MahjongRoom {
		return {
			...createRoom(),
			startedAt: null,
			isStarted: false,
			isEnded: false,
			user3Id: null,
			user3: null,
			user3Ready: false,
			user4Id: null,
			user4: null,
			user4Ready: false,
		};
	}

	const owner = { id: 'user1' } as unknown as MiUser;
	const player2 = { id: 'user2' } as unknown as MiUser;
	const player3 = { id: 'user3' } as unknown as MiUser;
	const guest = { id: 'user5' } as unknown as MiUser;

	test('invites a local user, records the invitation and notifies the invitee', async () => {
		const room = createOpenLobbyRoom();
		room.isInviteOnly = true;
		const { service, store, published, created } = createInvitationService(room);
		try {
			const result = await service.inviteUser('test-room', owner, guest);

			expect(result.ok).toBe(true);
			expect(result.ok && result.room.invitations).toEqual([{ userId: 'user5', inviterId: 'user1', user: { id: 'user5', username: 'user5' } }]);
			expect(JSON.parse(store.get('mahjong:room:test-room')!).invitations).toHaveLength(1);
			expect(published).toEqual([{ type: 'invited', payload: { user: { id: 'user5', username: 'user5' }, inviterId: 'user1' } }]);
			expect(created).toEqual([{ userId: 'user5', type: 'mahjongInvited', data: { roomId: 'test-room' }, notifierId: 'user1' }]);
		} finally {
			service.dispose();
		}
	});

	test('lets an invited user join an invite-only room and consumes the invitation', async () => {
		const room = createOpenLobbyRoom();
		room.isInviteOnly = true;
		const { service, published, deleted } = createInvitationService(room);
		try {
			expect((await service.inviteUser('test-room', player2, guest)).ok).toBe(true);

			const joined = await service.joinRoom('test-room', guest);

			expect(joined!.user3Id).toBe('user5');
			expect(joined!.invitations).toEqual([]);
			expect(deleted).toEqual([{ userId: 'user5', roomId: 'test-room' }]);
			expect(published.map(call => call.type)).toEqual(['invited', 'joined', 'invitationCanceled']);
		} finally {
			service.dispose();
		}
	});

	test('refuses to let a user without an invitation join an invite-only room', async () => {
		const room = createOpenLobbyRoom();
		room.isInviteOnly = true;
		const { service } = createInvitationService(room);
		try {
			expect(await service.joinRoom('test-room', guest)).toBeNull();

			const latest = await service.getRoom('test-room');
			expect(latest!.user3Id).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('lets any participant invite and refuses non-members, players and double invitations', async () => {
		const room = createOpenLobbyRoom();
		const { service } = createInvitationService(room);
		try {
			// 部屋主でなくても参加者は招待できる
			expect((await service.inviteUser('test-room', player2, guest)).ok).toBe(true);
			// 参加者ではない人は招待できない
			expect(await service.inviteUser('test-room', guest, { id: 'user7' } as unknown as MiUser)).toEqual({ ok: false, reason: 'notMember' });
			// 参加済みの人は招待できない
			expect(await service.inviteUser('test-room', owner, player2)).toEqual({ ok: false, reason: 'cannotInvite' });
			// 二重招待は断る
			expect(await service.inviteUser('test-room', owner, guest)).toEqual({ ok: false, reason: 'alreadyInvited' });
		} finally {
			service.dispose();
		}
	});

	test('refuses invitations for a full room, a block, a started game and a missing room', async () => {
		const full = createOpenLobbyRoom();
		full.user3Id = 'user3';
		full.user4Id = 'user4';
		const { service: fullService } = createInvitationService(full);
		try {
			expect(await fullService.inviteUser('test-room', owner, guest)).toEqual({ ok: false, reason: 'roomFull' });
		} finally {
			fullService.dispose();
		}

		const { service: blockingService } = createInvitationService(createOpenLobbyRoom(), { blocking: new Set(['user5']) });
		try {
			expect(await blockingService.inviteUser('test-room', owner, guest)).toEqual({ ok: false, reason: 'cannotInvite' });
		} finally {
			blockingService.dispose();
		}

		const { service: blockedService } = createInvitationService(createOpenLobbyRoom(), { blocked: new Set(['user5']) });
		try {
			expect(await blockedService.inviteUser('test-room', owner, guest)).toEqual({ ok: false, reason: 'cannotInvite' });
		} finally {
			blockedService.dispose();
		}

		const { service: startedService } = createInvitationService(createRoom());
		try {
			expect(await startedService.inviteUser('test-room', owner, guest)).toEqual({ ok: false, reason: 'gameStarted' });
		} finally {
			startedService.dispose();
		}

		const { service } = createInvitationService(createOpenLobbyRoom());
		try {
			expect(await service.inviteUser('missing-room', owner, guest)).toEqual({ ok: false, reason: 'noSuchRoom' });
		} finally {
			service.dispose();
		}
	});

	test('cancels an invitation and deletes the notification', async () => {
		const room = createOpenLobbyRoom();
		room.isInviteOnly = true;
		const { service, store, published, deleted } = createInvitationService(room);
		try {
			expect((await service.inviteUser('test-room', player2, guest)).ok).toBe(true);

			// 参加者でないと取り消せない
			expect(await service.cancelInvitation('test-room', { id: 'user9' } as unknown as MiUser, 'user5')).toEqual({ ok: false, reason: 'notMember' });
			// 招待されていない人の分は取り消せない
			expect(await service.cancelInvitation('test-room', player2, 'user3')).toEqual({ ok: false, reason: 'noSuchInvitation' });

			// 部屋主は誰が送った招待でも取り消せる
			const result = await service.cancelInvitation('test-room', owner, 'user5');
			expect(result.ok).toBe(true);
			expect(result.ok && result.room.invitations).toEqual([]);
			expect(JSON.parse(store.get('mahjong:room:test-room')!).invitations).toEqual([]);
			expect(deleted).toEqual([{ userId: 'user5', roomId: 'test-room' }]);
			expect(published.map(call => call.type)).toEqual(['invited', 'invitationCanceled']);
		} finally {
			service.dispose();
		}
	});

	test('a kicked player cannot rejoin an invite-only room', async () => {
		const room = createOpenLobbyRoom();
		room.isInviteOnly = true;
		const { service, published, deleted } = createInvitationService(room);
		try {
			expect((await service.inviteUser('test-room', owner, player3)).ok).toBe(true);
			expect((await service.joinRoom('test-room', player3))!.user3Id).toBe('user3');

			const kicked = await service.kickUser('test-room', owner, 3);
			expect(kicked!.user3Id).toBeNull();
			// 参加時に招待は消費済みなので、追放で招待を削除することはない
			expect(deleted).toEqual([{ userId: 'user3', roomId: 'test-room' }]);
			expect(published.map(call => call.type)).toEqual(['invited', 'joined', 'invitationCanceled', 'kicked', 'left', 'changeReadyStates']);

			// 招待制のルームから追放された人は、招待し直されるまで参加できない
			expect(await service.joinRoom('test-room', player3)).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('kicking a player with a pending invitation removes the invitation and the notification', async () => {
		const room = createOpenLobbyRoom();
		room.isInviteOnly = true;
		// 参加者が決まった後に招待制へ切り替え、招待が残っている状態
		room.user3Id = 'user3';
		room.user3 = { id: 'user3', username: 'user3' } as unknown as MahjongRoom['user3'];
		room.user3Ready = true;
		room.invitations = [{ userId: 'user3', inviterId: 'user2', user: null }];
		const { service, published, deleted } = createInvitationService(room);
		try {
			const kicked = await service.kickUser('test-room', owner, 3);

			expect(kicked!.user3Id).toBeNull();
			expect(kicked!.invitations).toEqual([]);
			expect(deleted).toEqual([{ userId: 'user3', roomId: 'test-room' }]);
			expect(published.map(call => call.type)).toEqual(['kicked', 'left', 'invitationCanceled', 'changeReadyStates']);
		} finally {
			service.dispose();
		}
	});

	test('publishes inviteOnlyChanged when the owner toggles the setting', async () => {
		const { service, store, published } = createInvitationService(createOpenLobbyRoom());
		try {
			// 部屋主以外は変更できない
			await service.updateSettings('test-room', player2, 'isInviteOnly', true);
			expect(JSON.parse(store.get('mahjong:room:test-room')!).isInviteOnly).toBe(false);

			await service.updateSettings('test-room', owner, 'isInviteOnly', true);
			expect(JSON.parse(store.get('mahjong:room:test-room')!).isInviteOnly).toBe(true);
			expect(published).toEqual([{ type: 'inviteOnlyChanged', payload: { isInviteOnly: true } }]);
		} finally {
			service.dispose();
		}
	});

	test('does not expose invitations in the lobby summary', async () => {
		const room = createOpenLobbyRoom();
		room.isStarted = true;
		room.startedAt = new Date(0).toISOString();
		room.isInviteOnly = true;
		room.invitations = [{ userId: 'user5', inviterId: 'user1', user: null }];
		const { service } = createInvitationService(room);
		try {
			const summary = await service.packRoomSummary(room);

			expect(summary.isInviteOnly).toBe(true);
			expect(summary.invitations).toEqual([]);
		} finally {
			service.dispose();
		}
	});

	test('treats rooms created before the invitation feature as public rooms', async () => {
		const legacy = { ...createOpenLobbyRoom(), isInviteOnly: undefined, invitations: undefined };
		const store = new Map<string, string>();
		store.set('mahjong:room:test-room', JSON.stringify(legacy));
		const { redisClient } = createRedisMock(store);
		const service = new MahjongService(
			redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			{ pack: (user: MiUser) => Promise.resolve({ id: user.id, username: user.id }), isLocalUser: () => true } as unknown as ConstructorParameters<typeof MahjongService>[1],
			{ publishMahjongRoomStream: () => { } } as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
			{} as unknown as ConstructorParameters<typeof MahjongService>[4],
			{} as unknown as ConstructorParameters<typeof MahjongService>[5],
		);
		try {
			const room = await service.getRoom('test-room');

			expect(room!.isInviteOnly).toBe(false);
			expect(room!.invitations).toEqual([]);
			// 招待がなくても参加できる
			expect((await service.joinRoom('test-room', guest))!.user3Id).toBe('user5');
		} finally {
			service.dispose();
		}
	});
});

describe('MahjongService turn and call deadlines', () => {
	const TIMER_KEY = 'mahjong:gameTimerDeadline:test-room';

	type TimerRecord = {
		mode: string;
		house?: string;
		turnCount?: number;
		deadlineAt: number;
	};

	function createTimerService(room: MahjongRoom, store = new Map<string, string>()) {
		store.set(`mahjong:room:${room.id}`, JSON.stringify(room));
		const { redisClient } = createRedisMock(store);

		const service = new MahjongService(
			redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			{} as unknown as ConstructorParameters<typeof MahjongService>[1],
			{ publishMahjongRoomStream: () => { } } as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
			{} as unknown as ConstructorParameters<typeof MahjongService>[4],
			{} as unknown as ConstructorParameters<typeof MahjongService>[5],
		);

		return { service, store, redisClient };
	}

	function readTimerRecord(store: Map<string, string>): TimerRecord {
		const raw = store.get(TIMER_KEY);
		expect(raw).toBeDefined();
		return JSON.parse(raw!) as TimerRecord;
	}

	// e が m5 (17) を捨てると、s がポン・チー・大明槓を同時に要求できる状態。
	// 山は残りがあり、流局しない枚数にしておく。
	function createCallAskingState(): Mmj.MasterState {
		return Mmj.MasterGameEngine.createInitialState({
			handTiles: {
				e: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 17],
				s: [16, 18, 19, 13, 21, 57, 58, 59, 61, 62, 63, 65, 66],
				w: [22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38],
				n: [39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51],
			},
			tiles: [52, 53, 54, 55, 56, 60, 64, 67, 68, 69, 70],
			kingTiles: [125, 126, 127, 128],
			activatedDorasCount: 1,
			turn: 'e',
			turnCount: 5,
			drawnTile: 17,
		});
	}

	// house を手番とした状態。満了時間は room.timeLimitForEachTurn (30秒)。
	function createTurnState(house: Mmj.House, turnCount: number): Mmj.MasterState {
		return {
			...createCallAskingState(),
			turn: house,
			drawnTile: null,
			turnCount,
		};
	}

	const seat1 = { id: 'user1' } as unknown as MiUser;
	const seat2 = { id: 'user2' } as unknown as MiUser;
	const seat3 = { id: 'user3' } as unknown as MiUser;

	test('waitForTurn writes the turn deadline for a human player', async () => {
		const room = createRoom();
		room.gameState = createTurnState('s', 5);
		const { service, store, redisClient } = createTimerService(room);
		try {
			await (service as unknown as {
				waitForTurn: (room: MahjongRoom, house: Mmj.House, mj: Mmj.MasterGameEngine) => Promise<void>;
			}).waitForTurn(room, 's', new Mmj.MasterGameEngine(room.gameState));

			const record = readTimerRecord(store);
			expect(record.mode).toBe('turn');
			expect(record.house).toBe('s');
			expect(record.turnCount).toBe(5);
			// 満了時間は room.timeLimitForEachTurn (30秒)
			expect(record.deadlineAt - Date.now()).toBeGreaterThan(29000);
			expect(record.deadlineAt - Date.now()).toBeLessThanOrEqual(30000);
			// キーの失効は期限そのものに一致させる (EXAT で絶対時刻)
			const setCall = redisClient.set.mock.calls.find(([key]) => key === TIMER_KEY);
			expect(setCall?.[2]).toBe('EXAT');
			expect(setCall?.[3]).toBe(Math.ceil(record.deadlineAt / 1000));
		} finally {
			service.dispose();
		}
	});

	test('waitForTurn does not write a deadline for an AI turn', async () => {
		const room = createRoom();
		room.user2Ai = true;
		room.gameState = createTurnState('s', 5);
		const { service, store } = createTimerService(room);
		try {
			await (service as unknown as {
				waitForTurn: (room: MahjongRoom, house: Mmj.House, mj: Mmj.MasterGameEngine) => Promise<void>;
			}).waitForTurn(room, 's', new Mmj.MasterGameEngine(room.gameState));

			expect(store.get(TIMER_KEY)).toBeUndefined();
		} finally {
			service.dispose();
		}
	});

	test('dahai writes the call deadline when the asking starts, and the resolution replaces it', async () => {
		const room = createRoom();
		room.gameState = createCallAskingState();
		const { service, store } = createTimerService(room);
		vi.useFakeTimers();
		try {
			await (service as unknown as {
				dahaiLocked: (room: MahjongRoom, mj: Mmj.MasterGameEngine, house: Mmj.House, tile: Mmj.TileId, riichi?: boolean) => Promise<void>;
			}).dahaiLocked(room, new Mmj.MasterGameEngine(room.gameState), 'e', 17);

			const record = readTimerRecord(store);
			expect(record.mode).toBe('call');
			expect(record.house).toBeUndefined();
			expect(record.turnCount).toBe(5);
			expect(record.deadlineAt - Date.now()).toBeGreaterThan(29000);
			expect(record.deadlineAt - Date.now()).toBeLessThanOrEqual(30000);

			// s が全ての鳴きを辞退すると、回答待ちの期限は消えて s の手番の期限に置き換わる
			await service.commit_nop('test-room', seat2);
			await vi.advanceTimersByTimeAsync(600);

			expect(store.get('mahjong:gameCallingAsking:test-room')).toBeUndefined();
			const resolved = readTimerRecord(store);
			expect(resolved.mode).toBe('turn');
			expect(resolved.house).toBe('s');
		} finally {
			service.dispose();
			vi.useRealTimers();
		}
	});

	test('clearTurnWaitingTimer removes the turn waiting and the deadline keys', async () => {
		const room = createRoom();
		room.gameState = createTurnState('s', 5);
		const { service, store } = createTimerService(room);
		try {
			await (service as unknown as {
				waitForTurn: (room: MahjongRoom, house: Mmj.House, mj: Mmj.MasterGameEngine) => Promise<void>;
			}).waitForTurn(room, 's', new Mmj.MasterGameEngine(room.gameState));
			expect(store.get(TIMER_KEY)).toBeDefined();

			await (service as unknown as {
				clearTurnWaitingTimer: (roomId: string) => Promise<void>;
			}).clearTurnWaitingTimer(room.id);

			expect(store.get(TIMER_KEY)).toBeUndefined();
			expect(store.get('mahjong:gameTurnWaiting:test-room')).toBeUndefined();
		} finally {
			service.dispose();
		}
	});

	test('endKyoku removes the deadline because the waiting is over', async () => {
		const room = createRoom();
		room.gameState = createTurnState('s', 5);
		const { service, store } = createTimerService(room);
		try {
			store.set(TIMER_KEY, JSON.stringify({ mode: 'turn', house: 's', turnCount: 5, deadlineAt: Date.now() + 30000 } satisfies TimerRecord));

			await (service as unknown as {
				endKyoku: (room: MahjongRoom, mj: Mmj.MasterGameEngine, kyokuResult: { agariHouse: Mmj.House | null; tenpaiHouses: Mmj.House[] }) => Promise<void>;
			}).endKyoku(room, new Mmj.MasterGameEngine(room.gameState), { agariHouse: null, tenpaiHouses: [] });

			expect(store.get(TIMER_KEY)).toBeUndefined();
			// 次局確認の待機は始まっている
			expect(store.get('mahjong:gameNextKyokuConfirmation:test-room')).toBeDefined();
		} finally {
			service.dispose();
		}
	});

	test('packRoom returns the server remaining time for the player whose turn it is', async () => {
		const room = createRoom();
		room.gameState = createTurnState('s', 5);
		const { service, store } = createTimerService(room);
		try {
			store.set(TIMER_KEY, JSON.stringify({ mode: 'turn', house: 's', turnCount: 5, deadlineAt: Date.now() + 7000 } satisfies TimerRecord));

			const mine = await service.packRoom(room, seat2);
			expect(mine.timer).not.toBeNull();
			expect(mine.timer!.mode).toBe('turn');
			expect(mine.timer!.remainingMs).toBeGreaterThan(6000);
			expect(mine.timer!.remainingMs).toBeLessThanOrEqual(7000);

			// 他家には見せない
			expect((await service.packRoom(room, seat3)).timer).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('packRoom hides a deadline recorded at a stale turnCount', async () => {
		const room = createRoom();
		room.gameState = createTurnState('s', 5);
		const { service, store } = createTimerService(room);
		try {
			// サーバーが既に進行したあと (リロードのあいだに自動進行など) であれば見せない
			store.set(TIMER_KEY, JSON.stringify({ mode: 'turn', house: 's', turnCount: 4, deadlineAt: Date.now() + 7000 } satisfies TimerRecord));

			expect((await service.packRoom(room, seat2)).timer).toBeNull();

			// 記録した家と現在の要求者が違っていたら見せない
			store.set(TIMER_KEY, JSON.stringify({ mode: 'turn', house: 'w', turnCount: 5, deadlineAt: Date.now() + 7000 } satisfies TimerRecord));

			expect((await service.packRoom(room, seat2)).timer).toBeNull();
			expect((await service.packRoom(room, seat3)).timer).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('packRoom hides a deadline that has already passed', async () => {
		const room = createRoom();
		room.gameState = createTurnState('s', 5);
		const { service, store } = createTimerService(room);
		try {
			store.set(TIMER_KEY, JSON.stringify({ mode: 'turn', house: 's', turnCount: 5, deadlineAt: Date.now() - 1000 } satisfies TimerRecord));

			expect((await service.packRoom(room, seat2)).timer).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('packRoom shows the call remaining time only to the players being asked', async () => {
		const room = createCallingRoom();
		const { service, store } = createTimerService(room);
		try {
			store.set(TIMER_KEY, JSON.stringify({ mode: 'call', turnCount: 0, deadlineAt: Date.now() + 12000 } satisfies TimerRecord));

			// s (2番席) はロン・ポン・チー・カンを求められている
			const asked = await service.packRoom(room, seat2);
			expect(asked.timer).not.toBeNull();
			expect(asked.timer!.mode).toBe('call');
			expect(asked.timer!.remainingMs).toBeGreaterThan(11000);
			expect(asked.timer!.remainingMs).toBeLessThanOrEqual(12000);

			// e (1番席) は捨てた側なので残り時間は表示しない
			expect((await service.packRoom(room, seat1)).timer).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('packRoom hides a call deadline from a riichi player asked only to call', async () => {
		const room = createCallingRoom({ riichi: true });
		// リーチ中はロンだけを求められるので、ポン単位の問い出しでは残り時間を見せない
		room.gameState!.askings.ron = null;
		room.gameState!.askings.cii = null;
		room.gameState!.askings.kan = null;
		const { service, store } = createTimerService(room);
		try {
			store.set(TIMER_KEY, JSON.stringify({ mode: 'call', turnCount: 0, deadlineAt: Date.now() + 12000 } satisfies TimerRecord));

			expect((await service.packRoom(room, seat2)).timer).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('packRoom shows the call remaining time to a riichi player asked to ron', async () => {
		const room = createCallingRoom({ riichi: true });
		const { service, store } = createTimerService(room);
		try {
			store.set(TIMER_KEY, JSON.stringify({ mode: 'call', turnCount: 0, deadlineAt: Date.now() + 12000 } satisfies TimerRecord));

			// createCallingRoom は s にロンも要求している
			const asked = await service.packRoom(room, seat2);
			expect(asked.timer!.mode).toBe('call');
		} finally {
			service.dispose();
		}
	});

	test('packRoom hides a call deadline recorded at a stale turnCount', async () => {
		const room = createCallingRoom();
		const { service, store } = createTimerService(room);
		try {
			store.set(TIMER_KEY, JSON.stringify({ mode: 'call', turnCount: 4, deadlineAt: Date.now() + 12000 } satisfies TimerRecord));

			expect((await service.packRoom(room, seat2)).timer).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('packRoom returns no remaining time once the game has ended', async () => {
		const room = createRoom();
		room.gameState = createTurnState('s', 5);
		room.isEnded = true;
		const { service, store } = createTimerService(room);
		try {
			store.set(TIMER_KEY, JSON.stringify({ mode: 'turn', house: 's', turnCount: 5, deadlineAt: Date.now() + 7000 } satisfies TimerRecord));

			expect((await service.packRoom(room, seat2)).timer).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('packRoomSummary and packSpectatorRoom never expose the remaining time', async () => {
		const room = createRoom();
		room.gameState = createTurnState('s', 5);
		const { service, store } = createTimerService(room);
		try {
			store.set(TIMER_KEY, JSON.stringify({ mode: 'turn', house: 's', turnCount: 5, deadlineAt: Date.now() + 7000 } satisfies TimerRecord));

			expect((await service.packRoomSummary(room)).timer).toBeNull();
			expect((await service.packSpectatorRoom(room)).timer).toBeNull();
		} finally {
			service.dispose();
		}
	});

	test('packSpectatorRoom sends the full state with askings and no per-player call flags', async () => {
		const room = createRoom();
		room.gameState = createCallAskingState();
		const { service } = createTimerService(room);
		try {
			const packed = await service.packSpectatorRoom(room);
			const state = packed.gameState as unknown as Mmj.PlayerState;

			expect(state.spectator).toBe(true);
			// 全手牌が素牌のまま届く (視点はクライアントの projectSpectatorState で伏せる)
			expect(state.handTiles.e).not.toEqual(expect.arrayContaining([0]));
			expect(state.handTiles.n).not.toEqual(expect.arrayContaining([0]));
			// 手番のツモ牌も観戦状態では開示される
			expect(state.drawnTile).toBe(17);
			// user1 視点の鳴き要求は漏らさず、要求そのものは askings で渡す
			expect(state.canPon).toBeNull();
			expect(state.canCii).toBeNull();
			expect(state.canKan).toBeNull();
			expect(state.canRon).toBeNull();
			expect(state.askings).toBeDefined();
			expect(state.askings?.pon).toBeNull();
		} finally {
			service.dispose();
		}
	});
});
