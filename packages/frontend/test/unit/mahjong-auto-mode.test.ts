/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, assert, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { render, cleanup, fireEvent } from '@testing-library/vue';
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

vi.mock('@/components/MkUserOnlineIndicator.vue', () => ({
	default: { template: '<div/>' },
}));

type StreamHandler = (payload: unknown) => void;

function createConnection() {
	const handlers = new Map<string, Set<StreamHandler>>();
	const send = vi.fn();
	return {
		send,
		on: vi.fn((name: string, handler: StreamHandler) => {
			if (!handlers.has(name)) handlers.set(name, new Set());
			handlers.get(name)!.add(handler);
		}),
		off: vi.fn(),
		emit(name: string, payload: unknown) {
			for (const handler of handlers.get(name) ?? []) handler(payload);
		},
	};
}

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

function renderRoomGame(state: Mmj.PlayerState, isEnded = false) {
	const connection = createConnection();
	const user = (id: string) => ({ id, username: id, name: null });
	const result = render(RoomGame, {
		props: {
			room: {
				id: 'room',
				isStarted: true,
				isEnded,
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
			} as never,
			connection: connection as never,
		},
	});
	return { ...result, connection };
}

function sentActions(send: ReturnType<typeof vi.fn>, type: string) {
	return send.mock.calls.filter(([name]) => name === type);
}

type AutoModeKey = 'notCall' | 'tsumogiri' | 'hora';

/** 自動モードのトグル (鳴き無し / 自動ツモ切り / 自動和了) */
function modeToggle(container: Element, mode: AutoModeKey): HTMLElement {
	const button = container.querySelector<HTMLElement>(`[data-testid="mahjong-auto-mode-${mode}"]`);
	assert.ok(button, `${mode} toggle should be rendered`);
	return button;
}

async function enableAutoMode(container: Element, mode: AutoModeKey) {
	await fireEvent.click(modeToggle(container, mode));
	assert.strictEqual(modeToggle(container, mode).getAttribute('aria-pressed'), 'true');
	await nextTick();
}

function isActionShown(container: Element, name: string): boolean {
	return container.querySelector(`[data-testid="mahjong-action-${name}"]`) != null;
}

/** 自動送信 (AUTO_ACTION_MS = 300ms) より十分に進める */
async function runAutoAction() {
	await vi.advanceTimersByTimeAsync(400);
	await nextTick();
}

const zeros = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/** 123m 456m 789m 123p + 5s 単騎。5s (90) をツモると和了れる */
const horaHand13 = [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 89];
const horaTsumoTile = 90;
/** 1m 4枚と 1p のポン副露があり、暗槓 (1m) と加槓 (1p) ができる手牌。ツモ牌は 中 */
const kanHand13 = [1, 2, 3, 4, 5, 17, 29, 37, 49, 73, 81, 93, 125];
const kanTsumoTile = 133;
const ponPin1Huro: Mmj.Huro = { type: 'pon', tiles: [38, 39, 40], from: 's' };
/** 槓もリーチも和了もできない手牌。ツモ牌は 9p */
const plainHand13 = [1, 9, 17, 25, 33, 41, 49, 65, 73, 81, 93, 101, 129];
const plainTsumoTile = 69;
/** 234m 567m 234p + 5p と 5s の双拍子。5p (55) でロンもポンもできる */
const shanponHand13 = [5, 9, 13, 17, 21, 25, 41, 45, 49, 53, 54, 89, 90];
const shanponRonTile = 55;

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe('room.game auto mode toggle', () => {
	test('marks the pressed mode with the active style', async () => {
		const { container } = renderRoomGame(createPlayerState());

		await fireEvent.click(modeToggle(container, 'tsumogiri'));
		assert.ok(modeToggle(container, 'tsumogiri').className.includes('autoModeToggleOn'), 'the ON toggle should carry the active style');
		assert.ok(!modeToggle(container, 'notCall').className.includes('autoModeToggleOn'), 'the OFF toggle should not carry the active style');

		await fireEvent.click(modeToggle(container, 'tsumogiri'));
		assert.ok(!modeToggle(container, 'tsumogiri').className.includes('autoModeToggleOn'), 'the active style should go off with the mode');
	});

	test('is off by default and sends nothing', async () => {
		vi.useFakeTimers();
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: 'e',
			drawnTile: kanTsumoTile,
			handTiles: { e: [...kanHand13, kanTsumoTile], s: zeros, w: zeros, n: zeros },
		}));

		for (const mode of ['notCall', 'tsumogiri', 'hora'] as AutoModeKey[]) {
			assert.strictEqual(modeToggle(container, mode).getAttribute('aria-pressed'), 'false');
		}

		await runAutoAction();

		assert.strictEqual(connection.send.mock.calls.length, 0, 'nothing should be sent while all modes are off');
	});

	test('stays pressed while the mode is on', async () => {
		const { container } = renderRoomGame(createPlayerState());

		await fireEvent.click(modeToggle(container, 'notCall'));
		assert.strictEqual(modeToggle(container, 'notCall').getAttribute('aria-pressed'), 'true');

		await fireEvent.click(modeToggle(container, 'notCall'));
		assert.strictEqual(modeToggle(container, 'notCall').getAttribute('aria-pressed'), 'false');
	});
});

