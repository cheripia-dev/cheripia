/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert';
import { TileId } from '../src/common.js';
import { PlayerGameEngine, PlayerState, projectSpectatorState } from '../src/engine.player.js';

function createState(): PlayerState {
	return {
		user1House: 'e',
		user2House: 's',
		user3House: 'w',
		user4House: 'n',
		round: 'e',
		kyoku: 1,
		turnCount: 0,
		tilesCount: 69,
		doraIndicateTiles: [125], // 白表示 → ドラは發(手牌にない)
		drawnTile: null,
		handTiles: { e: [], s: [], w: [], n: [] },
		hoTiles: { e: [], s: [], w: [], n: [] },
		huros: { e: [], s: [], w: [], n: [] },
		firstTurnFlags: { e: false, s: false, w: false, n: false },
		riichis: { e: false, s: false, w: false, n: false },
		doubleRiichis: { e: false, s: false, w: false, n: false },
		ippatsus: { e: false, s: false, w: false, n: false },
		rinshanFlags: { e: false, s: false, w: false, n: false },
		points: { e: 25000, s: 25000, w: 25000, n: 25000 },
		honba: 0,
		kyotaku: 0,
		latestDahaiedTile: null,
		turn: null,
		canPon: null,
		canCii: null,
		canKan: null,
		canRon: null,
	};
}

describe('Player game engine scoring', () => {
	it('Child riichi tsumo with 2 han 40 fu = 700/400 (1500 total)', () => {
		const state = createState();
		state.riichis.s = true;

		const engine = new PlayerGameEngine(2, state);
		const handTiles: TileId[] = [
			1, 5, 9, // m1 m2 m3
			57, 58, 59, // p6 x3
			93, 97, 101, // s6 s7 s8
			121, 122, 123, // n x3
			10, 11, // m3 x2 (和了牌)
		];
		const result = engine.commit_tsumoHora('s', handTiles, 11);

		assert.deepStrictEqual(result.yakus.map(yaku => yaku.name).sort(), ['riichi', 'tsumo']);
		assert.strictEqual(result.doraCount, 0);
		assert.deepStrictEqual(result.pointDeltas, {
			e: -1300,
			s: 2700,
			w: -700,
			n: -700,
		});
	});

	it('Dealer riichi pinfu ron with 2 han 30 fu = 2900', () => {
		const state = createState();
		state.riichis.e = true;
		state.hoTiles.s = [69]; // p9

		const engine = new PlayerGameEngine(1, state);
		const handTiles = {
			e: [
				1, 5, 9, // m1 m2 m3
				45, 49, 53, // p3 p4 p5
				93, 97, 101, // s6 s7 s8
				61, 65, // p7 p8
				77, 78, // s2 x2
			],
			s: [],
			w: [],
			n: [],
		};
		const result = engine.commit_ronHora(['e'], 's', handTiles);

		assert.deepStrictEqual(result.e?.yakus.map(yaku => yaku.name).sort(), ['pinfu', 'riichi']);
		assert.strictEqual(result.e?.doraCount, 0);
		assert.deepStrictEqual(result.e?.pointDeltas, {
			e: 2900,
			s: -2900,
			w: 0,
			n: 0,
		});
	});
});

describe('Player game engine dora indicators', () => {
	it('updates dora indicators on daiminkan', () => {
		const state = createState();
		state.turn = 's';
		state.handTiles.s = [1, 2, 3];
		state.hoTiles.e = [57];

		const engine = new PlayerGameEngine(1, state);
		engine.commit_kan('s', 'e', [57, 58, 59, 60], 17, [125, 121]);

		assert.deepStrictEqual(engine.doraIndicateTiles, [125, 121]);
	});

	it('updates dora indicators on kakan', () => {
		const state = createState();
		state.turn = 's';
		state.handTiles.s = [1, 2, 3];
		state.huros.s = [{ type: 'pon', tiles: [57, 58, 59], from: 'e' }];

		const engine = new PlayerGameEngine(1, state);
		engine.commit_kakan('s', [57, 58, 59, 60], 17, [125, 121, 122]);

		assert.deepStrictEqual(engine.doraIndicateTiles, [125, 121, 122]);
	});

	it('updates dora indicators on ankan', () => {
		const state = createState();
		state.turn = 's';
		state.handTiles.s = [1, 2, 3, 4];

		const engine = new PlayerGameEngine(1, state);
		engine.commit_ankan('s', [1, 2, 3, 4], 17, [125, 121, 122, 123]);

		assert.deepStrictEqual(engine.doraIndicateTiles, [125, 121, 122, 123]);
	});
});

