/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, assert, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { render, cleanup, fireEvent } from '@testing-library/vue';
import * as Mmj from 'misskey-mahjong';
import RoomGame from '@/pages/mahjong/room.game.vue';

const mocks = vi.hoisted(() => ({ $i: null as { id: string; username: string; name: string | null } | null }));

vi.mock('@/i.js', () => ({
	// 観戦者は非ログインでも見られる。対戦者描画のテストだけ setups でログインさせる
	get $i() { return mocks.$i; },
	ensureSignin: () => { throw new Error('spectator must not call ensureSignin'); },
}));

vi.mock('@/router.js', () => ({
	useRouter: () => ({ push: vi.fn(), pushByPath: vi.fn() }),
}));

vi.mock('@/utility/sound.js', () => ({
	playUrl: vi.fn(),
}));

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: vi.fn(),
}));

vi.mock('@/components/global/MkAvatar.vue', () => ({
	default: { template: '<div/>' },
}));

vi.mock('@/components/global/MkA.vue', () => ({
	default: { template: '<a><slot/></a>' },
}));

const HAND_E: Mmj.TileId[] = [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49];
const HAND_S: Mmj.TileId[] = [2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50];
const HAND_W: Mmj.TileId[] = [3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47, 51];
const HAND_N: Mmj.TileId[] = [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52];

/** packSpectatorRoom が返す全手牌公開・askings 付きの観戦状態 */
function createSpectatorState(preset: Partial<Mmj.PlayerState> = {}): Mmj.PlayerState {
	return {
		user1House: 'e',
		user2House: 's',
		user3House: 'w',
		user4House: 'n',
		round: 'e',
		kyoku: 1,
		honba: 0,
		kyotaku: 0,
		turnCount: 4,
		tilesCount: 65,
		doraIndicateTiles: [125],
		drawnTile: null,
		handTiles: { e: [...HAND_E], s: [...HAND_S], w: [...HAND_W], n: [...HAND_N] },
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
		turn: null,
		canPon: null,
		canCii: null,
		canKan: null,
		canRon: null,
		spectator: true,
		askings: { ron: null, pon: null, cii: null, kan: null },
		...preset,
	};
}

function createRoom(gameState: Mmj.PlayerState) {
	const user = (id: string) => ({ id, username: id, name: null });
	return {
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
		gameState,
		timer: null,
	};
}

function createConnection() {
	return {
		send: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		dispose: vi.fn(),
	};
}

function renderSpectate(gameState: Mmj.PlayerState, initialViewUserNumber: 1 | 2 | 3 | 4) {
	vi.useFakeTimers();
	const connection = createConnection();
	const result = render(RoomGame, {
		props: {
			room: createRoom(gameState) as never,
			connection: connection as never,
			spectate: true,
			initialViewUserNumber,
		},
	});
	return { ...result, connection };
}