describe('room.game no-call mode', () => {
	test('passes automatically when only calls are offered', async () => {
		vi.useFakeTimers();
		// 捨て牌を送ってくる家 (s) の手番として、そのまま打牌をコミットできる状態にする
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: 's',
			handTiles: { e: kanHand13, s: zeros, w: zeros, n: zeros },
		}));

		await enableAutoMode(container, 'notCall');

		// 下家 (s) の捨て牌 1m に対してポンできる状態になる
		connection.emit('dahai', { house: 's', tile: 2, riichi: false });
		await nextTick();
		assert.ok(isActionShown(container, 'skip'), 'the answer should be asked');
		assert.ok(!isActionShown(container, 'pon'), 'pon button should be hidden');

		await runAutoAction();

		assert.deepStrictEqual(sentActions(connection.send, 'nop'), [['nop', {}]]);
		assert.strictEqual(sentActions(connection.send, 'pon').length, 0);
	});

	test('keeps ron and does not pass when ron is possible', async () => {
		vi.useFakeTimers();
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: 's',
			handTiles: { e: shanponHand13, s: zeros, w: zeros, n: zeros },
		}));

		await enableAutoMode(container, 'notCall');

		// 下家が 5p を捨てる (自家は 5p にロンもポンもできる)
		connection.emit('dahai', { house: 's', tile: shanponRonTile, riichi: false });
		await nextTick();

		assert.ok(isActionShown(container, 'ron'), 'ron button should stay visible');
		assert.ok(isActionShown(container, 'skip'), 'skip button should stay visible');
		assert.ok(!isActionShown(container, 'pon'), 'pon button should be hidden');
		assert.ok(!isActionShown(container, 'cii'), 'cii button should be hidden');
		assert.ok(!isActionShown(container, 'kan'), 'kan button should be hidden');

		// ロンできる機会を自動でパスしない
		await runAutoAction();
		assert.strictEqual(connection.send.mock.calls.length, 0, 'no automatic answer when ron is possible');
	});

	test('discards the drawn tile even when ankan and kakan are possible', async () => {
		vi.useFakeTimers();
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: 'e',
			drawnTile: kanTsumoTile,
			handTiles: { e: [...kanHand13, kanTsumoTile], s: zeros, w: zeros, n: zeros },
			huros: { e: [ponPin1Huro], s: [], w: [], n: [] },
		}));

		await enableAutoMode(container, 'notCall');
		await enableAutoMode(container, 'tsumogiri');

		assert.ok(!isActionShown(container, 'ankan'), 'ankan button should be hidden');
		assert.ok(!isActionShown(container, 'kakan'), 'kakan button should be hidden');

		await runAutoAction();

		assert.deepStrictEqual(sentActions(connection.send, 'dahai'), [['dahai', { tile: kanTsumoTile, riichi: false }]]);
		assert.strictEqual(sentActions(connection.send, 'ankan').length, 0);
	});

	test('waits for ankan when only auto tsumogiri is on', async () => {
		vi.useFakeTimers();
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: 'e',
			drawnTile: kanTsumoTile,
			handTiles: { e: [...kanHand13, kanTsumoTile], s: zeros, w: zeros, n: zeros },
		}));

		await enableAutoMode(container, 'tsumogiri');

		assert.ok(isActionShown(container, 'ankan'), 'ankan button should stay visible');

		await runAutoAction();

		assert.strictEqual(connection.send.mock.calls.length, 0, 'the player should decide the kan');
	});

	test('discards the drawn tile with auto tsumogiri when nothing else is possible', async () => {
		vi.useFakeTimers();
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: 'e',
			drawnTile: plainTsumoTile,
			handTiles: { e: [...plainHand13, plainTsumoTile], s: zeros, w: zeros, n: zeros },
		}));

		await enableAutoMode(container, 'tsumogiri');

		await runAutoAction();

		assert.deepStrictEqual(sentActions(connection.send, 'dahai'), [['dahai', { tile: plainTsumoTile, riichi: false }]]);
	});

	test('leaves the discard to the server while riichi', async () => {
		vi.useFakeTimers();
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: 'e',
			riichis: { e: true, s: false, w: false, n: false },
			drawnTile: kanTsumoTile,
			handTiles: { e: [...kanHand13, kanTsumoTile], s: zeros, w: zeros, n: zeros },
		}));

		await enableAutoMode(container, 'notCall');
		await enableAutoMode(container, 'tsumogiri');

		await runAutoAction();

		assert.strictEqual(connection.send.mock.calls.length, 0, 'the server discards for a riichi player');
	});

	test('keeps the winning tile when auto hora is off', async () => {
		vi.useFakeTimers();
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: 'e',
			drawnTile: horaTsumoTile,
			handTiles: { e: [...horaHand13, horaTsumoTile], s: zeros, w: zeros, n: zeros },
		}));

		await enableAutoMode(container, 'tsumogiri');
		await enableAutoMode(container, 'notCall');

		assert.ok(isActionShown(container, 'tsumo'), 'tsumo button should stay visible');

		await runAutoAction();

		assert.strictEqual(sentActions(connection.send, 'tsumoHora').length, 0);
		assert.strictEqual(sentActions(connection.send, 'dahai').length, 0, 'auto tsumogiri should not discard a winning tile');
	});
});

