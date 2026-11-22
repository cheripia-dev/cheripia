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
	};
}

function createExhaustedState(): Mmj.MasterState {
	// 山を空にし、他家が m1 を鳴けない手牌にして、asking なしの流局を作る
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
	pon: null | boolean;
	cii: null | false | 'x__' | '_x_' | '__x';
	kan: null | boolean;
	ron: Record<Mmj.House, null | boolean>;
};

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
			pon: { callee: 'e', caller: 's' },
			cii: { callee: 'e', caller: 's' },
			kan: { callee: 'e', caller: 's' },
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
	const commands = {
		del: vi.fn((key: string) => {
			const deleted = store.delete(key) || zsets.delete(key);
			return Promise.resolve(deleted ? 1 : 0);
		}),
		get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
		set: vi.fn((key: string, value: string) => {
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
	return { redisClient: { ...commands, multi }, store, zsets };
}

function createCallingService(room: MahjongRoom) {
	const store = new Map<string, string>();
	store.set(`mahjong:room:${room.id}`, JSON.stringify(room));
	store.set(`mahjong:gameCallingAsking:${room.id}`, JSON.stringify({
		pon: null,
		cii: null,
		kan: null,
		ron: { e: null, s: null, w: null, n: null },
	} satisfies CallingAnswersForTest));

	const { redisClient } = createRedisMock(store);

	const service = new MahjongService(
		redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
		{} as unknown as ConstructorParameters<typeof MahjongService>[1],
		{} as unknown as ConstructorParameters<typeof MahjongService>[2],
		{} as unknown as ConstructorParameters<typeof MahjongService>[3],
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
		);

		try {
			// m1 を捨てると山が尽きて asking なしの流局になる
			await (service as unknown as {
				dahai: (room: MahjongRoom, mj: Mmj.MasterGameEngine, house: Mmj.House, tile: Mmj.TileId, riichi?: boolean) => Promise<void>;
			}).dahai(room, mj, 'e', 1);

			expect(published.map(call => call.type)).toEqual(['dahai', 'ryuukyoku']);
			expect(published[0]!.payload).toEqual({ house: 'e', tile: 1, riichi: false });
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
			expect(room.gameState?.hoTiles.e.at(-1)).toBe(1);
		} finally {
			service.dispose();
		}
	});

	test('publishes ryuukyoku result when a calling interruption is declined', async () => {
		const room = createRoom();
		const state = createExhaustedState();
		// 最後の捨て牌を済ませた状態で、鳴きの回答待ちから流局する
		state.handTiles.e.pop();
		state.hoTiles.e.push(37);
		state.turn = null;
		state.nextTurnAfterAsking = 's';
		state.askings = {
			ron: null,
			pon: { callee: 'e', caller: 's' },
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
		);

		try {
			const answers = {
				pon: false,
				cii: false as const,
				kan: false,
				ron: { e: false, s: false, w: false, n: false },
			};
			await (service as unknown as {
				answer: (room: MahjongRoom, mj: Mmj.MasterGameEngine, callingAnswers: typeof answers) => Promise<void>;
			}).answer(room, mj, answers);

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
			expect(answers.pon).toBe(false);
			expect(answers.cii).toBe(false);
			expect(answers.kan).toBe(false);
		} finally {
			service.dispose();
		}
	});

	test('pon declines the same player\'s ron, cii and kan answers', async () => {
		const { service, store } = createCallingService(createCallingRoom());
		try {
			await service.commit_pon('test-room', user2);

			const answers = readCallingAnswers(store);
			expect(answers.pon).toBe(true);
			expect(answers.cii).toBe(false);
			expect(answers.kan).toBe(false);
			expect(answers.ron).toEqual({ e: null, s: false, w: null, n: null });
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
			expect(answers.pon).toBe(false);
			expect(answers.kan).toBe(false);
			expect(answers.ron).toEqual({ e: null, s: false, w: null, n: null });
		} finally {
			service.dispose();
		}
	});

	test('kan declines the same player\'s ron, pon and cii answers', async () => {
		const { service, store } = createCallingService(createCallingRoom());
		try {
			await service.commit_kan('test-room', user2);

			const answers = readCallingAnswers(store);
			expect(answers.kan).toBe(true);
			expect(answers.pon).toBe(false);
			expect(answers.cii).toBe(false);
			expect(answers.ron).toEqual({ e: null, s: false, w: null, n: null });
		} finally {
			service.dispose();
		}
	});

	test('riichi player\'s illegal pon does not decline their ron answer', async () => {
		const { service, store } = createCallingService(createCallingRoom({ riichi: true }));
		try {
			await service.commit_pon('test-room', user2);

			const answers = readCallingAnswers(store);
			expect(answers.pon).toBe(false);
			expect(answers.cii).toBeNull();
			expect(answers.kan).toBeNull();
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
			expect(answers.pon).toBeNull();
			expect(answers.kan).toBeNull();
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

describe('MahjongService getActiveRooms', () => {
	function createService() {
		const redis = createRedisMock();
		const service = new MahjongService(
			redis.redisClient as unknown as ConstructorParameters<typeof MahjongService>[0],
			{} as unknown as ConstructorParameters<typeof MahjongService>[1],
			{} as unknown as ConstructorParameters<typeof MahjongService>[2],
			{} as unknown as ConstructorParameters<typeof MahjongService>[3],
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
