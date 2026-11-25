/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, test, beforeAll } from 'vitest';
import type WebSocket from 'ws';
import type * as misskey from 'misskey-js';
import { api, signup, connectStream } from '../utils.js';

/** mahjongRoom チャンネルへ送信する (updateSettings など) */
function sendToChannel(ws: WebSocket, type: string, body: Record<string, unknown>): void {
	ws.send(JSON.stringify({
		type: 'channel',
		body: {
			id: 'a',
			type: type,
			body: body,
		},
	}));
}

async function createRoom(user: misskey.entities.SignupResponse): Promise<misskey.entities.MahjongRoomDetailed> {
	const res = await api('mahjong/create-room', {}, user);
	assert.strictEqual(res.status, 200);
	return res.body as misskey.entities.MahjongRoomDetailed;
}

async function listMahjongInvitations(user: misskey.entities.SignupResponse): Promise<{ id: string; roomId: string }[]> {
	const res = await api('i/notifications', { includeTypes: ['mahjongInvited'], limit: 100 }, user);
	assert.strictEqual(res.status, 200);
	return (res.body as misskey.entities.Notification[]).flatMap(notification =>
		notification.type === 'mahjongInvited' ? [{ id: notification.id, roomId: notification.roomId }] : [],
	);
}

async function invite(roomId: string, userId: string, user: misskey.entities.SignupResponse): Promise<{ status: number; body: any }> {
	return await api('mahjong/invite', { roomId, userId }, user);
}

async function cancelInvite(roomId: string, userId: string, user: misskey.entities.SignupResponse): Promise<{ status: number; body: any }> {
	return await api('mahjong/cancel-invite', { roomId, userId }, user);
}

async function joinRoom(roomId: string, user: misskey.entities.SignupResponse): Promise<{ status: number; body: any }> {
	return await api('mahjong/join-room', { roomId }, user);
}