describe('room.game auto hora', () => {
	test('declares tsumo automatically', async () => {
		vi.useFakeTimers();
		// ツモ前 (手番なし) の状態から、ツモイベントで自家が和了牌を引く
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: null,
			handTiles: { e: horaHand13, s: zeros, w: zeros, n: zeros },
		}));

		await enableAutoMode(container, 'hora');

		connection.emit('tsumo', { house: 'e', tile: horaTsumoTile });
		await nextTick();
		assert.ok(isActionShown(container, 'tsumo'), 'the winning tile should offer tsumo');

		await runAutoAction();

		assert.deepStrictEqual(sentActions(connection.send, 'tsumoHora'), [['tsumoHora', {}]]);
		assert.strictEqual(sentActions(connection.send, 'dahai').length, 0);
	});

	test('declares ron automatically', async () => {
		vi.useFakeTimers();
		const { container, connection } = renderRoomGame(createPlayerState({
			turn: 's',
			handTiles: { e: shanponHand13, s: zeros, w: zeros, n: zeros },
		}));

		await enableAutoMode(container, 'hora');

		connection.emit('dahai', { house: 's', tile: shanponRonTile, riichi: false });
		await runAutoAction();

		assert.deepStrictEqual(sentActions(connection.send, 'ronHora'), [['ronHora', {}]]);
		assert.strictEqual(sentActions(connection.send, 'nop').length, 0);
	});
});
