<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="room == null"><MkLoading/></div>
<RoomSetting v-else-if="!spectate && !room.isStarted && !room.isEnded" :room="room" :connection="connection!"/>
<RoomGame v-else :room="room" :connection="connection" :spectate="spectate === true" :initialViewUserNumber="initialViewUserNumber"/>
</template>

<script lang="ts" setup>
import { computed, watch, onMounted, shallowRef, onUnmounted } from 'vue';
import * as Misskey from 'misskey-js';
import { useInterval } from '@@/js/use-interval.js';
import RoomSetting from './room.setting.vue';
import RoomGame from './room.game.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { useStream } from '@/stream.js';
import { $i } from '@/i.js';
import { useRouter } from '@/router.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';

const router = useRouter();

const props = defineProps<{
	roomId: string;
	spectate?: boolean;
	// 観戦時に ?user= で指定されたプレイヤーの ID
	spectateUser?: string;
}>();

const room = shallowRef<Misskey.entities.MahjongRoomDetailed | null>(null);
const connection = shallowRef<Misskey.IChannelConnection<Misskey.Channels['mahjongRoom']> | null>(null);

// 観戦の初期視点。指定 ID が参加者にいなければ親 (東家の席のプレイヤー)
const initialViewUserNumber = computed<1 | 2 | 3 | 4 | undefined>(() => {
	if (props.spectate !== true || room.value == null) return undefined;
	if (props.spectateUser != null) {
		const index = [room.value.user1Id, room.value.user2Id, room.value.user3Id, room.value.user4Id].indexOf(props.spectateUser);
		if (index !== -1) return (index + 1) as 1 | 2 | 3 | 4;
	}
	const s = room.value.gameState as { user1House?: string; user2House?: string; user3House?: string; user4House?: string } | null;
	if (s != null) {
		if (s.user1House === 'e') return 1;
		if (s.user2House === 'e') return 2;
		if (s.user3House === 'e') return 3;
		if (s.user4House === 'e') return 4;
	}
	return 1;
});

watch(() => props.roomId, () => {
	fetchGame();
});

function start(_room: Misskey.entities.MahjongRoomDetailed) {
	room.value = _room;
}

async function leaveToLobby(text: string): Promise<void> {
	await os.alert({
		type: 'warning',
		text,
	});
	router.pushByPath('/mahjong');
}

function disposeConnection() {
	if (connection.value) {
		connection.value.dispose();
		connection.value = null;
	}
}

function isMember(_room: Misskey.entities.MahjongRoomDetailed): boolean {
	return $i != null && [_room.user1Id, _room.user2Id, _room.user3Id, _room.user4Id].includes($i.id);
}

/**
 * 対局画面の URL を観戦画面の URL へ置き換える。
 * 対局の開始前・終了後・ルーム消失は観戦側の処理が警告してロビーへ戻す。
 */
function redirectToSpectate(): void {
	router.replaceByPath(`/mahjong/g/${props.roomId}/spectate`);
}

/**
 * 観戦としてルームを取得する。
 * 対局者本人が観戦 URL を開いた場合は通常の対局画面へ移す。
 */
async function fetchForSpectate() {
	let _room: Misskey.entities.MahjongRoomDetailed;
	try {
		_room = await misskeyApi('mahjong/show-room', {
			roomId: props.roomId,
		});
	} catch (err) {
		console.error(err);
		await leaveToLobby(i18n.ts._mahjong.spectateRoomNotFound);
		return;
	}

	if (isMember(_room)) {
		// 対局者本人は通常の対局画面へ
		router.pushByPath(`/mahjong/g/${_room.id}`);
		return;
	}
	if (_room.isEnded) {
		await leaveToLobby(i18n.ts._mahjong.spectateEnded);
		return;
	}
	if (!_room.isStarted) {
		await leaveToLobby(i18n.ts._mahjong.spectateNotStarted);
		return;
	}

	room.value = _room;
	connect();
}

function connect() {
	disposeConnection();
	connection.value = useStream().useChannel('mahjongRoom', {
		roomId: props.roomId,
	});
	connection.value.on('started', x => {
		start(x.room);
	});
	connection.value.on('canceled', x => {
		disposeConnection();

		if ($i == null || x.userId !== $i.id) {
			void leaveToLobby(i18n.ts._mahjong.roomCanceled);
		}
	});
	connection.value.on('kicked', x => {
		// 観戦者はどこの席からも追放されない。追放されたのは対局者なので無視する。
		if (props.spectate === true || $i == null || x.userId !== $i.id) return;

		disposeConnection();

		void leaveToLobby(i18n.ts._mahjong.kicked);
	});
}

async function fetchGame() {
	if (props.spectate === true) {
		await fetchForSpectate();
		return;
	}

	// 未ログインは対局に参加できないので、固定で観戦へ流す
	if ($i == null) {
		redirectToSpectate();
		return;
	}

	try {
		const _room = await misskeyApi('mahjong/join-room', {
			roomId: props.roomId,
		});

		room.value = _room;
	} catch (err) {
		console.error(err);
		const apiError = err as { code?: string };
		if (apiError.code === 'NOT_INVITED') {
			await os.alert({
				type: 'warning',
				text: i18n.ts._mahjong.notInvited,
			});
			router.pushByPath('/mahjong');
			return;
		}
		// 対局が開始されている場合は観戦へ流す (終了済みは観戦側が警告してロビーへ戻す)
		if (apiError.code === 'GAME_STARTED') {
			redirectToSpectate();
			return;
		}
		await os.alert({
			type: 'warning',
			text: 'ルームに参加できませんでした。対局が開始されているか、ルームが存在しない可能性があります。',
		});
		router.pushByPath('/mahjong');
		return;
	}

	disposeConnection();
	if (!room.value.isEnded) {
		connect();
	}
}

// 通信を取りこぼした場合の救済
useInterval(async () => {
	if (room.value == null) return;
	if (room.value.isStarted) return;

	let _room: Misskey.entities.MahjongRoomDetailed;
	try {
		_room = await misskeyApi('mahjong/show-room', {
			roomId: props.roomId,
		});
	} catch (err) {
		// ルームが消えた、席から外されたなどの場合は canceled / kicked での離脱に委ね、次tickで再試行する
		console.error(err);
		return;
	}

	if (_room.isStarted || _room.isEnded) {
		start(_room);
	} else {
		room.value = _room;
	}
}, 1000 * 5, {
	immediate: false,
	afterMounted: true,
});

onMounted(() => {
	fetchGame();
});

onUnmounted(() => {
	if (connection.value) {
		connection.value.dispose();
	}
});

definePage(computed(() => ({
	title: props.spectate === true ? i18n.ts._mahjong.spectating : i18n.ts._mahjong.mahjong,
	icon: props.spectate === true ? 'ti ti-eye' : 'ti ti-device-gamepad',
})));
</script>
