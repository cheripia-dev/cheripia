/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, assert, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { render, cleanup } from '@testing-library/vue';
import * as Mmj from 'misskey-mahjong';
import RoomGame from '@/pages/mahjong/room.game.vue';

vi.mock('@/i.js', () => ({
	$i: { id: 'u1', policies: { canSearchNotes: true } },
	ensureSignin: () => ({ id: 'u1', policies: { canSearchNotes: true } }),
}));

vi.mock('@/router.js', () => ({
	useRouter: () => ({ push: vi.fn(), pushByPath: vi.fn() }),
}));

vi.mock('@/utility/sound.js', () => ({
	playUrl: vi.fn(),
}));

vi.mock('@/components/global/MkAvatar.vue', () => ({
	default: { template: '<div/>' },
}));

vi.mock('@/components/global/MkA.vue', () => ({
	default: { template: '<a><slot/></a>' },
}));

function createPlayerState(preset: Partial<Mmj.PlayerState> = {}): Mmj.PlayerState {
	const base: Mmj.PlayerState = {
		user1House: 'e',
		user2House: 's',
		user3House: 'w',
		user4House: 'n',
		round: 'e',
		kyoku: 1,
		honba: 0,
		kyotaku: 0,
		turnCount: 0,
		tilesCount: 69,
		doraIndicateTiles: [125],
		drawnTile: null,
		handTiles: {
			e: [1, 5, 9, 13, 21, 25, 29, 33, 37, 41, 45, 49, 53],
			s: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			w: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			n: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		},
		hoTiles: { e: [], s: [], w: [], n: [] },
		huros: { e: [], s: [], w: [], n: [] },
		firstTurnFlags: { e: false, s: false, w: false, n: false },
		riichis: { e: false, s: false, w: false, n: false },
		riichiTiles: { e: null, s: null, w: null, n: null },
		doubleRiichis: { e: false, s: false, w: false, n: false },
		ippatsus: { e: false, s: false, w: false, n: false },
		rinshanFlags: { e: false, s: false, w: false, n: false },
		points: { e: 25000, s: 25000, w: 25000, n: 25000 },
		latestDahaiedTile: null,
		turn: 'e',
		canPon: null,
		canCii: null,
		canKan: null,
		canRon: null,
	};
	return { ...base, ...preset };
}

/** ページを開いた時点のルーム (gameState と timer) で対局画面を描画する */
function renderRoomGame(state: Mmj.PlayerState, timer: { mode: 'turn' | 'call'; remainingMs: number } | null) {
	vi.useFakeTimers();
	const connection = {
		send: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		dispose: vi.fn(),
	};
	const user = (id: string) => ({ id, username: id, name: null });
	const result = render(RoomGame, {
		props: {
			room: {
				id: 'room',
				isStarted: true,
				isEnded: false,
				user1Id: 'u1',
				user2Id: 'u2',
				user3Id: 'u3',
				user4Id: 'u4',
				user1: user('u1'),
				user2: user('u2'),
				user3: user('u3'),
				user4: user('u4'),
				timeLimitForEachTurn: 30,
				gameState: state,
				timer,
			} as never,
			connection: connection as never,
		},
	});
	return {
		...result,
		/** 残り時間表示 */
		timerText(): string {
			const el = result.container.querySelector<HTMLElement>('[data-testid="mahjong-turn-timer"]');
			assert.ok(el, 'turn timer should be rendered');
			return el.textContent ?? '';
		},
	};
}

describe('麻雀の残り時間表示 (リロード時のサーバーとのずれ)', () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	test('リロード時はサーバーの残り時間から数え始める (満了時間に戻さない)', () => {
		const page = renderRoomGame(createPlayerState({ turn: 'e', turnCount: 7 }), { mode: 'turn', remainingMs: 7000 });

		assert.ok(page.timerText().includes('7'), `expected 7 seconds, got: ${page.timerText()}`);
		assert.ok(!page.timerText().includes('30'), `must not restart from the full limit: ${page.timerText()}`);
	});

	test('鳴きを求められている場合は鳴き用の残り時間から数え始める', () => {
		const page = renderRoomGame(
			createPlayerState({ turn: null, turnCount: 4, canPon: { callee: 'e' } }),
			{ mode: 'call', remainingMs: 12000 },
		);

		assert.ok(page.timerText().includes('12'), `expected 12 seconds, got: ${page.timerText()}`);
		assert.ok(!page.timerText().includes('30'), `must not restart from the full limit: ${page.timerText()}`);
	});

	test('サーバーが手番待ちしていない状態では従来どおり満了時間から始める', () => {
		// 満了時間 (30秒) からの開始
		const page = renderRoomGame(createPlayerState({ turn: 'e', turnCount: 7 }), null);

		assert.ok(page.timerText().includes('30'), `expected the full limit, got: ${page.timerText()}`);
	});

	test('サーバーの残り時間が満了時間を越えていたら満了時間に丸める', () => {
		const page = renderRoomGame(createPlayerState({ turn: 'e', turnCount: 7 }), { mode: 'turn', remainingMs: 45000 });

		assert.ok(page.timerText().includes('30'), `expected the full limit, got: ${page.timerText()}`);
	});

	test('サーバーの残り時間が手番の要求と一致しなければ満了時間から始める', () => {
		// 手番なのに鳴き待ちの残り時間が届いた場合は使わない
		const page = renderRoomGame(createPlayerState({ turn: 'e', turnCount: 7 }), { mode: 'call', remainingMs: 12000 });

		assert.ok(page.timerText().includes('30'), `expected the full limit, got: ${page.timerText()}`);
	});

	test('サーバーの残り時間が 0 以下なら満了時間から始める', () => {
		const page = renderRoomGame(createPlayerState({ turn: 'e', turnCount: 7 }), { mode: 'turn', remainingMs: 0 });

		assert.ok(page.timerText().includes('30'), `expected the full limit, got: ${page.timerText()}`);
	});

	test('サーバーの残り時間から始まっても、その後は毎秒減っていく', async () => {
		const page = renderRoomGame(createPlayerState({ turn: 'e', turnCount: 7 }), { mode: 'turn', remainingMs: 7000 });

		assert.ok(page.timerText().includes('7'), `expected 7 seconds, got: ${page.timerText()}`);

		vi.advanceTimersByTime(2000);
		await nextTick();

		assert.ok(page.timerText().includes('5'), `expected 5 seconds after 2 seconds, got: ${page.timerText()}`);
	});
});