describe('Mahjong invitations', () => {
	let owner: misskey.entities.SignupResponse;
	let member: misskey.entities.SignupResponse;
	let guest: misskey.entities.SignupResponse;
	let outsider: misskey.entities.SignupResponse;

	beforeAll(async () => {
		owner = await signup({ username: 'mj_owner' });
		member = await signup({ username: 'mj_member' });
		guest = await signup({ username: 'mj_guest' });
		outsider = await signup({ username: 'mj_outsider' });
	}, 1000 * 60 * 2);

	test('created rooms are public and have no invitations', async () => {
		const room = await createRoom(owner);

		assert.strictEqual(room.isInviteOnly, false);
		assert.deepStrictEqual(room.invitations, []);
	});

	test('invites a local user and notifies them', async () => {
		const room = await createRoom(owner);

		const invited = await invite(room.id, guest.id, owner);
		assert.strictEqual(invited.status, 200);
		assert.strictEqual(invited.body.invitations.length, 1);
		assert.strictEqual(invited.body.invitations[0].userId, guest.id);
		assert.strictEqual(invited.body.invitations[0].inviterId, owner.id);
		assert.strictEqual(invited.body.invitations[0].user.id, guest.id);

		// 二重招待は断る
		const duplicate = await invite(room.id, guest.id, owner);
		assert.strictEqual(duplicate.status, 400);
		assert.strictEqual(duplicate.body.error.code, 'ALREADY_INVITED');

		// 参加者なら誰でも招待できる
		await joinRoom(room.id, member);
		const invitedByMember = await invite(room.id, outsider.id, member);
		assert.strictEqual(invitedByMember.status, 200);

		// 招待された人は招待された参加者ではない
		const invitedToSelf = await invite(room.id, member.id, owner);
		assert.strictEqual(invitedToSelf.status, 400);
		assert.strictEqual(invitedToSelf.body.error.code, 'CANNOT_INVITE');

		// 参加者は招待の通知を受け取る
		const invitations = await listMahjongInvitations(guest);
		assert.ok(invitations.some(invitation => invitation.roomId === room.id));
	});

	test('refuses invitations sent by non-members, missing users and missing rooms', async () => {
		const room = await createRoom(owner);

		const byOutsider = await invite(room.id, guest.id, outsider);
		assert.strictEqual(byOutsider.status, 400);
		assert.strictEqual(byOutsider.body.error.code, 'NOT_MEMBER');

		const byMissingUser = await invite(room.id, 'aaaaaaaaaaaaaaaa', owner);
		assert.strictEqual(byMissingUser.status, 400);
		assert.strictEqual(byMissingUser.body.error.code, 'NO_SUCH_USER');

		const byMissingRoom = await invite('aaaaaaaaaaaaaaaa', guest.id, owner);
		assert.strictEqual(byMissingRoom.status, 400);
		assert.strictEqual(byMissingRoom.body.error.code, 'NO_SUCH_ROOM');
	});

	test('an invite-only room needs an invitation to join', async () => {
		const room = await createRoom(owner);
		const ws = await connectStream(owner, 'mahjongRoom', () => { }, { roomId: room.id });
		sendToChannel(ws, 'updateSettings', { key: 'isInviteOnly', value: true });
		// 設定の適用は非同期なので、反映を確認できるまで参加を試みる
		let invitedRoom: misskey.entities.MahjongRoomDetailed | null = null;
		for (let i = 0; i < 20; i++) {
			const res = await api('mahjong/show-room', { roomId: room.id }, owner);
			if (res.status === 200 && (res.body as misskey.entities.MahjongRoomDetailed).isInviteOnly) {
				invitedRoom = res.body as misskey.entities.MahjongRoomDetailed;
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		assert.notStrictEqual(invitedRoom, null);
		ws.close();

		const refused = await joinRoom(room.id, guest);
		assert.strictEqual(refused.status, 400);
		assert.strictEqual(refused.body.error.code, 'NOT_INVITED');

		const invited = await invite(room.id, guest.id, owner);
		assert.strictEqual(invited.status, 200);

		const joined = await joinRoom(room.id, guest);
		assert.strictEqual(joined.status, 200);
		assert.strictEqual(joined.body.user2Id, guest.id);
		// 参加が決まった招待は消費される
		assert.deepStrictEqual(joined.body.invitations, []);

		// 参加で招待は消えるため、取り消し対象は無く、通知も相手から消える
		const cancel = await cancelInvite(room.id, guest.id, owner);
		assert.strictEqual(cancel.status, 400);
		assert.strictEqual(cancel.body.error.code, 'NO_SUCH_INVITATION');

		const invitations = await listMahjongInvitations(guest);
		assert.ok(!invitations.some(invitation => invitation.roomId === room.id));
	});

	test('cancels an invitation and removes the notification', async () => {
		const room = await createRoom(owner);

		const invited = await invite(room.id, guest.id, owner);
		assert.strictEqual(invited.status, 200);

		const invitations = await listMahjongInvitations(guest);
		const notification = invitations.find(x => x.roomId === room.id);
		assert.notStrictEqual(notification, undefined);

		// 参加者でなければ取り消せない
		const byOutsider = await cancelInvite(room.id, guest.id, outsider);
		assert.strictEqual(byOutsider.status, 400);
		assert.strictEqual(byOutsider.body.error.code, 'NOT_MEMBER');

		// 部屋主は誰が送った招待でも取り消せる
		const canceled = await cancelInvite(room.id, guest.id, owner);
		assert.strictEqual(canceled.status, 200);
		assert.deepStrictEqual(canceled.body.invitations, []);

		// 招待の通知は相手から削除される
		const afterCancel = await listMahjongInvitations(guest);
		assert.ok(!afterCancel.some(invitation => invitation.roomId === room.id));

		const again = await cancelInvite(room.id, guest.id, owner);
		assert.strictEqual(again.status, 400);
		assert.strictEqual(again.body.error.code, 'NO_SUCH_INVITATION');
	});

	test('a kicked player cannot rejoin an invite-only room', async () => {
		const room = await createRoom(owner);
		const ws = await connectStream(owner, 'mahjongRoom', () => { }, { roomId: room.id });

		const invited = await invite(room.id, guest.id, owner);
		assert.strictEqual(invited.status, 200);

		// 参加者を確定させるため、先に招待制を有効にする
		sendToChannel(ws, 'updateSettings', { key: 'isInviteOnly', value: true });
		for (let i = 0; i < 20; i++) {
			const res = await api('mahjong/show-room', { roomId: room.id }, owner);
			if (res.status === 200 && (res.body as misskey.entities.MahjongRoomDetailed).isInviteOnly) break;
			await new Promise(resolve => setTimeout(resolve, 200));
		}

		const joined = await joinRoom(room.id, guest);
		assert.strictEqual(joined.status, 200);

		sendToChannel(ws, 'kick', { index: 2 });
		// 追放が反映されるまで待つ
		for (let i = 0; i < 20; i++) {
			const res = await api('mahjong/show-room', { roomId: room.id }, owner);
			if (res.status === 200 && (res.body as misskey.entities.MahjongRoomDetailed).user2Id == null) break;
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		ws.close();

		const rejoined = await joinRoom(room.id, guest);
		assert.strictEqual(rejoined.status, 400);
		assert.strictEqual(rejoined.body.error.code, 'NOT_INVITED');
	});
});

describe('Mahjong game history', () => {
	test('lists game records without credential', async () => {
		const res = await api('mahjong/games', {});
		assert.strictEqual(res.status, 200);
		assert.ok(Array.isArray(res.body));
	});

	test('my filter works for a signed-in user', async () => {
		const user = await signup({ username: 'mj_history_viewer' });
		const res = await api('mahjong/games', { my: true }, user);
		assert.strictEqual(res.status, 200);
		assert.ok(Array.isArray(res.body));
	});

	test('anonymous my filter yields an empty list', async () => {
		const res = await api('mahjong/games', { my: true });
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(res.body, []);
	});

	test('rejects invalid limit', async () => {
		const res = await api('mahjong/games', { limit: 0 });
		assert.strictEqual(res.status, 400);
	});
});