describe('Player game engine ryuukyoku', () => {
	it('applies point deltas and clears turn', () => {
		const state = createState();
		state.points = { e: 24000, s: 26000, w: 25000, n: 25000 };
		state.turn = 'e';

		const engine = new PlayerGameEngine(1, state);
		engine.commit_ryuukyoku({ e: 3000, s: -1000, w: -1000, n: -1000 });

		assert.deepStrictEqual(engine.points, { e: 27000, s: 25000, w: 24000, n: 24000 });
		assert.strictEqual(engine.turn, null);
		assert.strictEqual(engine.drawnTile, null);
	});
});

describe('Player game engine drawn tile', () => {
	it('tracks its own drawn tile and hides opponents\' tiles', () => {
		const state = createState();
		state.turn = 's';
		const engine = new PlayerGameEngine(1, state);

		engine.commit_tsumo('s', 17);
		assert.strictEqual(engine.drawnTile, null);

		engine.commit_tsumo('e', 18);
		assert.strictEqual(engine.drawnTile, 18);
	});

	it('clears the drawn tile on dahai, pon and cii', () => {
		const state = createState();
		state.turn = 'e';
		state.handTiles.e = [17, 18, 19];
		state.hoTiles.s = [21];
		const engine = new PlayerGameEngine(1, state);

		engine.commit_dahai('e', 17);
		assert.strictEqual(engine.drawnTile, null);

		state.turn = 'e';
		state.drawnTile = 17;
		state.hoTiles.s = [21];
		engine.commit_pon('e', 's', [21, 22, 23]);
		assert.strictEqual(engine.drawnTile, null);

		state.turn = 'e';
		state.drawnTile = 17;
		state.hoTiles.s = [21];
		engine.commit_cii('e', 's', [17, 21, 25]);
		assert.strictEqual(engine.drawnTile, null);
	});

	it('sets the rinshan tile on daiminkan, ankan and kakan', () => {
		const state = createState();
		state.turn = 'e';
		state.handTiles.e = [1, 2, 3, 4];
		state.huros.e = [{ type: 'pon', tiles: [17, 18, 19], from: 's' }];
		const engine = new PlayerGameEngine(1, state);

		state.hoTiles.s = [21];
		engine.commit_kan('e', 's', [21, 22, 23, 24], 32);
		assert.strictEqual(engine.drawnTile, 32);

		engine.commit_ankan('e', [1, 2, 3, 4], 33);
		assert.strictEqual(engine.drawnTile, 33);

		state.turn = 'e';
		state.handTiles.e.push(17);
		engine.commit_kakan('e', [17, 18, 19, 20], 34);
		assert.strictEqual(engine.drawnTile, 34);
	});

	it('hides an opponent\'s rinshan tile', () => {
		const state = createState();
		state.turn = 's';
		state.handTiles.s = [1, 2, 3, 4];
		const engine = new PlayerGameEngine(1, state);

		engine.commit_ankan('s', [1, 2, 3, 4], 33);
		assert.strictEqual(engine.drawnTile, null);

		state.turn = 's';
		state.hoTiles.e = [21];
		engine.commit_kan('s', 'e', [21, 22, 23, 24], 32);
		assert.strictEqual(engine.drawnTile, null);
	});

	it('clears the drawn tile after tsumo and ron hora', () => {
		const state = createState();
		state.turn = 's';
		state.riichis.s = true;
		state.drawnTile = 17;
		const engine = new PlayerGameEngine(2, state);

		engine.commit_tsumoHora('s', [
			1, 5, 9, // m1 m2 m3
			57, 58, 59, // p6 x3
			93, 97, 101, // s6 s7 s8
			121, 122, 123, // n x3
			10, 11, // m3 x2 (和了牌)
		], 11);
		assert.strictEqual(engine.drawnTile, null);

		state.hoTiles.s = [69];
		state.drawnTile = 18;
		engine.commit_ronHora(['e'], 's', {
			e: [
				1, 5, 9, // m1 m2 m3
				45, 49, 53, // p3 p4 p5
				93, 97, 101, // s6 s7 s8
				61, 65, // p7 p8
				77, 78, // s2 x2
			],
			s: [],
			w: [],
			n: [],
		});
		assert.strictEqual(engine.drawnTile, null);
	});

	it('takes the drawn tile from the server state on next kyoku', () => {
		const engine = new PlayerGameEngine(1, createState());
		const next = createState();
		next.drawnTile = 17;

		engine.commit_nextKyoku(next);
		assert.strictEqual(engine.drawnTile, 17);
	});
});