describe('麻雀の観戦モード (対戦画面を視点付きで使う)', () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
		mocks.$i = null;
	});

	test('観戦バッジと視点タブが表示され、操作系は描画されない', () => {
		// user2 (席 s) がポンを求められている状態
		const state = createSpectatorState({
			askings: {
				ron: null,
				pon: { callee: 'e', callers: ['s'] },
				cii: null,
				kan: null,
			},
		});
		const page = renderSpectate(state, 2);

		const badge = page.container.querySelector('[data-testid="mahjong-spectating-badge"]');
		assert.ok(badge, 'spectating badge should be rendered');
		assert.ok(badge!.textContent!.includes('観戦'), `badge text: ${badge!.textContent}`);

		for (const n of [1, 2, 3, 4]) {
			assert.ok(page.container.querySelector(`[data-testid="mahjong-spectate-view-${n}"]`), `view button ${n} should exist`);
		}
		assert.equal(
			page.container.querySelector<HTMLButtonElement>('[data-testid="mahjong-spectate-view-2"]')!.getAttribute('aria-pressed'),
			'true',
			'initial view tab should be pressed',
		);

		// 打牌・鳴きボタン (プレイヤーなら askings.pon からポンボタンが出る状況でも) 観戦では一切出ない
		assert.equal(page.container.querySelectorAll('[data-testid^="mahjong-action-"]').length, 0);

		// 自動モードのトグルも出ない
		assert.equal(page.container.querySelectorAll('[data-testid^="mahjong-auto-mode-"]').length, 0);
	});

	test('対戦者視点では同じ鳴き要求でポンボタンが出る (観戦との対比)', () => {
		// packRoom が user4 (席 n) 向けに詰めた状態: 自手 (n) は素牌、他家は 0、canPon が直属
		const state = createSpectatorState({
			user1House: 's',
			user2House: 'w',
			user3House: 'n',
			user4House: 'e',
			spectator: false,
			askings: undefined,
			// 席 n = user1 ... 自手 (user4 = 席 e) を素牌、他家席を 0 にする
			handTiles: { e: [...HAND_E], s: new Array(13).fill(0) as never, w: new Array(13).fill(0) as never, n: new Array(13).fill(0) as never },
			canPon: { callee: 's' },
		});
		mocks.$i = { id: 'u4', username: 'u4', name: null };
		vi.useFakeTimers();
		const connection = createConnection();
		const page = render(RoomGame, {
			props: {
				room: createRoom(state) as never,
				connection: connection as never,
			},
		});

		// canPon が立っていれば対戦者画面ではポンボタンが出る
		assert.ok(page.container.querySelector('[data-testid="mahjong-action-pon"]'), 'pon button should render for player view');
	});

	test('視点タブのクリックで show-room を取り直し、視点が切り替わる', async () => {
		const state = createSpectatorState();
		const page = renderSpectate(state, 2);

		// 初期視点 user2 の名札 (自家) は u2
		const meTag = () => page.container.querySelector('[data-testid="mahjong-player-of-me"]')!.textContent!;
		assert.ok(meTag().includes('u2'), `me tag before switch: ${meTag()}`);

		// 席が回転した (user4 が東家) 次局相当の観戦状態を show-room が返す
		const next = createSpectatorState({
			user1House: 's',
			user2House: 'w',
			user3House: 'n',
			user4House: 'e',
		});
		const { misskeyApi } = await import('@/utility/misskey-api.js');
		vi.mocked(misskeyApi).mockResolvedValue({ ...createRoom(next), invitations: [] } as never);
		// 非同期の取り直しを待つのでタイマーは実タイマーに戻す
		vi.useRealTimers();
		await fireEvent.click(page.container.querySelector('[data-testid="mahjong-spectate-view-4"]')!);
		await vi.waitFor(async () => {
			await nextTick();
			if (meTag().includes('u4')) return;
			throw new Error(`me tag after switch: ${meTag()}`);
		});

		assert.deepEqual(vi.mocked(misskeyApi).mock.calls[0], ['mahjong/show-room', { roomId: 'room' }]);
		assert.equal(
			page.container.querySelector<HTMLButtonElement>('[data-testid="mahjong-spectate-view-4"]')!.getAttribute('aria-pressed'),
			'true',
		);
		assert.equal(
			page.container.querySelector<HTMLButtonElement>('[data-testid="mahjong-spectate-view-2"]')!.getAttribute('aria-pressed'),
			'false',
		);
		// 視点切り替えで connection.send は使わない (server への打点なし)
		assert.equal(page.connection.send.mock.calls.length, 0);
	});

	test('初期視点未指定なら東家の席のプレイヤーが視点になる', () => {
		// user3 が東家 (user3House: 'e') の状態
		const state = createSpectatorState({
			user1House: 'w',
			user2House: 'n',
			user3House: 'e',
			user4House: 's',
		});
		vi.useFakeTimers();
		const page = render(RoomGame, {
			props: {
				room: createRoom(state) as never,
				connection: createConnection() as never,
				spectate: true,
			},
		});

		const meTag = page.container.querySelector('[data-testid="mahjong-player-of-me"]')!.textContent!;
		assert.ok(meTag.includes('u3'), `me tag should show dealer (u3), got: ${meTag}`);
	});
});
