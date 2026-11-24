/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, assert, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/vue';
import Room from '@/pages/mahjong/room.vue';

const mocks = vi.hoisted(() => ({
	$i: null as { id: string } | null,
	replaceByPath: vi.fn(),
	pushByPath: vi.fn(),
	misskeyApi: vi.fn(),
	alert: vi.fn(),
	useStream: vi.fn(),
}));

vi.mock('@/i.js', () => ({
	// 対局者 / 観戦の判定に使うので getter で可変にする
	get $i() { return mocks.$i; },
	ensureSignin: () => { throw new Error('page must not call ensureSignin'); },
}));

vi.mock('@/router.js', () => ({
	useRouter: () => ({ push: vi.fn(), pushByPath: mocks.pushByPath, replaceByPath: mocks.replaceByPath }),
}));

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: (...args: Parameters<typeof mocks.misskeyApi>) => mocks.misskeyApi(...args),
}));

vi.mock('@/os.js', () => ({
	alert: (...args: Parameters<typeof mocks.alert>) => mocks.alert(...args),
}));

vi.mock('@/stream.js', () => ({
	useStream: () => mocks.useStream(),
}));

vi.mock('@/page.js', () => ({
	definePage: vi.fn(),
	usePageScript: () => ({}),
}));

vi.mock('@@/js/use-interval.js', () => ({
	useInterval: () => ({ clear: vi.fn() }),
}));

vi.mock('@/utility/sound.js', () => ({
	playUrl: vi.fn(),
}));

vi.mock('@/pages/mahjong/room.setting.vue', () => ({
	default: { template: '<div data-testid="room-setting"/>' },
}));

vi.mock('@/pages/mahjong/room.game.vue', () => ({
	default: { template: '<div data-testid="room-game"/>' },
}));

function createConnection() {
	return {
		send: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		dispose: vi.fn(),
	};
}

function createRoom(userIds: string[]) {
	const user = (id: string) => ({ id, username: id, name: null });
	return {
		id: 'r1',
		isStarted: true,
		isEnded: false,
		isInviteOnly: false,
		invitations: [],
		user1Id: userIds[0],
		user2Id: userIds[1],
		user3Id: userIds[2],
		user4Id: userIds[3],
		user1: user(userIds[0]),
		user2: user(userIds[1]),
		user3: user(userIds[2]),
		user4: user(userIds[3]),
		timeLimitForEachTurn: 30,
		gameState: null,
		timer: null,
	};
}

function renderRoom() {
	mocks.useStream.mockReturnValue({ useChannel: () => createConnection() });
	return render(Room, { props: { roomId: 'r1' } });
}

describe('麻雀の対局画面 URL へのアクセス', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		mocks.$i = null;
	});

	test('未ログインなら対局中かどうかに関わらず観戦 URL へリダイレクトする', async () => {
		mocks.$i = null;
		renderRoom();

		await waitFor(() => assert.deepEqual(mocks.replaceByPath.mock.calls, [['/mahjong/g/r1/spectate']]));
		// 参加 API は叩かない
		assert.deepEqual(mocks.misskeyApi.mock.calls, []);
	});

	test('参加者ではないログインユーザーが対局中の URL を開くと観戦へリダイレクトする', async () => {
		mocks.$i = { id: 'u9' };
		mocks.misskeyApi.mockRejectedValue({ code: 'GAME_STARTED' });
		renderRoom();

		await waitFor(() => assert.deepEqual(mocks.replaceByPath.mock.calls, [['/mahjong/g/r1/spectate']]));
		// 警告なしでロビーへは戻さない
		assert.deepEqual(mocks.alert.mock.calls, []);
		assert.deepEqual(mocks.pushByPath.mock.calls, []);
	});

	test('参加者はそのまま対局画面に入れる', async () => {
		mocks.$i = { id: 'u1' };
		mocks.misskeyApi.mockResolvedValue(createRoom(['u1', 'u2', 'u3', 'u4']));
		const { findByTestId } = renderRoom();

		assert.ok(await findByTestId('room-game'));
		assert.deepEqual(mocks.replaceByPath.mock.calls, []);
		assert.deepEqual(mocks.pushByPath.mock.calls, []);
	});

	test('招待制で招待されていない場合は観戦へ流さず従来どおりロビーへ戻す', async () => {
		mocks.$i = { id: 'u9' };
		mocks.misskeyApi.mockRejectedValue({ code: 'NOT_INVITED' });
		renderRoom();

		await waitFor(() => assert.deepEqual(mocks.pushByPath.mock.calls, [['/mahjong']]));
		assert.deepEqual(mocks.replaceByPath.mock.calls, []);
	});
});