describe('Player game engine furiten', () => {
	function createRonState(): PlayerState {
		const state = createState();
		state.turn = 's';
		state.tilesCount = 69;
		// e は p9 待ち (ピンフ)
		state.handTiles.e = [1, 5, 9, 45, 49, 53, 93, 97, 101, 61, 65, 77, 78];
		state.handTiles.s = [70, 14, 18];
		state.handTiles.w = [71, 15, 19];
		state.handTiles.n = [72, 16, 20];
		return state;
	}

	it('does not show ron for own river tiles', () => {
		const state = createRonState();
		state.hoTiles.e = [69]; // 自河に p9 現物
		const engine = new PlayerGameEngine(1, state);
		engine.commit_dahai('s', 70);
		assert.strictEqual(engine.canRon, null);
	});

	it('tracks a missed ron until own tsumo', () => {
		const state = createRonState();
		const engine = new PlayerGameEngine(1, state);
		engine.commit_dahai('s', 70);
		assert.deepStrictEqual(engine.canRon, { callee: 's' });
		engine.commit_nop();

		state.turn = 'w';
		engine.commit_dahai('w', 71);
		assert.strictEqual(engine.canRon, null);

		engine.commit_tsumo('e', 33);
		engine.commit_dahai('e', 33); // ツモ切り
		state.turn = 'n';
		engine.commit_dahai('n', 72);
		assert.deepStrictEqual(engine.canRon, { callee: 'n' });
	});

	it('keeps riichi furiten until next kyoku', () => {
		const state = createRonState();
		state.riichis.e = true;
		const engine = new PlayerGameEngine(1, state);
		engine.commit_dahai('s', 70);
		assert.deepStrictEqual(engine.canRon, { callee: 's' });
		engine.commit_nop();

		engine.commit_tsumo('e', 33);
		engine.commit_dahai('e', 33);
		state.turn = 'w';
		engine.commit_dahai('w', 71);
		assert.strictEqual(engine.canRon, null);

		engine.commit_nextKyoku(createRonState());
		engine.commit_dahai('s', 70);
		assert.deepStrictEqual(engine.canRon, { callee: 's' });
	});
});

describe('Player game engine kakan', () => {
	it('detects kakan from a pon and returns the exact hand tile', () => {
		const state = createState();
		state.turn = 'e';
		state.huros.e = [{ type: 'pon', tiles: [17, 18, 19], from: 's' }];
		state.handTiles.e = [20, 1, 5, 9, 21, 25, 29, 33, 37, 41, 45];
		const engine = new PlayerGameEngine(1, state);

		assert.strictEqual(engine.canKakan(), true);
		assert.deepStrictEqual(engine.getKakanableTiles(), [20]);
	});

	it('does not allow kakan out of turn or without the fourth tile', () => {
		const state = createState();
		state.turn = 's';
		state.huros.e = [{ type: 'pon', tiles: [17, 18, 19], from: 's' }];
		state.handTiles.e = [20, 1, 5, 9, 21, 25, 29, 33, 37, 41, 45];
		const engine = new PlayerGameEngine(1, state);

		assert.strictEqual(engine.canKakan(), false);
		assert.deepStrictEqual(engine.getKakanableTiles(), [20]);

		state.turn = 'e';
		state.handTiles.e = [1, 5, 9, 21, 25, 29, 33, 37, 41, 45, 49];
		assert.strictEqual(engine.canKakan(), false);
		assert.deepStrictEqual(engine.getKakanableTiles(), []);
	});

	it('does not allow kakan during riichi', () => {
		const state = createState();
		state.turn = 'e';
		state.riichis.e = true;
		state.huros.e = [{ type: 'pon', tiles: [17, 18, 19], from: 's' }];
		state.handTiles.e = [20, 1, 5, 9, 21, 25, 29, 33, 37, 41, 45];
		const engine = new PlayerGameEngine(1, state);

		assert.strictEqual(engine.canKakan(), false);
	});

	it('removes the tile id that the server actually consumed', () => {
		const state = createState();
		state.turn = 'e';
		state.huros.e = [{ type: 'pon', tiles: [17, 18, 19], from: 's' }];
		// 同種牌が複数ある異常状態でも、イベントで通知された牌IDを優先して取り除く
		state.handTiles.e = [17, 20, 1, 5, 9, 21, 25, 29, 33, 37, 41];
		const engine = new PlayerGameEngine(1, state);

		engine.commit_kakan('e', [20, 17, 18, 19], 34);

		assert.deepStrictEqual(engine.myHandTiles, [17, 1, 5, 9, 21, 25, 29, 33, 37, 41, 34]);
		assert.strictEqual(engine.drawnTile, 34);
		assert.strictEqual(engine.huros.e[0].type, 'minkan');
	});
});

describe('Spectator state projection', () => {
	function createSpectatorStatePreset(preset: Partial<PlayerState> = {}): PlayerState {
		return {
			...createState(),
			spectator: true,
			handTiles: {
				e: [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49],
				s: [2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50],
				w: [3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47, 51],
				n: [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52],
			},
			askings: { ron: null, pon: null, cii: null, kan: null },
			...preset,
		};
	}

	it('全手牌公開の観戦状態から、選んだ視点以外の手牌を伏せる', () => {
		const view = projectSpectatorState(createSpectatorStatePreset(), 2);

		assert.deepStrictEqual(view.handTiles.s, [2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50]);
		for (const house of ['e', 'w', 'n'] as const) {
			assert.deepStrictEqual(view.handTiles[house], new Array(13).fill(0), `house ${house} must be hidden`);
		}
		assert.strictEqual(view.spectator, false);
	});

	it('視点以外の暗槓を伏せ、視点の暗槓は明らかな形 (両端+伏せ2枚) を保つ', () => {
		const state = createSpectatorStatePreset();
		state.huros.e = [{ type: 'ankan', tiles: [1, 2, 3, 4] }];
		state.huros.s = [{ type: 'ankan', tiles: [21, 22, 23, 24] }];

		const view = projectSpectatorState(state, 2);

		assert.deepStrictEqual(view.huros.e[0]!.tiles, [0, 0, 0, 0]);
		assert.deepStrictEqual(view.huros.s[0]!.tiles, [21, 22, 23, 24]);
	});

	it('ツモ牌は手番の視点にだけ見せる', () => {
		const state = createSpectatorStatePreset({ turn: 'e', drawnTile: 49 });

		assert.strictEqual(projectSpectatorState(state, 1).drawnTile, 49);
		assert.strictEqual(projectSpectatorState(state, 2).drawnTile, null);
	});

	it('askings から視点ごとの鳴き要求を再計算する', () => {
		const state = createSpectatorStatePreset({
			turn: null,
			askings: {
				ron: { callee: 'e', callers: ['w', 's'] },
				pon: { callee: 'e', callers: ['w', 's'] },
				cii: { callee: 'e', caller: 's' },
				kan: { callee: 'e', callers: ['w'] },
			},
		});

		// user2 = 席 s
		const viewS = projectSpectatorState(state, 2);
		assert.deepStrictEqual(viewS.canRon, { callee: 'e' });
		assert.deepStrictEqual(viewS.canPon, { callee: 'e' });
		assert.deepStrictEqual(viewS.canCii, { callee: 'e' });
		assert.strictEqual(viewS.canKan, null);

		// user3 = 席 w
		const viewW = projectSpectatorState(state, 3);
		assert.deepStrictEqual(viewW.canRon, { callee: 'e' });
		assert.deepStrictEqual(viewW.canPon, { callee: 'e' });
		assert.deepStrictEqual(viewW.canKan, { callee: 'e' });
		assert.strictEqual(viewW.canCii, null);

		// user1 = 席 e (捨てた本人)
		const viewE = projectSpectatorState(state, 1);
		assert.strictEqual(viewE.canRon, null);
		assert.strictEqual(viewE.canPon, null);
		assert.strictEqual(viewE.canCii, null);
		assert.strictEqual(viewE.canKan, null);
	});

	it('リーチ済みの視点は鳴けず、ロンは要求される', () => {
		const state = createSpectatorStatePreset({
			turn: null,
			riichis: { e: false, s: true, w: false, n: false },
			askings: {
				ron: { callee: 'e', callers: ['s'] },
				pon: { callee: 'e', callers: ['s'] },
				cii: { callee: 'e', caller: 's' },
				kan: { callee: 'e', callers: ['s'] },
			},
		});

		const view = projectSpectatorState(state, 2);
		assert.deepStrictEqual(view.canRon, { callee: 'e' });
		assert.strictEqual(view.canPon, null);
		assert.strictEqual(view.canCii, null);
		assert.strictEqual(view.canKan, null);
	});

	it('席が回転していても視点プレイヤーの席で射影する', () => {
		const state = createSpectatorStatePreset({
			user1House: 's',
			user2House: 'w',
			user3House: 'n',
			user4House: 'e',
		});

		const view = projectSpectatorState(state, 1);

		// user1 の席は s
		assert.deepStrictEqual(view.handTiles.s, state.handTiles.s);
		assert.deepStrictEqual(view.handTiles.e, new Array(13).fill(0));
	});

	it('元の観戦状態を書き換えず、PlayerGameEngine をそのまま通せる', () => {
		const state = createSpectatorStatePreset();

		const view = projectSpectatorState(state, 2);
		assert.deepStrictEqual(state.handTiles.e, [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49]);

		const engine = new PlayerGameEngine(2, view);
		assert.strictEqual(engine.myHouse, 's');
		assert.strictEqual(engine.myHandTiles.length, 13);
	});
});
